import {
    Position,
    Range,
} from 'vscode-languageserver-types';
import { TextDocument } from 'vscode-languageserver-textdocument';
import {
    Export,
    ExportKind,
    ImportKind,
    Macro,
    MacroKind,
    parseSegmentDirectiveArgs,
    ReferenceInfo,
    Scope,
    ScopeKind,
    Symbol,
    SymbolKind,
    SymbolTable,
    SymbolTableEntity,
} from './symbolTable';
import { getAnonLabelRefOffsetFromPreviousLabel } from './anonymousLabelUtils';
import { getDocumentSettings, performanceMonitor } from './server';
import { resolveIncludeUri } from './pathUtils';
import { getMnemonicInfo } from './dataManager';
import { Ca65Settings } from './settings';

type LineItem = {
    text: string;
    index: number;
};

type ParsedLine = {
    label?: LineItem;
    command?: LineItem;
    args?: LineItem; // the raw text + index for "everything to the right of the command"
    comment?: LineItem;
};

interface ParsedQualifiedName extends LineItem {
    context: ReferenceInfo['context'];
}

export interface ParsedImportExportArgs {
    identifier?: LineItem;
    addressSpecification?: LineItem;
    assignmentOp?: LineItem; // = or :=
    value?: LineItem;
}

const OPEN_SCOPE_KINDS: Record<string, ScopeKind> = {
    '.proc': ScopeKind.Proc,
    '.scope': ScopeKind.Scope,
    '.struct': ScopeKind.Struct,
    '.union': ScopeKind.Union,
    '.enum': ScopeKind.Enum,
};

const CLOSE_SCOPE_KINDS: Record<string, ScopeKind> = {
    '.endproc': ScopeKind.Proc,
    '.endscope': ScopeKind.Scope,
    '.endstruct': ScopeKind.Struct,
    '.endunion': ScopeKind.Union,
    '.endenum': ScopeKind.Enum,
};

const SEGMENT_DIRECTIVES = new Set([
    '.segment',
    '.code',
    '.data',
    '.bss',
    '.zeropage',
    '.rodata',
]);

const IMPORT_EXPORT_DIRECTIVES = new Set([
    '.import',
    '.importzp',
    '.export',
    '.exportzp',
    '.global',
    '.globalzp',
]);

const DATA_LABEL_DIRECTIVES = new Set([
    '.addr',
    '.bankbytes',
    '.dbyt',
    '.dword',
    '.faraddr',
    '.hibytes',
    '.incbin',
    '.lobytes',
    '.word',
]);

const STRING_LABEL_DIRECTIVES = new Set(['.asciiz', '.literal']);
const LABEL_KIND_TRANSPARENT_DIRECTIVES = new Set([
    '.a16',
    '.a8',
    '.align',
    '.assert',
    '.charmap',
    '.else',
    '.elseif',
    '.endif',
    '.endrepeat',
    '.error',
    '.fatal',
    '.i16',
    '.i8',
    '.if',
    '.ifblank',
    '.ifconst',
    '.ifdef',
    '.ifnblank',
    '.ifndef',
    '.ifnref',
    '.ifref',
    '.out',
    '.p02',
    '.p4510',
    '.p816',
    '.pc02',
    '.psc02',
    '.repeat',
    '.smart',
    '.warning',
]);
const STRING_BYTE_LIST_RE = /^"(?:[^"\\]|\\.)*"(?:\s*,\s*(?:"(?:[^"\\]|\\.)*"|\$0*(?:0|[AaDd])|0|10|13))*$/;

const CONSTANT_ASSIGNMENT_RE = /^\s*(?<name>[a-zA-Z_@.][a-zA-Z0-9_]*)\s*(?:=|:=)/;
const VARIABLE_ASSIGNMENT_RE = /^\s*(?<name>[a-zA-Z_@.][a-zA-Z0-9_]*)\s*\.set\s*/;
const ANON_REF_RE = /:([-+<>]+)/g;
const EMPTY_QUALIFIERS: readonly string[] = Object.freeze([]);

interface LogicalLineSegment {
    line: number;
    code: string;
    joinedStart: number;
    joinedEnd: number;
}

function mapOffsetToPosition(
    segments: readonly LogicalLineSegment[],
    offset: number,
    isEnd: boolean
): Position {
    if (segments.length === 1) {
        return Position.create(segments[0].line, Math.max(0, offset - segments[0].joinedStart));
    }
    for (let i = 0; i < segments.length; i++) {
        const seg = segments[i];
        if (isEnd ? offset <= seg.joinedEnd : offset < seg.joinedEnd) {
            return Position.create(seg.line, Math.max(0, offset - seg.joinedStart));
        }
        if (i + 1 < segments.length && offset < segments[i + 1].joinedStart) {
            return isEnd
                ? Position.create(seg.line, seg.joinedEnd - seg.joinedStart)
                : Position.create(segments[i + 1].line, 0);
        }
    }
    const last = segments[segments.length - 1];
    return Position.create(last.line, last.joinedEnd - last.joinedStart);
}

function mapSpanToRange(
    segments: readonly LogicalLineSegment[],
    start: number,
    end: number
): Range {
    if (segments.length === 1) {
        const line = segments[0].line;
        const base = segments[0].joinedStart;
        return Range.create(line, start - base, line, end - base);
    }
    const startPos = mapOffsetToPosition(segments, start, false);
    const endPos = mapOffsetToPosition(segments, end, true);
    return Range.create(startPos.line, startPos.character, endPos.line, endPos.character);
}

export function maskQuotedLiterals(text: string): string {
    if (text.indexOf('"') === -1 && text.indexOf("'") === -1) {
        return text;
    }
    const len = text.length;
    let out = '';
    let copyStart = 0;
    let quote = 0;
    for (let i = 0; i < len; i++) {
        const code = text.charCodeAt(i);
        if (quote !== 0) {
            if (code === quote) {
                out += ' '.repeat(i - copyStart + 1);
                quote = 0;
                copyStart = i + 1;
            }
        } else if (code === 34 /* " */ || code === 39 /* ' */) {
            if (i > copyStart) out += text.slice(copyStart, i);
            copyStart = i;
            quote = code;
        }
    }
    if (quote !== 0) {
        out += ' '.repeat(len - copyStart);
    } else if (copyStart < len) {
        out += text.slice(copyStart);
    }
    return out;
}

function isWhitespaceCode(code: number): boolean {
    if (code === 32 || code === 9) return true;
    if (code < 10 || (code > 13 && code < 0xa0)) return false;
    return code <= 13 || code === 0xa0 || code === 0xfeff || /\s/.test(String.fromCharCode(code));
}

function skipWhitespace(text: string, pos: number, end: number): number {
    while (pos < end && isWhitespaceCode(text.charCodeAt(pos))) {
        pos++;
    }
    return pos;
}

function trimEndIndex(text: string, start: number, end: number): number {
    while (end > start && isWhitespaceCode(text.charCodeAt(end - 1))) {
        end--;
    }
    return end;
}

