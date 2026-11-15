import { Location, Position, Range } from 'vscode-languageserver-types';
import { TextDocument } from 'vscode-languageserver-textdocument';
import { findCommentStart } from './documentScanner';

export const CHEAP_LOCAL_BOUNDARY_REGEX = /^\s*(?:[a-zA-Z_.][a-zA-Z0-9_@.]*:(?![:=<>+-])|\.(?:proc|struct|union)\b)/i;
const CHEAP_LOCAL_DEF_LINE_REGEX = /^\s*(@[a-zA-Z0-9_@.]+):/;
const CHEAP_LOCAL_TOKEN_REGEX = /(?<![a-zA-Z0-9_@.])@[a-zA-Z0-9_@.]+(?![a-zA-Z0-9_@.])/g;

function escapeRegExp(str: string): string {
    return str.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

export const CHEAP_LOCAL_DEF_REGEX = (name: string) => new RegExp(`^\\s*${escapeRegExp(name)}:`);

function extractCodeSlice(text: string, lineStart: number, lineEnd: number): string {
    const end = (lineEnd > lineStart && text.charCodeAt(lineEnd - 1) === 13) ? lineEnd - 1 : lineEnd;
    if (end <= lineStart) return '';
    const raw = text.slice(lineStart, end);
    const commentIdx = findCommentStart(raw);
    return commentIdx >= 0 ? raw.slice(0, commentIdx) : raw;
}

function getLineBounds(text: string, document: TextDocument, line: number): { start: number; end: number } {
    const start = document.offsetAt({ line, character: 0 });
    const nl = text.indexOf('\n', start);
    const end = nl === -1 ? text.length : nl;
    return { start, end };
}

function mayBeCheapLocalBoundary(text: string, lineStart: number, lineEnd: number): boolean {
    let p = lineStart;
    while (p < lineEnd) {
        const c = text.charCodeAt(p);
        if (c !== 32 && c !== 9 && c !== 13) break;
        p++;
    }
    if (p >= lineEnd) return false;
    const first = text.charCodeAt(p);
    if (first === 59) return false; // ';' comment
    if (first === 46) return true;  // '.' directive like .proc/.struct/.union
    // Label boundary requires ':' somewhere before ';'
    for (let i = p + 1; i < lineEnd; i++) {
        const c = text.charCodeAt(i);
        if (c === 59) return false;
        if (c === 58) return true;
    }
    return false;
}

function startsWithCheapLocalDef(text: string, lineStart: number, lineEnd: number): boolean {
    let p = lineStart;
    while (p < lineEnd) {
        const c = text.charCodeAt(p);
        if (c !== 32 && c !== 9 && c !== 13) break;
        p++;
    }
    if (p >= lineEnd || text.charCodeAt(p) !== 64) return false; // '@'
    for (let i = p + 1; i < lineEnd; i++) {
        const c = text.charCodeAt(i);
        if (c === 59) return false;
        if (c === 58) return true;
    }
    return false;
}

function findPreviousBoundaryFromOffset(
    text: string,
    startLine: number,
    startLineOffset: number,
    startLineEnd: number
): { line: number; startOffset: number; endOffset: number } {
    let line = startLine;
    let lineStart = startLineOffset;
    let lineEnd = startLineEnd;

    while (line >= 0) {
        if (
            mayBeCheapLocalBoundary(text, lineStart, lineEnd)
            && CHEAP_LOCAL_BOUNDARY_REGEX.test(extractCodeSlice(text, lineStart, lineEnd))
        ) {
            return { line, startOffset: lineStart, endOffset: lineEnd };
        }
        if (line === 0 || lineStart === 0) break;
        line--;
        lineEnd = lineStart - 1;
        const prevNl = lineEnd === 0 ? -1 : text.lastIndexOf('\n', lineEnd - 1);
        lineStart = prevNl === -1 ? 0 : prevNl + 1;
    }

    return { line: -1, startOffset: 0, endOffset: -1 };
}

function getCheapLocalScopeSpan(
    text: string,
    document: TextDocument,
    line: number
): { startLine: number; startOffset: number; startEndOffset: number; endLine: number } {
    const targetBounds = getLineBounds(text, document, line);
    const boundary = findPreviousBoundaryFromOffset(text, line, targetBounds.start, targetBounds.end);

    let startLine: number;
    let startOffset: number;
    let startEndOffset: number;
    if (boundary.line === -1) {
        startLine = 0;
        startOffset = 0;
        const nl0 = text.indexOf('\n');
        startEndOffset = nl0 === -1 ? text.length : nl0;
    } else {
        startLine = boundary.line;
        startOffset = boundary.startOffset;
        startEndOffset = boundary.endOffset;
    }

    const totalLines = document.lineCount;
    let endLine = totalLines - 1;
    let curLine = startLine + 1;
    let curStart = startEndOffset + 1;

    while (curLine < totalLines && curStart <= text.length) {
        const nl = text.indexOf('\n', curStart);
        const curEnd = nl === -1 ? text.length : nl;
        if (
            mayBeCheapLocalBoundary(text, curStart, curEnd)
            && CHEAP_LOCAL_BOUNDARY_REGEX.test(extractCodeSlice(text, curStart, curEnd))
        ) {
            endLine = curLine - 1;
            break;
        }
        if (nl === -1) break;
        curStart = nl + 1;
        curLine++;
    }

    return { startLine, startOffset, startEndOffset, endLine };
}

/**
 * Returns the inclusive last line number of the cheap local label scope containing `line`.
 */
export function getCheapLocalScopeEndLine(document: TextDocument, line: number): number {
    if (line < 0 || line >= document.lineCount) {
        return Math.max(0, document.lineCount - 1);
    }
    return getCheapLocalScopeSpan(document.getText(), document, line).endLine;
}

/**
 * Finds the previous boundary for a cheap local label.
 * @param document The document to scan.
 * @param startLine The line to start scanning backwards from.
 * @returns The line number of the parent boundary, or -1 if none.
 */
export function findPreviousCheapLocalBoundary(document: TextDocument, startLine: number): number {
    if (startLine < 0 || startLine >= document.lineCount) {
        return -1;
    }
    const text = document.getText();
    const bounds = getLineBounds(text, document, startLine);
    return findPreviousBoundaryFromOffset(text, startLine, bounds.start, bounds.end).line;
}

function findCheapLocalLabelInText(text: string, document: TextDocument, position: Position): string | null {
    const { start, end } = getLineBounds(text, document, position.line);
    const codeLine = extractCodeSlice(text, start, end);
    CHEAP_LOCAL_TOKEN_REGEX.lastIndex = 0;
    let match: RegExpExecArray | null;
    while ((match = CHEAP_LOCAL_TOKEN_REGEX.exec(codeLine)) !== null) {
        const matchStart = match.index;
        const matchEnd = matchStart + match[0].length;
        if (position.character >= matchStart && position.character <= matchEnd) {
            return match[0];
        }
    }
    return null;
}

/**
 * Returns the cheap local label name under the cursor, or null if none.
 */
export function findCheapLocalLabelAtPosition(document: TextDocument, position: Position): string | null {
    return findCheapLocalLabelInText(document.getText(), document, position);
}

/**
 * Lists all cheap local label definitions visible in the cheap local scope at `position`.
 */
export function getCheapLocalLabelDefinitions(document: TextDocument, position: Position): string[] {
    const text = document.getText();
    const { startLine, startOffset, endLine } = getCheapLocalScopeSpan(text, document, position.line);
    const labels: string[] = [];

    let curLine = startLine;
    let curStart = startOffset;
    while (curLine <= endLine) {
        const nl = text.indexOf('\n', curStart);
        const curEnd = nl === -1 ? text.length : nl;
        if (startsWithCheapLocalDef(text, curStart, curEnd)) {
            const match = extractCodeSlice(text, curStart, curEnd).match(CHEAP_LOCAL_DEF_LINE_REGEX);
            if (match) {
                labels.push(match[1]);
            }
        }
        if (nl === -1) break;
        curStart = nl + 1;
        curLine++;
    }
    return labels;
}

/**
 * Finds the definition of a cheap local label by scanning within its enclosing cheap local scope.
 */
export function findCheapLocalLabelDefinition(document: TextDocument, position: Position, name: string): Location | null {
    const text = document.getText();
    const { startLine, startOffset, endLine } = getCheapLocalScopeSpan(text, document, position.line);
    const defRegex = CHEAP_LOCAL_DEF_REGEX(name);

    let curLine = startLine;
    let curStart = startOffset;
    while (curLine <= endLine) {
        const nl = text.indexOf('\n', curStart);
        const curEnd = nl === -1 ? text.length : nl;
        const codeLine = extractCodeSlice(text, curStart, curEnd);
        if (defRegex.test(codeLine)) {
            const startChar = codeLine.indexOf(name);
            const endChar = startChar + name.length;
            return Location.create(document.uri, Range.create(curLine, startChar, curLine, endChar));
        }
        if (nl === -1) break;
        curStart = nl + 1;
        curLine++;
    }

    return null;
}

/**
 * Finds all references to the cheap local label at `position`.
 */
export function findAllCheapLocalLabelReferences(
    document: TextDocument,
    position: Position
): Location[] {
    const text = document.getText();
    const name = findCheapLocalLabelInText(text, document, position);
    if (!name) {
        return [];
    }

    const { startLine, startOffset, endLine } = getCheapLocalScopeSpan(text, document, position.line);
    const defRegex = CHEAP_LOCAL_DEF_REGEX(name);
    const referenceRegex = new RegExp(`(?<![a-zA-Z0-9_@.])${escapeRegExp(name)}(?![a-zA-Z0-9_@.])`, 'g');

    let hasDefinition = false;
    const locations: Location[] = [];

    let curLine = startLine;
    let curStart = startOffset;
    while (curLine <= endLine) {
        const nl = text.indexOf('\n', curStart);
        const curEnd = nl === -1 ? text.length : nl;
        const codeLine = extractCodeSlice(text, curStart, curEnd);
        if (defRegex.test(codeLine)) {
            hasDefinition = true;
        }
        referenceRegex.lastIndex = 0;
        let match: RegExpExecArray | null;
        while ((match = referenceRegex.exec(codeLine)) !== null) {
            locations.push(Location.create(document.uri, Range.create(curLine, match.index, curLine, match.index + name.length)));
        }
        if (nl === -1) break;
        curStart = nl + 1;
        curLine++;
    }

    return hasDefinition ? locations : [];
}