function findNextWhitespace(text: string, pos: number, end: number): number {
    while (pos < end && !isWhitespaceCode(text.charCodeAt(pos))) {
        pos++;
    }
    return pos;
}

function firstWord(text: string): string {
    const end = text.length;
    const start = skipWhitespace(text, 0, end);
    if (start >= end) return '';
    return text.slice(start, findNextWhitespace(text, start, end));
}

function isIdentStartCode(code: number): boolean {
    return (code >= 65 && code <= 90)
        || (code >= 97 && code <= 122)
        || code === 95
        || code === 64;
}

function isIdentContinueCode(code: number): boolean {
    return (code >= 65 && code <= 90)
        || (code >= 97 && code <= 122)
        || (code >= 48 && code <= 57)
        || code === 95;
}

function isHexDigitCode(code: number): boolean {
    return (code >= 48 && code <= 57)
        || (code >= 65 && code <= 70)
        || (code >= 97 && code <= 102);
}

function scanIdentEnd(text: string, start: number, end: number): number {
    let pos = start + 1;
    while (pos < end && isIdentContinueCode(text.charCodeAt(pos))) {
        pos++;
    }
    return pos;
}

function findCommentStartInRange(line: string, start: number, end: number): number {
    let quote = 0;
    for (let i = start; i < end; i++) {
        const code = line.charCodeAt(i);
        if (quote !== 0) {
            if (code === quote) {
                quote = 0;
            }
        } else if (code === 34 /* " */ || code === 39 /* ' */) {
            quote = code;
        } else if (code === 59 /* ; */) {
            return i;
        }
    }
    return -1;
}

/**
 * Returns the index of the first `;` comment delimiter outside of quotes, or -1 if none.
 */
export function findCommentStart(line: string): number {
    return findCommentStartInRange(line, 0, line.length);
}

export interface StrippedLine {
    /** Line text with closed `/* ... *\/` replaced by spaces (preserving column offsets) and `;` / unclosed `/*` truncated. */
    code: string;
    /** Whether a `/*` block comment remains unclosed at the end of this line. */
    inBlockComment: boolean;
    /** Whether a `;` comment appeared outside quotes/block comments on this line. */
    hasSemicolonComment: boolean;
}

export interface CursorCommentContext {
    /** True if the cursor lies inside a `;` or `/* ... *\/` comment. */
    inComment: boolean;
    /** True if the cursor lies inside a `/* ... *\/` block comment (rather than a `;` line comment). */
    inBlockComment?: boolean;
    /** True if the cursor lies inside a single- or double-quoted string literal (and not a comment). */
    inString: boolean;
    /** Raw text on the cursor's line from column 0 up to the cursor. */
    rawLineToCursor: string;
    /** Joined logical code across any preceding `\` or multi-line `/* ... *\/` continuations up to the cursor. */
    logicalCodeToCursor: string;
}

function scanLineComments(
    line: string,
    startInBlockComment: boolean,
    buildMaskedCode: boolean,
    cComments: boolean = true
): StrippedLine {
    const len = line.length;
    if (!cComments || (!startInBlockComment && line.indexOf('/*') === -1)) {
        if (!buildMaskedCode) {
            return { code: '', inBlockComment: false, hasSemicolonComment: false };
        }
        const semiIdx = findCommentStartInRange(line, 0, len);
        return {
            code: semiIdx >= 0 ? line.slice(0, semiIdx) : line,
            inBlockComment: false,
            hasSemicolonComment: semiIdx >= 0,
        };
    }

    let inBlock = startInBlockComment;
    let quote = 0;
    let copyStart = 0;
    let chunks: string[] | undefined;

    for (let i = 0; i < len;) {
        if (inBlock) {
            const closeIdx = line.indexOf('*/', i);
            if (closeIdx === -1) {
                if (!buildMaskedCode || !chunks) {
                    return { code: '', inBlockComment: true, hasSemicolonComment: false };
                }
                return { code: chunks.join(''), inBlockComment: true, hasSemicolonComment: false };
            }
            if (buildMaskedCode) {
                (chunks ??= []).push(' '.repeat(closeIdx + 2 - copyStart));
            }
            inBlock = false;
            i = closeIdx + 2;
            copyStart = i;
            continue;
        }

        const c = line.charCodeAt(i);
        if (quote !== 0) {
            if (c === quote) {
                quote = 0;
            }
            i++;
            continue;
        }

        if (c === 34 /* " */ || c === 39 /* ' */) {
            quote = c;
            i++;
            continue;
        }

        if (c === 59 /* ; */) {
            if (!buildMaskedCode) {
                return { code: '', inBlockComment: false, hasSemicolonComment: true };
            }
            if (!chunks) {
                return { code: line.slice(0, i), inBlockComment: false, hasSemicolonComment: true };
            }
            if (i > copyStart) {
                chunks.push(line.slice(copyStart, i));
            }
            return { code: chunks.join(''), inBlockComment: false, hasSemicolonComment: true };
        }

        if (c === 47 /* / */ && i + 1 < len && line.charCodeAt(i + 1) === 42 /* * */) {
            if (buildMaskedCode) {
                chunks ??= [];
                if (i > copyStart) {
                    chunks.push(line.slice(copyStart, i));
                }
            }
            copyStart = i;
            inBlock = true;
            i += 2;
            continue;
        }

        i++;
    }

    if (inBlock) {
        return {
            code: buildMaskedCode && chunks ? chunks.join('') : '',
            inBlockComment: true,
            hasSemicolonComment: false,
        };
    }

    if (!buildMaskedCode) {
        return { code: '', inBlockComment: false, hasSemicolonComment: false };
    }
    if (!chunks) {
        return { code: line, inBlockComment: false, hasSemicolonComment: false };
    }
    if (copyStart < len) {
        chunks.push(line.slice(copyStart));
    }
    return { code: chunks.join(''), inBlockComment: false, hasSemicolonComment: false };
}

/**
 * Strips `;` comments and masks closed `/* ... *\/` block comments with spaces so column offsets stay intact.
 */
export function stripCommentsInLine(
    line: string,
    startInBlockComment: boolean = false,
    cComments: boolean = true
): StrippedLine {
    return scanLineComments(line, startInBlockComment, true, cComments);
}

/**
 * Computes whether `targetLine` starts inside an unclosed `/* ... *\/` block comment.
 */
export function isInBlockCommentBeforeLine(
    document: TextDocument,
    targetLine: number,
    docText?: string,
    cComments: boolean = true
): boolean {
    if (!cComments || targetLine <= 0) return false;
    const text = docText ?? document.getText();
    if (text.indexOf('/*') === -1) return false;

    const len = text.length;
    let line = 0;
    let lineStart = 0;
    let inBlock = false;

    while (line < targetLine && lineStart <= len) {
        const nlIdx = text.indexOf('\n', lineStart);
        let lineEnd = nlIdx >= 0 ? nlIdx : len;
        if (lineEnd > lineStart && text.charCodeAt(lineEnd - 1) === 13 /* \r */) {
            lineEnd--;
        }

        const raw = text.slice(lineStart, lineEnd);
        if (inBlock ? raw.indexOf('*/') !== -1 : raw.indexOf('/*') !== -1) {
            inBlock = scanLineComments(raw, inBlock, false, true).inBlockComment;
        }

        if (nlIdx < 0) break;
        lineStart = nlIdx + 1;
        line++;
    }

    return inBlock;
}

/**
 * Returns `line` in `document` with `;` and `/* ... *\/` comments stripped/masked (preserving columns).
 */
export function maskCommentsAtDocumentLine(
    document: TextDocument,
    line: number,
    docText?: string,
    cComments: boolean = true
): string {
    if (line < 0 || line >= document.lineCount) return '';
    const text = docText ?? document.getText();
    const startOffset = line === 0 ? 0 : document.offsetAt({ line, character: 0 });
    const nlIdx = text.indexOf('\n', startOffset);
    let endOffset = nlIdx >= 0 ? nlIdx : text.length;
    if (endOffset > startOffset && text.charCodeAt(endOffset - 1) === 13 /* \r */) {
        endOffset--;
    }
    const rawLine = text.slice(startOffset, endOffset);
    const inBlock = isInBlockCommentBeforeLine(document, line, text, cComments);
    return stripCommentsInLine(rawLine, inBlock, cComments).code;
}

/**
 * Checks whether a stripped line continues onto the next line via trailing `\` or an unclosed block comment.
 */
export function doesStrippedLineContinue(stripped: StrippedLine, lineContinuations: boolean = true): boolean {
    if (stripped.inBlockComment) return true;
    if (!lineContinuations || stripped.hasSemicolonComment) return false;
    const trimmedEnd = trimEndIndex(stripped.code, 0, stripped.code.length);
    return trimmedEnd > 0 && stripped.code.charCodeAt(trimmedEnd - 1) === 92 /* \ */;
}

/**
 * Inspects comment/string state at `position` and returns the comment-stripped logical line up to the cursor.
 */
export function getCursorCommentContext(
    document: TextDocument,
    position: Position,
    options?: { cComments?: boolean; lineContinuations?: boolean }
): CursorCommentContext {
    const cComments = options?.cComments ?? true;
    const lineContinuations = options?.lineContinuations ?? true;
    const text = document.getText();
    const len = text.length;
    const hasBlockMarkers = cComments && text.indexOf('/*') !== -1;

    let stmtStartLine = 0;
    let inBlock = false;
    let line = 0;
    let lineStart = 0;

    if (position.line > 0 && (hasBlockMarkers || lineContinuations)) {
        // Track only stmtStartLine without allocating joined strings for prior finished lines.
        const maxBackLine = position.line;
        while (line < maxBackLine && lineStart <= len) {
            const nlIdx = text.indexOf('\n', lineStart);
            let lineEnd = nlIdx >= 0 ? nlIdx : len;
            if (lineEnd > lineStart && text.charCodeAt(lineEnd - 1) === 13 /* \r */) {
                lineEnd--;
            }

            let continues = false;
            const mightContBackslash = lineContinuations && lineEnd > lineStart && text.charCodeAt(trimEndIndex(text, lineStart, lineEnd) - 1) === 92 /* \ */;
            const needsScan = hasBlockMarkers
                ? (inBlock || mightContBackslash || text.slice(lineStart, lineEnd).indexOf('/*') !== -1)
                : mightContBackslash;

            if (needsScan) {
                const raw = text.slice(lineStart, lineEnd);
                const stripped = stripCommentsInLine(raw, inBlock, cComments);
                inBlock = stripped.inBlockComment;
                continues = doesStrippedLineContinue(stripped, lineContinuations);
            } else {
                inBlock = false;
                continues = false;
            }

            if (!continues) {
                stmtStartLine = line + 1;
            }

            if (nlIdx < 0) break;
            lineStart = nlIdx + 1;
            line++;
        }
    } else if (position.line > 0) {
        stmtStartLine = position.line;
    }

    // Collect and mask lines from stmtStartLine .. position.line - 1
    const logicalParts: string[] = [];
    if (stmtStartLine < position.line) {
        let curBlock = false; // stmtStartLine always begins outside an unclosed block comment
        let scanLine = stmtStartLine;
        let scanOffset = stmtStartLine === 0 ? 0 : document.offsetAt({ line: stmtStartLine, character: 0 });
        while (scanLine < position.line && scanOffset <= len) {
            const nlIdx = text.indexOf('\n', scanOffset);
            let scanEnd = nlIdx >= 0 ? nlIdx : len;
            if (scanEnd > scanOffset && text.charCodeAt(scanEnd - 1) === 13 /* \r */) {
                scanEnd--;
            }
            const raw = text.slice(scanOffset, scanEnd);
            const stripped = stripCommentsInLine(raw, curBlock, cComments);
            curBlock = stripped.inBlockComment;
            const trimmedEnd = trimEndIndex(stripped.code, 0, stripped.code.length);
            const hasBackslash = lineContinuations && !stripped.hasSemicolonComment && !curBlock && trimmedEnd > 0 && stripped.code.charCodeAt(trimmedEnd - 1) === 92;
            const piece = hasBackslash ? stripped.code.slice(0, trimmedEnd - 1) : stripped.code.slice(0, trimmedEnd);
            if (piece.length > 0) {
                logicalParts.push(piece);
            }
            if (nlIdx < 0) break;
            scanOffset = nlIdx + 1;
            scanLine++;
        }
        inBlock = curBlock;
    }

    const curLineStart = position.line <= 0 ? 0 : document.offsetAt({ line: position.line, character: 0 });
    const curNl = text.indexOf('\n', curLineStart);
    let curLineEnd = curNl >= 0 ? curNl : len;
    if (curLineEnd > curLineStart && text.charCodeAt(curLineEnd - 1) === 13 /* \r */) {
        curLineEnd--;
    }
    const cursorEnd = Math.min(curLineEnd, curLineStart + Math.max(0, position.character));
    const rawLineToCursor = text.slice(curLineStart, cursorEnd);

    // Mask and inspect before-cursor slice character-by-character starting from `inBlock`
    let quote = 0;
    let copyStart = 0;
    const chunks: string[] = [];
    for (let i = 0; i < rawLineToCursor.length;) {
        if (inBlock) {
            const closeIdx = rawLineToCursor.indexOf('*/', i);
            if (closeIdx === -1) {
                return {
                    inComment: true,
                    inBlockComment: true,
                    inString: false,
                    rawLineToCursor,
                    logicalCodeToCursor: logicalParts.join(' '),
                };
            }
            chunks.push(' '.repeat(closeIdx + 2 - copyStart));
            inBlock = false;
            i = closeIdx + 2;
            copyStart = i;
            continue;
        }
        const ch = rawLineToCursor.charCodeAt(i);
        if (quote !== 0) {
            if (ch === quote) quote = 0;
            i++;
            continue;
        }
        if (ch === 34 /* " */ || ch === 39 /* ' */) {
            quote = ch;
            i++;
            continue;
        }
        if (ch === 59 /* ; */) {
            if (i > copyStart) chunks.push(rawLineToCursor.slice(copyStart, i));
            return {
                inComment: true,
                inString: false,
                rawLineToCursor,
                logicalCodeToCursor: logicalParts.length > 0 ? `${logicalParts.join(' ')} ${chunks.join('')}` : chunks.join(''),
            };
        }
        if (cComments && ch === 47 /* / */ && i + 1 < rawLineToCursor.length && rawLineToCursor.charCodeAt(i + 1) === 42 /* * */) {
            if (i > copyStart) chunks.push(rawLineToCursor.slice(copyStart, i));
            copyStart = i;
            inBlock = true;
            i += 2;
            continue;
        }
        i++;
    }

    if (inBlock) {
        return {
            inComment: true,
            inBlockComment: true,
            inString: false,
            rawLineToCursor,
            logicalCodeToCursor: logicalParts.join(' '),
        };
    }

    if (copyStart < rawLineToCursor.length) {
        chunks.push(rawLineToCursor.slice(copyStart));
    }
    const maskedCurrent = chunks.join('');
    logicalParts.push(maskedCurrent);

    return {
        inComment: false,
        inString: quote !== 0,
        rawLineToCursor,
        logicalCodeToCursor: logicalParts.join(' '),
    };
}

function parseLineCore(line: string, codeEnd: number, comment?: LineItem): ParsedLine {
    let label: LineItem | undefined;
    let pos = skipWhitespace(line, 0, codeEnd);

    // Get the label to the left of the colon, if any.
    const colonIndex = line.indexOf(':', pos);
    if (colonIndex >= 0 && colonIndex < codeEnd) {
        const nextCode = colonIndex + 1 < codeEnd ? line.charCodeAt(colonIndex + 1) : 0;
        // Skip ::, :<, :>, :+, :- (qualified names and anonymous label references)
        if (nextCode !== 58 && nextCode !== 60 && nextCode !== 62 && nextCode !== 43 && nextCode !== 45) {
            const labelEnd = trimEndIndex(line, pos, colonIndex);
            if (findNextWhitespace(line, pos, labelEnd) === labelEnd) {
                label = {
                    text: labelEnd === pos ? '' : line.slice(pos, labelEnd),
                    index: pos,
                };
                pos = skipWhitespace(line, colonIndex + 1, codeEnd);
            }
        }
    }

    // Get the command and args
    let command: LineItem | undefined;
    let args: LineItem | undefined;
    if (pos < codeEnd) {
        const cmdEnd = findNextWhitespace(line, pos, codeEnd);
        command = { text: line.slice(pos, cmdEnd), index: pos };
        pos = skipWhitespace(line, cmdEnd, codeEnd);
        if (pos < codeEnd) {
            const argsEnd = trimEndIndex(line, pos, codeEnd);
            args = { text: line.slice(pos, argsEnd), index: pos };
        }
    }

    return { label, command, args, comment };
}

function parseCodeLine(text: string): ParsedLine {
    return parseLineCore(text, text.length);
}

/**
 * Splits a single line of ca65 source into label, command, args, and comment tokens with offsets.
 */
export function parseLine(line: string): ParsedLine {
    const semicolonIndex = findCommentStartInRange(line, 0, line.length);
    if (semicolonIndex >= 0) {
        const comment: LineItem = { text: line.slice(semicolonIndex), index: semicolonIndex };
        return parseLineCore(line, semicolonIndex, comment);
    }
    return parseLineCore(line, line.length);
}

function findClosingParenOutsideQuotes(text: string, start: number, end: number): number {
    let i = start;
    while (i < end) {
        const code = text.charCodeAt(i);
        if (code === 34 /* " */) {
            const close = text.indexOf('"', i + 1);
            i = (close >= 0 && close < end) ? close + 1 : i + 1;
        } else if (code === 39 /* ' */) {
            const close = text.indexOf("'", i + 1);
            i = (close >= 0 && close < end) ? close + 1 : i + 1;
        } else if (code === 41 /* ) */) {
            return i;
        } else {
            i++;
        }
    }
    return -1;
}

function scanQualifiedRange(
    text: string,
    start: number,
    end: number,
    baseOffset: number,
    context: ReferenceInfo['context'],
    allowSizeof: boolean,
    onGroup: (group: ParsedQualifiedName[]) => void,
    onSizeofRange?: (innerStart: number, innerEnd: number) => void
): void {
    let currentGroup: ParsedQualifiedName[] | null = null;
    let i = start;

    const flushGroup = () => {
        if (currentGroup) {
            onGroup(currentGroup);
            currentGroup = null;
        }
    };

    while (i < end) {
        const code = text.charCodeAt(i);
        if (isWhitespaceCode(code)) {
            i++;
            continue;
        }

        // Ignore identifiers inside closed string or character literals
        if (code === 34 /* " */ || code === 39 /* ' */) {
            flushGroup();
            const closeQuote = text.indexOf(code === 34 ? '"' : "'", i + 1);
            i = (closeQuote >= 0 && closeQuote < end) ? closeQuote + 1 : i + 1;
            continue;
        }

        // Ignore $hex literals without breaking surrounding whitespace state
        if (code === 36 /* $ */) {
            let hexEnd = i + 1;
            while (hexEnd < end && isHexDigitCode(text.charCodeAt(hexEnd))) {
                hexEnd++;
            }
            if (hexEnd > i + 1) {
                i = hexEnd;
            } else {
                flushGroup();
                i++;
            }
            continue;
        }

        // Parse .sizeof(...) arguments under 'sizeof' context and skip their span
        if (allowSizeof && code === 46 /* . */ && i + 7 <= end && text.startsWith('.sizeof', i)) {
            const parenPos = skipWhitespace(text, i + 7, end);
            if (parenPos < end && text.charCodeAt(parenPos) === 40 /* ( */) {
                const closeParen = findClosingParenOutsideQuotes(text, parenPos + 1, end);
                if (closeParen >= 0) {
                    if (onSizeofRange) {
                        onSizeofRange(parenPos + 1, closeParen);
                    }
                    i = closeParen + 1;
                    continue;
                }
            }
        }

        // Qualified separator :: followed by optional whitespace and identifier start
        if (code === 58 /* : */ && i + 1 < end && text.charCodeAt(i + 1) === 58 /* : */) {
            const identStart = skipWhitespace(text, i + 2, end);
            if (identStart < end && isIdentStartCode(text.charCodeAt(identStart))) {
                const identEnd = scanIdentEnd(text, identStart, end);
                const item: ParsedQualifiedName = {
                    text: text.slice(identStart, identEnd),
                    index: baseOffset + identStart,
                    context,
                };
                if (!currentGroup) {
                    currentGroup = [{ text: '', index: baseOffset + i, context }, item];
                } else {
                    currentGroup.push(item);
                }
                i = identEnd;
                continue;
            }
            flushGroup();
            i++;
            continue;
        }

        if (isIdentStartCode(code)) {
            flushGroup();
            const identEnd = scanIdentEnd(text, i, end);
            currentGroup = [{
                text: text.slice(i, identEnd),
                index: baseOffset + i,
                context,
            }];
            i = identEnd;
            continue;
        }

        flushGroup();
        i++;
    }

    flushGroup();
}

function visitQualifiedGroups(
    argsText: string,
    argsOffset: number,
    onGroup: (group: ParsedQualifiedName[]) => void
): void {
    if (!argsText) return;
    scanQualifiedRange(
        argsText,
        0,
        argsText.length,
        argsOffset,
        'symbol',
        true,
        onGroup,
        (innerStart, innerEnd) => {
            scanQualifiedRange(argsText, innerStart, innerEnd, argsOffset, 'sizeof', false, onGroup);
        }
    );
}

/**
 * Extracts simple and `::`-qualified identifier groups from an operand/argument string.
 */
export function parseQualifiedNames(argsText: string, argsOffset: number = 0): ParsedQualifiedName[][] {
    if (!argsText) return [];

    let sizeofGroups: ParsedQualifiedName[][] | undefined;
    const symbolGroups: ParsedQualifiedName[][] = [];

    scanQualifiedRange(
        argsText,
        0,
        argsText.length,
        argsOffset,
        'symbol',
        true,
        group => symbolGroups.push(group),
        (innerStart, innerEnd) => {
            const target = (sizeofGroups ??= []);
            scanQualifiedRange(
                argsText,
                innerStart,
                innerEnd,
                argsOffset,
                'sizeof',
                false,
                group => target.push(group)
            );
        }
    );

    if (!sizeofGroups) return symbolGroups;
    sizeofGroups.push(...symbolGroups);
    return sizeofGroups;
}

/**
 * Parses comma-separated `.import` / `.export` / `.global` argument groups.
 */
export function parseImportExportArgs(text: string, offset: number): ParsedImportExportArgs[] {
    function trimWithOffset(str: string, baseOffset: number): [string, number] {
        const trimmed = str.trimStart();
        return [trimmed, baseOffset + (str.length - trimmed.length)];
    }

    const groups: ParsedImportExportArgs[] = [];
    let currentOffset = offset;

    for (const rawGroup of text.split(',')) {
        let [rest, restOffset] = trimWithOffset(rawGroup, currentOffset);
        currentOffset += rawGroup.length + 1; // account for comma

        if (!rest) continue;

        const group: ParsedImportExportArgs = {};

        // 1: leading identifier (up to first special token)
        let m = rest.match(/^([^:=\s]+)/);
        if (m) {
            group.identifier = { text: m[1], index: restOffset };
            rest = rest.slice(m[0].length);
            restOffset += m[0].length;
        }

        [rest, restOffset] = trimWithOffset(rest, restOffset);

        // 2: optional ":" address size specifier
        if (rest.startsWith(':')) {
            rest = rest.slice(1);
            restOffset++;
            [rest, restOffset] = trimWithOffset(rest, restOffset);

            m = rest.match(/^([^:=\s]+)/);
            if (m) {
                group.addressSpecification = { text: m[1], index: restOffset };
                rest = rest.slice(m[0].length);
                restOffset += m[0].length;
            }
            [rest, restOffset] = trimWithOffset(rest, restOffset);
        }

        // 3: optional assignment
        if (rest.startsWith(':=') || rest.startsWith('=')) {
            const op = rest.startsWith(':=') ? ':=' : '=';
            group.assignmentOp = { text: op, index: restOffset };
            rest = rest.slice(op.length);
            restOffset += op.length;

            [rest, restOffset] = trimWithOffset(rest, restOffset);

            if (rest.length > 0) {
                group.value = { text: rest.trimEnd(), index: restOffset };
            }
        }

        groups.push(group);
    }

    return groups;
}

class DocumentScanner {
    private readonly symbolTable: SymbolTable;
    private currentScope: Scope;
    private currentMacro: Macro | null = null;
    private inIgnoredMacro = false;
    private currentSegment = 'CODE';
    private segmentStack: string[] = [];
    private currentLabel: Symbol | undefined;
    private pendingLabels: Symbol[] = [];
    private pendingLabelKindSet = false;
    private nextAnonLabelIndex = 0;

    private clearCurrentLabel(): void {
        this.currentLabel = undefined;
        this.pendingLabels.length = 0;
    }

    constructor(
        private readonly document: TextDocument,
        private readonly settings: Ca65Settings
    ) {
        this.symbolTable = new SymbolTable(document.uri);
        this.currentScope = this.symbolTable.getRootScope();
    }

    public scan(): SymbolTable {
        const fullText = this.document.getText();
        const len = fullText.length;
        let lineNumber = 0;
        let lineStart = 0;
        let inBlockComment = false;
        let segments: LogicalLineSegment[] = [];
        let joinedParts: string[] = [];
        let joinedLen = 0;

        const flushLogicalLine = () => {
            if (segments.length === 0) return;
            const logicalText = segments.length === 1 ? segments[0].code : joinedParts.join('');
            this.processLogicalLine(logicalText, segments);
            segments = [];
            joinedParts = [];
            joinedLen = 0;
        };

        while (lineStart <= len) {
            const nlIdx = fullText.indexOf('\n', lineStart);
            let lineEnd = nlIdx >= 0 ? nlIdx : len;
            if (lineEnd > lineStart && fullText.charCodeAt(lineEnd - 1) === 13 /* \r */) {
                lineEnd--;
            }

            const rawLine = fullText.slice(lineStart, lineEnd);
            const stripped = stripCommentsInLine(rawLine, inBlockComment, this.settings.cComments);
            inBlockComment = stripped.inBlockComment;

            const trimmedEnd = trimEndIndex(stripped.code, 0, stripped.code.length);
            const isBackslashCont = this.settings.lineContinuations
                && !stripped.hasSemicolonComment
                && !inBlockComment
                && trimmedEnd > 0
                && stripped.code.charCodeAt(trimmedEnd - 1) === 92 /* \ */;
            const segEnd = isBackslashCont ? trimmedEnd - 1 : trimmedEnd;
            const segCode = segEnd > 0 ? stripped.code.slice(0, segEnd) : '';

            if (skipWhitespace(segCode, 0, segCode.length) < segCode.length) {
                if (segments.length > 0) {
                    joinedParts.push(' ');
                    joinedLen++;
                }
                const joinedStart = joinedLen;
                joinedParts.push(segCode);
                joinedLen += segCode.length;
                segments.push({
                    line: lineNumber,
                    code: segCode,
                    joinedStart,
                    joinedEnd: joinedLen,
                });
            }

            const continuesToNext = inBlockComment || isBackslashCont;
            if (!continuesToNext) {
                flushLogicalLine();
            }

            if (nlIdx < 0) break;
            lineStart = nlIdx + 1;
            lineNumber++;
        }

        flushLogicalLine();
        this.pruneAnonymousLabelRefs();
        this.closeOpenScopes();
        return this.symbolTable;
    }

    private processLogicalLine(text: string, segments: readonly LogicalLineSegment[]): void {
        if (this.handleMacroContent(text, segments)) return;

        this.addAnonymousLabelRefs(text, segments);

        // Parse once for struct/union, enum, and generic directive/instruction lines
        const parsed = parseCodeLine(text);

        if (this.handleStructUnionContent(text, segments, parsed)) return;
        if (this.handleEnumContent(text, segments, parsed)) return;

        if (this.handleAssignment(text, segments)) return;
        this.handleGenericLine(parsed, segments, text.length);
    }

    private addReferences(
        text: string,
        segments: readonly LogicalLineSegment[],
        offset: number = 0,
        scope: Scope,
        callingEntity?: SymbolTableEntity
    ): void {
        visitQualifiedGroups(text, offset, (parsedNames) => {
            if (parsedNames.length === 1) {
                const { text: name, index, context } = parsedNames[0];
                this.symbolTable.addReference(new ReferenceInfo(
                    this.document.uri,
                    name,
                    EMPTY_QUALIFIERS,
                    context,
                    mapSpanToRange(segments, index, index + name.length),
                    scope,
                    callingEntity
                ));
                return;
            }

            let qualifiers: string[] | undefined;
            const lastIdx = parsedNames.length - 1;
            for (let i = 0; i < parsedNames.length; i++) {
                const { text: name, index, context } = parsedNames[i];
                const refQualifiers = i === 0
                    ? EMPTY_QUALIFIERS
                    : (i === lastIdx ? qualifiers! : qualifiers!.slice());
                this.symbolTable.addReference(new ReferenceInfo(
                    this.document.uri,
                    name,
                    refQualifiers,
                    i === lastIdx ? context : 'scope',
                    mapSpanToRange(segments, index, index + name.length),
                    scope,
                    callingEntity
                ));
                if (i < lastIdx) {
                    (qualifiers ??= []).push(name);
                }
            }
        });
    }

    private addSingleReference(
        context: ReferenceInfo['context'],
        segments: readonly LogicalLineSegment[],
        text: string,
        offset: number,
        scope: Scope
    ): void {
        this.symbolTable.addReference(new ReferenceInfo(
            this.document.uri,
            text,
            EMPTY_QUALIFIERS,
            context,
            mapSpanToRange(segments, offset, offset + text.length),
            scope
        ));
    }

    private addAnonymousLabelRefs(text: string, segments: readonly LogicalLineSegment[]): void {
        if (text.indexOf(':') === -1) return;

        const maskedText = maskQuotedLiterals(text);
        let match: RegExpExecArray | null;
        ANON_REF_RE.lastIndex = 0;
        while ((match = ANON_REF_RE.exec(maskedText)) !== null) {
            const offset = getAnonLabelRefOffsetFromPreviousLabel(match[0]);
            const targetIndex = this.nextAnonLabelIndex - 1 + offset;
            if (targetIndex < 0) continue;

            let list = this.symbolTable.anonymousLabelReferences.get(targetIndex);
            if (!list) {
                list = [];
                this.symbolTable.anonymousLabelReferences.set(targetIndex, list);
            }
            list.push(mapSpanToRange(segments, match.index, match.index + match[0].length));
        }
    }

    private handleAssignment(text: string, segments: readonly LogicalLineSegment[]): boolean {
        if (text.indexOf('=') !== -1) {
            const constMatch = text.match(CONSTANT_ASSIGNMENT_RE);
            if (constMatch?.groups) {
                return this.recordAssignment(text, segments, constMatch.groups.name, SymbolKind.Constant);
            }
        }

        if (text.indexOf('.set') !== -1) {
            const varMatch = text.match(VARIABLE_ASSIGNMENT_RE);
            if (varMatch?.groups) {
                return this.recordAssignment(text, segments, varMatch.groups.name, SymbolKind.Variable, this.currentSegment);
            }
        }

        return false;
    }

    private recordAssignment(
        text: string,
        segments: readonly LogicalLineSegment[],
        name: string,
        kind: SymbolKind,
        segment?: string
    ): boolean {
        const nameIndex = skipWhitespace(text, 0, text.length);
        const definition = mapSpanToRange(segments, nameIndex, nameIndex + name.length);
        this.addReferences(text, segments, 0, this.currentScope);
        if (name.startsWith('@')) {
            // Cheap locals live between two normal labels, not in the enclosing
            // scope, so they are resolved on demand like `@name:` labels.
            return true;
        }
        this.currentScope.addSymbol(name, definition, kind, segment);
        return true;
    }

    private handleMacroContent(text: string, segments: readonly LogicalLineSegment[]): boolean {
        if (!this.currentMacro && !this.inIgnoredMacro) return false;

        const word = firstWord(text);
        if (!word) return true;

        if (word.charCodeAt(0) === 46 && (word.length === 7 || word.length === 9)) {
            const lowerWord = word.toLowerCase();
            if (lowerWord === '.endmac' || lowerWord === '.endmacro') {
                if (this.currentMacro?.range) {
                    const endIdx = text.toLowerCase().indexOf('.end');
                    this.currentMacro.range.end = endIdx >= 0
                        ? mapOffsetToPosition(segments, endIdx, false)
                        : Position.create(segments[0].line, 0);
                }
                this.currentMacro = null;
                this.inIgnoredMacro = false;
            }
        }
        return true;
    }

    private openScope(kind: ScopeKind, segments: readonly LogicalLineSegment[], command: LineItem, args?: LineItem): void {
        this.clearCurrentLabel();
        const argsIndex = args?.index ?? (command.index + command.text.length);
        const defRange = args?.text
            ? mapSpanToRange(segments, args.index, args.index + args.text.length)
            : mapSpanToRange(segments, argsIndex, argsIndex);
        let name = args?.text || '';
        if (name) {
            this.addSingleReference('scope', segments, name, argsIndex, this.currentScope);
        } else {
            name = `<anon line ${defRange.start.line + 1}>`;
        }
        this.currentScope = this.currentScope.addChildScope(
            name,
            defRange,
            kind,
            kind === ScopeKind.Proc ? this.currentSegment : undefined
        );
    }

    private closeScope(expectedKind: ScopeKind, line: number, character: number): boolean {
        if (!this.currentScope.scope || this.currentScope.kind !== expectedKind) {
            return false;
        }
        if (this.currentScope.range) {
            this.currentScope.range.end = { line, character };
        }
        this.currentScope = this.currentScope.scope;
        return true;
    }

    private handleStructUnionContent(
        text: string,
        segments: readonly LogicalLineSegment[],
        parsed: ParsedLine
    ): boolean {
        if (this.currentScope.kind !== ScopeKind.Struct && this.currentScope.kind !== ScopeKind.Union) {
            return false;
        }

        const { command, args } = parsed;
        if (!command) return !parsed.label;
        const cmd = command.text.toLowerCase();

        if (CLOSE_SCOPE_KINDS[cmd] === this.currentScope.kind) {
            const closePos = mapOffsetToPosition(segments, command.index, false);
            this.closeScope(this.currentScope.kind, closePos.line, closePos.character);
            return true;
        }

        if (cmd === '.struct' || cmd === '.union') {
            this.openScope(OPEN_SCOPE_KINDS[cmd], segments, command, args);
            return true;
        }

        const definition = mapSpanToRange(segments, command.index, command.index + command.text.length);

        if (args && firstWord(args.text).toLowerCase() === '.tag') {
            // Struct member is at the command position
            this.addSingleReference('symbol', segments, command.text, command.index, this.currentScope);
            const argsWithoutTag = args.text.slice('.tag'.length).trimStart();
            const indexOfStructName = args.text.length - argsWithoutTag.length + args.index;
            const structName = firstWord(argsWithoutTag);
            if (structName) {
                this.addSingleReference('scope', segments, structName, indexOfStructName, this.currentScope);
            }
        } else {
            this.addReferences(text, segments, 0, this.currentScope);
        }
        this.currentScope.addSymbol(command.text, definition, SymbolKind.StructMember);
        return true;
    }

    private handleEnumContent(
        text: string,
        segments: readonly LogicalLineSegment[],
        parsed: ParsedLine
    ): boolean {
        if (this.currentScope.kind !== ScopeKind.Enum) {
            return false;
        }

        const { command } = parsed;
        if (!command) return !parsed.label;

        if (command.text.toLowerCase() === '.endenum') {
            const closePos = mapOffsetToPosition(segments, command.index, false);
            this.closeScope(ScopeKind.Enum, closePos.line, closePos.character);
            return true;
        }

        const definition = mapSpanToRange(segments, command.index, command.index + command.text.length);
        this.addReferences(text, segments, 0, this.currentScope);
        this.currentScope.addSymbol(command.text, definition, SymbolKind.EnumMember);
        return true;
    }

    private handleGenericLine(
        parsed: ParsedLine,
        segments: readonly LogicalLineSegment[],
        trimmedLen: number
    ): void {
        const { label, command, args } = parsed;
        if (label) {
            this.handleLabel(segments, label);
        }

        if (!command) return;

        const cmd = command.text.toLowerCase();
        const isDirective = cmd.charCodeAt(0) === 46 /* . */;
        if (!isDirective && !getMnemonicInfo(cmd, this.settings.cpu)) {
            this.addSingleReference('macro', segments, command.text, command.index, this.symbolTable.getRootScope());
        }

        if (isDirective && this.handleDirective(segments, command, args)) {
            return;
        }

        const argsText = args?.text || '';
        if (this.currentLabel) {
            // Consume any un-labeled commands as part of the current label
            this.currentLabel.range.end = mapOffsetToPosition(segments, trimmedLen, true);
            this.updateLabelKindFromCommand(cmd, argsText);
        }

        if (!args) return;

        if (cmd === '.tag') {
            const structName = firstWord(args.text);
            if (structName) {
                this.addSingleReference('scope', segments, structName, args.index, this.currentScope);
            }
            return;
        }

        let callingEntity: SymbolTableEntity | undefined;
        if (cmd === 'jsr' || cmd === 'jmp' || (this.settings.cpu === '65816' && (cmd === 'jsl' || cmd === 'jml'))) {
            if (this.currentLabel) {
                callingEntity = this.currentLabel;
            } else if (this.currentScope.kind === ScopeKind.Proc) {
                callingEntity = this.currentScope;
            }
        }
        this.addReferences(args.text, segments, args.index, this.currentScope, callingEntity);
    }

    private handleLabel(segments: readonly LogicalLineSegment[], label: LineItem): void {
        if (label.text.startsWith('@')) {
            // Cheap local labels are resolved on-demand.
            return;
        }

        if (label.text.length === 0) {
            const labelPos = mapOffsetToPosition(segments, label.index, false);
            this.symbolTable.anonymousLabelLines.push(labelPos.line);
            let refs = this.symbolTable.anonymousLabelReferences.get(this.nextAnonLabelIndex);
            if (!refs) {
                refs = [];
                this.symbolTable.anonymousLabelReferences.set(this.nextAnonLabelIndex, refs);
            }
            refs.push(Range.create(labelPos.line, labelPos.character, labelPos.line, labelPos.character + 1));
            this.nextAnonLabelIndex++;
            return;
        }

        this.addSingleReference('symbol', segments, label.text, label.index, this.currentScope);
        if (this.pendingLabelKindSet) {
            this.pendingLabels.length = 0;
        }
        const addedLabel = this.currentScope.addSymbol(
            label.text,
            mapSpanToRange(segments, label.index, label.index + label.text.length),
            SymbolKind.Label,
            this.currentSegment
        );
        this.currentLabel = addedLabel;
        this.pendingLabels.push(addedLabel);
        this.pendingLabelKindSet = false;
    }

    private handleDirective(
        segments: readonly LogicalLineSegment[],
        command: LineItem,
        args?: LineItem
    ): boolean {
        const cmd = command.text.toLowerCase();
        const argsText = args?.text || '';
        const argsIndex = args?.index ?? (command.index + command.text.length);
        const cmdLine = mapOffsetToPosition(segments, command.index, false).line;

        const openKind = OPEN_SCOPE_KINDS[cmd];
        if (openKind) {
            this.openScope(openKind, segments, command, args);
            return true;
        }

        if (cmd === '.endproc' || cmd === '.endscope') {
            this.clearCurrentLabel();
            const closePos = mapOffsetToPosition(segments, command.index, false);
            return this.closeScope(CLOSE_SCOPE_KINDS[cmd], closePos.line, closePos.character);
        }

        if (cmd === '.macro' || cmd === '.mac') {
            this.handleMacroDirective(segments, argsText, argsIndex, args ? firstWord(args.text) : undefined);
            return true;
        }

        if (cmd === '.define') {
            this.handleDefineDirective(segments, argsText, argsIndex);
            return true;
        }

        if (SEGMENT_DIRECTIVES.has(cmd)) {
            this.clearCurrentLabel();
            if (cmd === '.segment') {
                const parsedSeg = parseSegmentDirectiveArgs(argsText);
                this.currentSegment = parsedSeg.segment;
                if (parsedSeg.segment && parsedSeg.addrSize) {
                    this.symbolTable.recordSegmentAddrSize(parsedSeg.segment, parsedSeg.addrSize);
                }
            } else {
                this.currentSegment = cmd.slice(1).toUpperCase();
            }
            this.symbolTable.recordSegmentChange(cmdLine, this.currentSegment);
            return true;
        }

        if (cmd === '.pushseg') {
            this.segmentStack.push(this.currentSegment);
            return true;
        }

        if (cmd === '.popseg') {
            this.clearCurrentLabel();
            if (this.segmentStack.length > 0) {
                this.currentSegment = this.segmentStack.pop()!;
                this.symbolTable.recordSegmentChange(cmdLine, this.currentSegment);
            }
            return true;
        }

        if (IMPORT_EXPORT_DIRECTIVES.has(cmd)) {
            this.handleImportExportDirective(cmd, segments, args);
            return true;
        }

        if (cmd === '.include') {
            this.handleIncludeDirective(segments, args);
            return true;
        }

        if (cmd === '.incbin' && args && args.text.startsWith('"')) {
            const closeQuote = args.text.indexOf('"', 1);
            if (closeQuote > 1) {
                const pathRange = mapSpanToRange(segments, args.index + 1, args.index + closeQuote);
                this.symbolTable.documentLinkDirectives.push({
                    line: pathRange.start.line,
                    startChar: pathRange.start.character,
                    endChar: pathRange.end.character,
                    filename: args.text.slice(1, closeQuote),
                    isBinary: true,
                });
            }
        }

        return false;
    }

    private handleMacroDirective(
        segments: readonly LogicalLineSegment[],
        argsText: string,
        argsIndex: number,
        name?: string
    ): void {
        this.clearCurrentLabel();
        if (!name) return;

        const rawParams = argsText.slice(name.length).trim();
        const params = rawParams
            ? rawParams.split(',').map(p => p.trim()).filter(Boolean)
            : [];

        this.addSingleReference('macro', segments, name, argsIndex, this.currentScope);
        if (!this.symbolTable.getMacro(name)) {
            this.currentMacro = this.symbolTable.addMacro(
                name,
                mapSpanToRange(segments, argsIndex, argsIndex + argsText.length),
                MacroKind.Macro,
                params
            );
        } else {
            this.inIgnoredMacro = true;
        }
    }

    private handleDefineDirective(
        segments: readonly LogicalLineSegment[],
        argsText: string,
        argsIndex: number
    ): void {
        this.clearCurrentLabel();
        const defMatch = argsText.match(/([a-zA-Z_@.][a-zA-Z0-9_]*)(?:\(([^)]*)\))?/);
        const name = defMatch?.[1];
        if (!name) return;

        const rawParams = defMatch?.[2];
        const params = rawParams !== undefined
            ? rawParams.split(',').map(p => p.trim()).filter(Boolean)
            : [];
        const nameStart = argsIndex + (defMatch?.index ?? 0);

        this.addSingleReference('macro', segments, name, nameStart, this.currentScope);
        if (!this.symbolTable.getMacro(name)) {
            this.symbolTable.addMacro(
                name,
                mapSpanToRange(segments, nameStart, nameStart + name.length),
                MacroKind.Define,
                params
            );
        }
    }

    private handleImportExportDirective(
        cmd: string,
        segments: readonly LogicalLineSegment[],
        args?: LineItem
    ): void {
        if (!args) return;

        const isImport = cmd.startsWith('.import');
        const isGlobal = cmd.startsWith('.global');
        const isExport = cmd.startsWith('.export');
        const isZeroPage = cmd.endsWith('zp');

        for (const { identifier, assignmentOp, value } of parseImportExportArgs(args.text, args.index)) {
            if (!identifier) continue;

            const identifierRange = mapSpanToRange(
                segments,
                identifier.index,
                identifier.index + identifier.text.length
            );

            if (isExport && assignmentOp && value) {
                // Exports may define a constant on the same line
                this.currentScope.addSymbol(identifier.text, identifierRange, SymbolKind.Constant);
                this.addReferences(value.text, segments, value.index, this.currentScope);
            }
            this.addSingleReference('symbol', segments, identifier.text, identifier.index, this.currentScope);

            if (isImport || isGlobal) {
                this.symbolTable.imports.push(
                    this.currentScope.addImport(
                        identifier.text,
                        identifierRange,
                        isImport ? ImportKind.Import : ImportKind.Global,
                        isZeroPage
                    )
                );
            }
            if (isExport || isGlobal) {
                this.symbolTable.exports.push(
                    new Export(
                        this.document.uri,
                        isExport ? ExportKind.Export : ExportKind.Global,
                        identifier.text,
                        identifierRange,
                        this.currentScope,
                        isZeroPage
                    )
                );
            }
        }
    }

    private handleIncludeDirective(
        segments: readonly LogicalLineSegment[],
        args?: LineItem
    ): void {
        this.clearCurrentLabel();
        if (!args) return;

        const argsText = args.text;
        const match = argsText.match(/^(['"])(.*)\1$/);
        if (!match) return;

        const quote = match[1];
        const filename = match[2];
        const targetUri = resolveIncludeUri(this.document.uri, filename, this.settings.includeDirs);
        if (targetUri) {
            this.symbolTable.includedFiles.push(targetUri);
        } else {
            this.symbolTable.unresolvedIncludes.push(filename);
        }
        if (quote === '"' && filename.length > 0) {
            const pathRange = mapSpanToRange(segments, args.index + 1, args.index + 1 + filename.length);
            this.symbolTable.documentLinkDirectives.push({
                line: pathRange.start.line,
                startChar: pathRange.start.character,
                endChar: pathRange.end.character,
                filename,
                isBinary: false,
                resolvedUri: targetUri,
            });
        }
    }

    private updateLabelKindFromCommand(cmd: string, argsText: string): void {
        if (this.pendingLabels.length === 0 || this.pendingLabelKindSet || LABEL_KIND_TRANSPARENT_DIRECTIVES.has(cmd)) return;

        this.pendingLabelKindSet = true;
        let resolvedKind: SymbolKind | undefined;
        if (cmd.charCodeAt(0) !== 46 /* . */) {
            if (getMnemonicInfo(cmd, this.settings.cpu)) {
                resolvedKind = SymbolKind.CodeLabel;
            }
        } else if (cmd === '.res' || cmd === '.tag') {
            resolvedKind = SymbolKind.ResLabel;
        } else if (cmd === '.byt' || cmd === '.byte') {
            resolvedKind = STRING_BYTE_LIST_RE.test(argsText)
                ? SymbolKind.StringLabel
                : SymbolKind.DataLabel;
        } else if (DATA_LABEL_DIRECTIVES.has(cmd)) {
            resolvedKind = SymbolKind.DataLabel;
        } else if (STRING_LABEL_DIRECTIVES.has(cmd)) {
            resolvedKind = SymbolKind.StringLabel;
        }

        if (resolvedKind) {
            for (const lbl of this.pendingLabels) {
                lbl.kind = resolvedKind;
            }
        }
    }

    private pruneAnonymousLabelRefs(): void {
        for (const refIndex of this.symbolTable.anonymousLabelReferences.keys()) {
            if (refIndex < 0 || refIndex >= this.nextAnonLabelIndex) {
                this.symbolTable.anonymousLabelReferences.delete(refIndex);
            }
        }
    }

    private closeOpenScopes(): void {
        let openScope: Scope | null = this.currentScope;
        while (openScope != null) {
            openScope.range.end = { line: this.document.lineCount, character: 0 };
            openScope = openScope.scope;
        }
    }
}

/**
 * Scans a ca65 document and constructs its symbol, scope, macro, include, and reference table.
 */
export async function scanDocument(document: TextDocument): Promise<SymbolTable> {
    const settings = await getDocumentSettings(document.uri);
    return performanceMonitor.time('scanDocument', () => {
        return new DocumentScanner(document, settings).scan();
    });
}
