import { Range } from 'vscode-languageserver-types';
import { TextDocument } from 'vscode-languageserver-textdocument';
import { getMnemonicInfo, MnemonicModeInfo } from './dataManager';
import { getCachedTextDocumentSync } from './documentCache';
import { doesStrippedLineContinue, isInBlockCommentBeforeLine, parseLine, stripCommentsInLine } from './documentScanner';
import { IncludesGraph } from './includesGraph';
import { LstLineInfo, normalizeListingBytesText } from './lstParser';
import { resolveIncbinFileSizeSync } from './pathUtils';
import { Ca65Cpu, normalizeCpu } from './settings';
import { resolveImport, resolveReference } from './symbolResolver';
import { Import, isLabelSymbolKind, Macro, MacroKind, ReferenceInfo, resolveSegmentAddrSize, Scope, ScopeKind, Symbol, SymbolKind, SymbolTable, SymbolTableEntity } from './symbolTable';

export interface InstructionAnalysisItem {
    line: number;
    mnemonic: string;
    mode: string;
    minBytes: number;
    maxBytes: number;
    minCycles: number;
    maxCycles: number;
    bytesText?: string;
    uncertainMode?: boolean;
    hasBranchPenalty?: boolean;
    hasPagePenalty?: boolean;
    hasVariableWidth16?: boolean;
    hasDpOffsetPenalty?: boolean;
    hasEmulationPagePenalty?: boolean;
    hasPerByteCycles?: boolean;
}

export interface ListingLineRangeItem {
    line: number;
    bytesText: string;
    byteCount: number;
}

export interface InstructionAnalysisSummary {
    cpu?: Ca65Cpu;
    instructionCount: number;
    minBytes: number;
    maxBytes: number;
    minCycles: number;
    maxCycles: number;
    uncertainCount: number;
    usedListing?: boolean;
    hasBranchPenalty: boolean;
    hasPagePenalty: boolean;
    hasVariableWidth16: boolean;
    hasDpOffsetPenalty: boolean;
    hasEmulationPagePenalty: boolean;
    hasPerByteCycles: boolean;
    lineListing?: {
        bytesText: string;
        byteCount: number;
    };
    listingLines?: ListingLineRangeItem[];
    items: InstructionAnalysisItem[];
}

type AddressWidth = 'zp' | 'abs' | 'far' | 'unknown';

interface ExprToken {
    type: 'num' | 'op' | 'lparen' | 'rparen' | 'ident' | 'sizeof' | 'unary_fn';
    value: string;
    numValue?: number;
}

const UNARY_PSEUDO_FUNCTIONS = new Set([
    '.lobyte',
    '.hibyte',
    '.bankbyte',
    '.loword',
    '.hiword',
]);

const QUALIFIED_IDENT_RE = /^(?:::)?[a-zA-Z_@][a-zA-Z0-9_]*(?:::[a-zA-Z_@][a-zA-Z0-9_]*)*$/;

function findMatchingCloseParen(text: string, openParenIdx: number): number {
    let depth = 0;
    let quote = 0;
    for (let i = openParenIdx; i < text.length; i++) {
        const c = text.charCodeAt(i);
        if (quote !== 0) {
            if (c === quote) {
                quote = 0;
            }
        } else if (c === 34 /* " */ || c === 39 /* ' */) {
            quote = c;
        } else if (c === 40 /* ( */) {
            depth++;
        } else if (c === 41 /* ) */) {
            depth--;
            if (depth === 0) return i;
        }
    }
    return -1;
}

function isSimpleQuotedString(text: string, allowEscapes: boolean = false): boolean {
    if (text.length < 2 || text.charCodeAt(0) !== 34) return false;
    for (let i = 1; i < text.length; i++) {
        const c = text.charCodeAt(i);
        if (allowEscapes && c === 92 /* \ */) {
            i++;
            continue;
        }
        if (c === 34 /* " */) {
            return i === text.length - 1;
        }
    }
    return false;
}

function isWsCode(code: number): boolean {
    return code === 32 || code === 9 || code === 10 || code === 13 || code === 11 || code === 12 || code === 160;
}

function isDigitCode(code: number): boolean {
    return code >= 48 && code <= 57;
}

function isHexCode(code: number): boolean {
    return (code >= 48 && code <= 57) || (code >= 65 && code <= 70) || (code >= 97 && code <= 102);
}

function isIdentStartCode(code: number): boolean {
    return (code >= 65 && code <= 90) // A-Z
        || (code >= 97 && code <= 122) // a-z
        || code === 95 // _
        || code === 64; // @
}

function isIdentBodyCode(code: number): boolean {
    return isIdentStartCode(code)
        || isDigitCode(code)
        || code === 46 // .
        || code === 58; // :
}

function isSingleCharOp(code: number): boolean {
    // + - * / & | ^ ~ < >
    return code === 43 || code === 45 || code === 42 || code === 47
        || code === 38 || code === 124 || code === 94 || code === 126
        || code === 60 || code === 62;
}

/**
 * Tokenizes a 6502/ca65 constant arithmetic expression.
 * Returns null if an unsupported construct is encountered.
 */
function tokenizeExpr(expr: string): ExprToken[] | null {
    const tokens: ExprToken[] = [];
    const len = expr.length;
    let i = 0;

    while (i < len) {
        const code = expr.charCodeAt(i);
        if (isWsCode(code)) {
            i++;
            continue;
        }
        if (code === 40) { // '('
            tokens.push({ type: 'lparen', value: '(' });
            i++;
            continue;
        }
        if (code === 41) { // ')'
            tokens.push({ type: 'rparen', value: ')' });
            i++;
            continue;
        }
        if ((code === 60 || code === 62) && i + 1 < len && expr.charCodeAt(i + 1) === code) {
            tokens.push({ type: 'op', value: code === 60 ? '<<' : '>>' });
            i += 2;
            continue;
        }
        if (isSingleCharOp(code)) {
            tokens.push({ type: 'op', value: expr[i] });
            i++;
            continue;
        }
        if (code === 36) { // '$' hex
            const start = i + 1;
            let p = start;
            let val = 0;
            let digits = 0;
            while (p < len) {
                const c = expr.charCodeAt(p);
                if (isHexCode(c)) {
                    const dv = c <= 57 ? c - 48 : (c <= 70 ? c - 55 : c - 87);
                    val = val * 16 + dv;
                    digits++;
                } else if (c !== 95) { // '_'
                    break;
                }
                p++;
            }
            if (p === start) return null;
            tokens.push({
                type: 'num',
                value: expr.slice(i, p),
                numValue: digits > 0 ? val : NaN,
            });
            i = p;
            continue;
        }
        if (code === 37) { // '%' binary
            const start = i + 1;
            let p = start;
            let val = 0;
            let digits = 0;
            while (p < len) {
                const c = expr.charCodeAt(p);
                if (c === 48 || c === 49) {
                    val = val * 2 + (c - 48);
                    digits++;
                } else if (c !== 95) {
                    break;
                }
                p++;
            }
            if (p === start) return null;
            tokens.push({
                type: 'num',
                value: expr.slice(i, p),
                numValue: digits > 0 ? val : NaN,
            });
            i = p;
            continue;
        }
        if (code === 39 && i + 2 < len && expr.charCodeAt(i + 2) === 39) { // 'c'
            tokens.push({ type: 'num', value: expr.slice(i, i + 3), numValue: expr.charCodeAt(i + 1) });
            i += 3;
            continue;
        }
        if (isDigitCode(code)) {
            if (code === 48 && i + 1 < len && (expr.charCodeAt(i + 1) === 120 || expr.charCodeAt(i + 1) === 88)) {
                const start = i + 2;
                let p = start;
                let val = 0;
                let digits = 0;
                while (p < len) {
                    const c = expr.charCodeAt(p);
                    if (isHexCode(c)) {
                        const dv = c <= 57 ? c - 48 : (c <= 70 ? c - 55 : c - 87);
                        val = val * 16 + dv;
                        digits++;
                    } else if (c !== 95) {
                        break;
                    }
                    p++;
                }
                if (p === start) return null;
                tokens.push({
                    type: 'num',
                    value: expr.slice(i, p),
                    numValue: digits > 0 ? val : NaN,
                });
                i = p;
                continue;
            }
            let p = i;
            let val = 0;
            let digits = 0;
            while (p < len) {
                const c = expr.charCodeAt(p);
                if (isDigitCode(c)) {
                    val = val * 10 + (c - 48);
                    digits++;
                } else if (c !== 95) {
                    break;
                }
                p++;
            }
            tokens.push({
                type: 'num',
                value: expr.slice(i, p),
                numValue: digits > 0 ? val : NaN,
            });
            i = p;
            continue;
        }
        if (code === 46) { // '.sizeof', '.strlen', '.lobyte', ...
            let p = i + 1;
            while (p < len && isIdentBodyCode(expr.charCodeAt(p))) {
                p++;
            }
            if (p === i + 1) return null;
            const fnName = expr.slice(i, p).toLowerCase();
            if (fnName === '.sizeof' || fnName === '.strlen') {
                let openIdx = p;
                while (openIdx < len && isWsCode(expr.charCodeAt(openIdx))) {
                    openIdx++;
                }
                if (openIdx >= len || expr.charCodeAt(openIdx) !== 40) return null;
                const closeIdx = findMatchingCloseParen(expr, openIdx);
                if (closeIdx < 0) return null;
                const inner = expr.slice(openIdx + 1, closeIdx).trim();
                if (fnName === '.sizeof') {
                    if (!QUALIFIED_IDENT_RE.test(inner)) return null;
                    tokens.push({ type: 'sizeof', value: inner });
                } else {
                    if (!isSimpleQuotedString(inner)) return null;
                    tokens.push({ type: 'num', value: expr.slice(i, closeIdx + 1), numValue: inner.length - 2 });
                }
                i = closeIdx + 1;
                continue;
            }
            if (UNARY_PSEUDO_FUNCTIONS.has(fnName)) {
                tokens.push({ type: 'unary_fn', value: fnName });
                i = p;
                continue;
            }
            return null;
        }
        if (isIdentStartCode(code) || (code === 58 && i + 1 < len && expr.charCodeAt(i + 1) === 58)) {
            let p = i + (code === 58 ? 2 : 1);
            if (code === 58 && (p >= len || !isIdentStartCode(expr.charCodeAt(p)))) return null;
            while (p < len && isIdentBodyCode(expr.charCodeAt(p))) {
                p++;
            }
            tokens.push({ type: 'ident', value: expr.slice(i, p) });
            i = p;
            continue;
        }
        return null;
    }

    return tokens;
}

/**
 * Evaluates a constant numeric expression if all symbols resolve to known numeric values.
 */
export function tryEvaluateNumericExpr(
    expr: string,
    resolveIdent?: (name: string) => number | null,
    resolveSizeof?: (name: string) => number | null
): number | null {
    const tokens = tokenizeExpr(expr);
    if (!tokens || tokens.length === 0) return null;

    let pos = 0;

    const parseBitOr = (): number | null => {
        let left = parseBitXor();
        if (left === null) return null;
        while (pos < tokens.length && tokens[pos].type === 'op' && tokens[pos].value === '|') {
            pos++;
            const right = parseBitXor();
            if (right === null) return null;
            left = left | right;
        }
        return left;
    };

    const parseBitXor = (): number | null => {
        let left = parseBitAnd();
        if (left === null) return null;
        while (pos < tokens.length && tokens[pos].type === 'op' && tokens[pos].value === '^') {
            pos++;
            const right = parseBitAnd();
            if (right === null) return null;
            left = left ^ right;
        }
        return left;
    };

    const parseBitAnd = (): number | null => {
        let left = parseShift();
        if (left === null) return null;
        while (pos < tokens.length && tokens[pos].type === 'op' && tokens[pos].value === '&') {
            pos++;
            const right = parseShift();
            if (right === null) return null;
            left = left & right;
        }
        return left;
    };

    const parseShift = (): number | null => {
        let left = parseAddSub();
        if (left === null) return null;
        while (pos < tokens.length && tokens[pos].type === 'op' && (tokens[pos].value === '<<' || tokens[pos].value === '>>')) {
            const op = tokens[pos++].value;
            const right = parseAddSub();
            if (right === null) return null;
            left = op === '<<' ? (left << right) : (left >> right);
        }
        return left;
    };

    const parseAddSub = (): number | null => {
        let left = parseMulDiv();
        if (left === null) return null;
        while (pos < tokens.length && tokens[pos].type === 'op' && (tokens[pos].value === '+' || tokens[pos].value === '-')) {
            const op = tokens[pos++].value;
            const right = parseMulDiv();
            if (right === null) return null;
            left = op === '+' ? left + right : left - right;
        }
        return left;
    };

    const parseMulDiv = (): number | null => {
        let left = parseUnary();
        if (left === null) return null;
        while (pos < tokens.length && tokens[pos].type === 'op' && (tokens[pos].value === '*' || tokens[pos].value === '/')) {
            const op = tokens[pos++].value;
            const right = parseUnary();
            if (right === null) return null;
            if (op === '/' && right === 0) return null;
            left = op === '*' ? left * right : Math.trunc(left / right);
        }
        return left;
    };

    const parseUnary = (): number | null => {
        if (pos < tokens.length && tokens[pos].type === 'op') {
            const op = tokens[pos].value;
            if (op === '+' || op === '-' || op === '~' || op === '<' || op === '>') {
                pos++;
                const inner = parseUnary();
                if (inner === null) return null;
                switch (op) {
                    case '+': return inner;
                    case '-': return -inner;
                    case '~': return ~inner;
                    case '<': return inner & 0xFF;
                    case '>': return (inner >> 8) & 0xFF;
                }
            }
        }
        return parsePrimary();
    };

    const parsePrimary = (): number | null => {
        if (pos >= tokens.length) return null;
        const tok = tokens[pos];
        if (tok.type === 'num' && tok.numValue !== undefined) {
            pos++;
            return tok.numValue;
        }
        if (tok.type === 'ident' && resolveIdent) {
            pos++;
            return resolveIdent(tok.value);
        }
        if (tok.type === 'sizeof' && resolveSizeof) {
            pos++;
            return resolveSizeof(tok.value);
        }
        if (tok.type === 'unary_fn') {
            pos++;
            if (pos >= tokens.length || tokens[pos].type !== 'lparen') return null;
            pos++;
            const inner = parseBitOr();
            if (inner === null || pos >= tokens.length || tokens[pos].type !== 'rparen') {
                return null;
            }
            pos++;
            switch (tok.value) {
                case '.lobyte': return inner & 0xFF;
                case '.hibyte': return (inner >> 8) & 0xFF;
                case '.bankbyte': return (inner >> 16) & 0xFF;
                case '.loword': return inner & 0xFFFF;
                case '.hiword': return (inner >> 16) & 0xFFFF;
                default: return null;
            }
        }
        if (tok.type === 'lparen') {
            pos++;
            const inner = parseBitOr();
            if (inner === null || pos >= tokens.length || tokens[pos].type !== 'rparen') {
                return null;
            }
            pos++;
            return inner;
        }
        return null;
    };

    const result = parseBitOr();
    if (result === null || pos !== tokens.length || !Number.isFinite(result)) {
        return null;
    }
    return result;
}

/**
 * Splits a top-level trailing `, X` or `, Y` index suffix (outside parentheses and quotes).
 */
function splitIndexSuffix(operand: string): { base: string; indexReg?: 'X' | 'Y' | 'S' } {
    let parenDepth = 0;
    let bracketDepth = 0;
    let quote: '"' | "'" | null = null;
    let lastTopComma = -1;

    for (let i = 0; i < operand.length; i++) {
        const ch = operand[i];
        if (quote) {
            if (ch === quote) quote = null;
        } else if (ch === '"' || ch === "'") {
            quote = ch;
        } else if (ch === '(') {
            parenDepth++;
        } else if (ch === ')' && parenDepth > 0) {
            parenDepth--;
        } else if (ch === '[') {
            bracketDepth++;
        } else if (ch === ']' && bracketDepth > 0) {
            bracketDepth--;
        } else if (ch === ',' && parenDepth === 0 && bracketDepth === 0) {
            lastTopComma = i;
        }
    }

    if (lastTopComma >= 0) {
        const suffix = operand.slice(lastTopComma + 1).trim().toUpperCase();
        if (suffix === 'X' || suffix === 'Y' || suffix === 'S') {
            return { base: operand.slice(0, lastTopComma).trim(), indexReg: suffix };
        }
    }

    return { base: operand };
}

/**
 * Checks if `operand` begins with a matching `open` ... `close` group covering the
 * operand up to an optional trailing `, Y` / `, X` index suffix.
 */
function matchOuterDelimited(
    operand: string,
    open: '(' | '[',
    close: ')' | ']'
): { inside: string; trailing: string } | null {
    if (!operand.startsWith(open)) return null;
    let depth = 0;
    let quote: '"' | "'" | null = null;

    for (let i = 0; i < operand.length; i++) {
        const ch = operand[i];
        if (quote) {
            if (ch === quote) quote = null;
        } else if (ch === '"' || ch === "'") {
            quote = ch;
        } else if (ch === open) {
            depth++;
        } else if (ch === close) {
            depth--;
            if (depth === 0) {
                return {
                    inside: operand.slice(1, i).trim(),
                    trailing: operand.slice(i + 1).trim(),
                };
            }
        }
    }
    return null;
}

interface LineSource {
    line: number;
    minChar: number;
    joinedStart?: number;
    joinedEnd?: number;
}

interface LogicalLine {
    text: string;
    sources: LineSource[];
}

interface SizeEvalContext {
    document: TextDocument;
    symbolTable: SymbolTable | undefined;
    allSymbolTables: Map<string, SymbolTable>;
    includesGraph: IncludesGraph;
    implicitImports: boolean;
    binIncludeDirs?: string[];
    visitedEntities: Set<SymbolTableEntity>;
    visitedScopes: Set<Scope>;
    constCache?: Map<SymbolTableEntity, number | null>;
}

const DATA_DIRECTIVE_UNIT_BYTES: Record<string, number> = {
    '.byte': 1,
    '.byt': 1,
    '.lobytes': 1,
    '.hibytes': 1,
    '.bankbytes': 1,
    '.literal': 1,
    '.asciiz': 1,
    '.word': 2,
    '.addr': 2,
    '.dbyt': 2,
    '.faraddr': 3,
    '.dword': 4,
};

const STRUCT_FIELD_UNIT_BYTES: Record<string, number> = {
    '.byte': 1,
    '.byt': 1,
    '.word': 2,
    '.addr': 2,
    '.dbyt': 2,
    '.faraddr': 3,
    '.dword': 4,
};

const STRING_CAPABLE_DATA_DIRECTIVES = new Set([
    '.byte',
    '.byt',
    '.literal',
    '.asciiz',
]);

const NON_EMITTING_LABEL_DIRECTIVES = new Set([
    '.export',
    '.exportzp',
    '.global',
    '.globalzp',
    '.import',
    '.importzp',
    '.forceimport',
    '.condes',
    '.constructor',
    '.destructor',
    '.interruptor',
    '.debuginfo',
    '.list',
    '.listbytes',
    '.pagelen',
    '.pagelength',
    '.out',
    '.warning',
    '.error',
    '.fatal',
    '.assert',
    '.feature',
    '.case',
    '.smart',
    '.a8',
    '.a16',
    '.i8',
    '.i16',
    '.p02',
    '.pc02',
    '.p816',
    '.setcpu',
    '.pushcpu',
    '.popcpu',
    '.localchar',
    '.autoimport',
    '.referto',
    '.refto',
    '.fopt',
    '.fileopt',
    '.charmap',
    '.pushcharmap',
    '.popcharmap',
    '.pushseg',
    '.linecont',
]);

const STOP_SEGMENT_OR_SCOPE_DIRECTIVES = new Set([
    '.popseg',
    '.segment',
    '.code',
    '.data',
    '.rodata',
    '.zeropage',
    '.bss',
    '.endproc',
    '.endscope',
    '.end',
]);

const HAS_STRING_ESCAPES_RE = /^\s*\.feature\s+.*\bstring_escapes\b/im;
const LABEL_ASSIGNMENT_RE = /^\s*[a-zA-Z_@.][a-zA-Z0-9_]*\s*(?:=|:=|\.(?:equ|set)\b)/i;

function splitCommaArgsOutsideQuotes(text: string, allowEscapes: boolean = false): string[] {
    const parts: string[] = [];
    let start = 0;
    let quote = 0;
    let depth = 0;
    for (let i = 0; i < text.length; i++) {
        const c = text.charCodeAt(i);
        if (quote !== 0) {
            if (allowEscapes && c === 92 /* \ */) {
                i++;
                continue;
            }
            if (c === quote) {
                quote = 0;
            }
        } else if (c === 34 /* " */ || c === 39 /* ' */) {
            quote = c;
        } else if (c === 40 /* ( */) {
            depth++;
        } else if (c === 41 /* ) */ && depth > 0) {
            depth--;
        } else if (c === 44 /* , */ && depth === 0) {
            const seg = text.slice(start, i).trim();
            if (seg.length > 0) parts.push(seg);
            start = i + 1;
        }
    }
    const tail = text.slice(start).trim();
    if (tail.length > 0) parts.push(tail);
    return parts;
}

function measureQuotedStringBytes(quotedItem: string, allowEscapes: boolean): number {
    const raw = quotedItem.slice(1, -1);
    if (!allowEscapes || !raw.includes('\\')) {
        return raw.length;
    }
    let count = 0;
    for (let i = 0; i < raw.length; i++) {
        if (raw.charCodeAt(i) === 92 /* \ */ && i + 1 < raw.length) {
            const next = raw.charCodeAt(i + 1);
            if ((next === 120 /* x */ || next === 88 /* X */) && i + 3 < raw.length) {
                i += 3;
            } else {
                i += 1;
            }
        }
        count++;
    }
    return count;
}

function collectLogicalLines(
    document: TextDocument,
    startLine: number,
    endLine: number,
    firstLineMinChar: number = -1,
    stopAfterFirst: boolean = false,
    extendPastEndIfContinuing: boolean = false,
    cComments: boolean = true,
    lineContinuations: boolean = true
): LogicalLine[] {
    const result: LogicalLine[] = [];
    const docText = document.getText();
    const docLen = docText.length;
    const effectiveStart = Math.max(0, startLine);
    const maxLine = Math.min(endLine, document.lineCount - 1);
    const hardEndLine = document.lineCount - 1;
    if (effectiveStart > maxLine) {
        return result;
    }

    let inBlockComment = isInBlockCommentBeforeLine(document, effectiveStart, docText, cComments);
    let lineOffset = effectiveStart === 0 ? 0 : document.offsetAt({ line: effectiveStart, character: 0 });
    let currentText = '';
    let currentSources: LineSource[] = [];

    for (let line = effectiveStart; line <= hardEndLine && lineOffset <= docLen; line++) {
        if (line > maxLine && (!extendPastEndIfContinuing || currentSources.length === 0)) {
            break;
        }

        const nlIdx = docText.indexOf('\n', lineOffset);
        let lineEnd = nlIdx >= 0 ? nlIdx : docLen;
        if (lineEnd > lineOffset && docText.charCodeAt(lineEnd - 1) === 13 /* \r */) {
            lineEnd--;
        }

        const rawLine = docText.slice(lineOffset, lineEnd);
        lineOffset = nlIdx >= 0 ? nlIdx + 1 : docLen + 1;

        const stripped = stripCommentsInLine(rawLine, inBlockComment, cComments);
        inBlockComment = stripped.inBlockComment;

        const trimmed = stripped.code.trimEnd();
        const continues = doesStrippedLineContinue(stripped, lineContinuations);
        const isBackslashCont = lineContinuations && !stripped.hasSemicolonComment && !inBlockComment && trimmed.endsWith('\\');
        const piece = isBackslashCont ? trimmed.slice(0, -1) : trimmed;

        if (piece.trim().length > 0) {
            const joinedStart = currentText.length === 0 ? 0 : currentText.length + 1;
            currentText = currentText.length === 0 ? piece : `${currentText} ${piece}`;
            currentSources.push({
                line,
                minChar: line === effectiveStart ? firstLineMinChar : -1,
                joinedStart,
                joinedEnd: currentText.length,
            });
        }

        if (!continues) {
            if (currentSources.length > 0) {
                result.push({ text: currentText, sources: currentSources });
                if (stopAfterFirst) {
                    return result;
                }
                currentText = '';
                currentSources = [];
            } else if (stopAfterFirst && line >= effectiveStart) {
                // Keep scanning only if a pure block comment ended before any code was seen?
                // Caller expects the logical statement starting at effectiveStart, so return empty if blank.
                if (line > effectiveStart || rawLine.trim().length === 0) {
                    return result;
                }
            }
            if (line >= maxLine) {
                break;
            }
        }
    }

    if (currentSources.length > 0) {
        result.push({ text: currentText, sources: currentSources });
    }
    return result;
}

function resolveEntityByName(
    identName: string,
    line: number,
    context: ReferenceInfo['context'],
    symbolTable: SymbolTable,
    allSymbolTables: Map<string, SymbolTable>,
    includesGraph: IncludesGraph
): SymbolTableEntity | undefined {
    const parts = identName.split('::');
    const leaf = parts[parts.length - 1];
    const quals = parts.slice(0, -1);

    const startScope = symbolTable.getScopeAtPosition({ line, character: 0 }) ?? symbolTable.getRootScope();
    const localFound = startScope.findDefinitionOrImport(leaf, quals, context);
    if (localFound) {
        return localFound instanceof Import
            ? resolveImport(localFound.name, allSymbolTables, includesGraph)
            : localFound;
    }

    for (const uri of includesGraph.getTranslationUnit(symbolTable.uri)) {
        if (uri === symbolTable.uri) continue;
        const st = allSymbolTables.get(uri);
        if (!st) continue;
        const found = st.getRootScope().findDefinitionOrImport(leaf, quals, context);
        if (found) {
            return found instanceof Import
                ? resolveImport(found.name, allSymbolTables, includesGraph)
                : found;
        }
    }

    if (quals.length === 0 && (context === 'symbol' || context === 'macro')) {
        for (const uri of includesGraph.getTranslationUnit(symbolTable.uri)) {
            const macro = allSymbolTables.get(uri)?.getMacro(leaf);
            if (macro && macro.kind === MacroKind.Define && macro.params.length === 0) {
                return macro;
            }
        }
    }

    return undefined;
}

function resolveIdentOnLine(
    identName: string,
    line: number,
    minChar: number,
    symbolTable: SymbolTable | undefined,
    allSymbolTables: Map<string, SymbolTable>,
    includesGraph: IncludesGraph,
    implicitImports: boolean,
    context: ReferenceInfo['context'] = 'symbol'
): SymbolTableEntity | undefined {
    if (!symbolTable) return undefined;
    const parts = identName.split('::');
    const leaf = parts[parts.length - 1];
    const quals = parts.slice(0, -1);

    const lineRefs = symbolTable.getReferencesOnLine(line);
    const matchRef = lineRefs.find((r: ReferenceInfo) => {
        if (r.location.start.character <= minChar || r.name !== leaf) return false;
        if (quals.length > 0 && (r.qualifiers.length !== quals.length || r.qualifiers.join('::') !== quals.join('::'))) {
            return false;
        }
        return true;
    });
    if (matchRef) {
        const resolved = resolveReference(matchRef, allSymbolTables, includesGraph, implicitImports);
        if (resolved && !(resolved instanceof Import)) {
            return resolved;
        }
    }

    return resolveEntityByName(identName, line, context, symbolTable, allSymbolTables, includesGraph);
}

function resolveEntityOnSources(
    identName: string,
    sources: readonly LineSource[],
    context: ReferenceInfo['context'],
    symbolTable: SymbolTable | undefined,
    allSymbolTables: Map<string, SymbolTable>,
    includesGraph: IncludesGraph,
    implicitImports: boolean
): SymbolTableEntity | undefined {
    if (!symbolTable || sources.length === 0) return undefined;
    for (const src of sources) {
        const resolved = resolveIdentOnLine(
            identName,
            src.line,
            src.minChar,
            symbolTable,
            allSymbolTables,
            includesGraph,
            implicitImports,
            context
        );
        if (resolved) return resolved;
    }
    return undefined;
}

function evaluateNumericExprOnSources(
    expr: string,
    sources: readonly LineSource[],
    ctx: SizeEvalContext
): number | null {
    return tryEvaluateNumericExpr(
        expr,
        (identName) => {
            const target = resolveEntityOnSources(
                identName,
                sources,
                'symbol',
                ctx.symbolTable,
                ctx.allSymbolTables,
                ctx.includesGraph,
                ctx.implicitImports
            );
            if (!target) return null;
            return tryResolveLocalConstantValue(
                target,
                ctx.document,
                ctx.symbolTable!,
                ctx.allSymbolTables,
                ctx.includesGraph,
                ctx.implicitImports,
                ctx.visitedEntities,
                ctx.constCache,
                ctx.visitedScopes,
                ctx.binIncludeDirs
            );
        },
        (sizeofTargetName) => {
            const target = resolveEntityOnSources(
                sizeofTargetName,
                sources,
                'sizeof',
                ctx.symbolTable,
                ctx.allSymbolTables,
                ctx.includesGraph,
                ctx.implicitImports
            );
            if (!target) return null;
            if (target instanceof Scope) {
                return evaluateStructOrUnionSize(target, ctx);
            }
            if (target instanceof Symbol && isLabelSymbolKind(target.kind)) {
                const targetDoc = getCachedTextDocumentSync(target.uri, ctx.document);
                const targetSymTable = ctx.allSymbolTables.get(target.uri);
                if (!targetDoc || !targetSymTable) return null;
                return evaluateLabelSizeInternal(target, {
                    ...ctx,
                    document: targetDoc,
                    symbolTable: targetSymTable,
                });
            }
            return null;
        }
    );
}

function evaluateStructMemberDirectiveBytes(
    dirToken: string,
    dirArgs: string,
    sources: readonly LineSource[],
    ctx: SizeEvalContext
): number | null {
    if (dirToken === '.res') {
        const parts = splitCommaArgsOutsideQuotes(dirArgs);
        if (parts.length === 0) return null;
        const val = evaluateNumericExprOnSources(parts[0], sources, ctx);
        return val !== null && Number.isFinite(val) && val >= 0 ? val : null;
    }

    if (dirToken === '.tag') {
        const targetName = dirArgs.split(/\s+/)[0] ?? '';
        if (!targetName || !ctx.symbolTable) return null;
        const target = resolveEntityOnSources(
            targetName,
            sources,
            'scope',
            ctx.symbolTable,
            ctx.allSymbolTables,
            ctx.includesGraph,
            ctx.implicitImports
        );
        if (!(target instanceof Scope)) return null;
        return evaluateStructOrUnionSize(target, ctx);
    }

    const unitBytes = STRUCT_FIELD_UNIT_BYTES[dirToken];
    if (unitBytes === undefined) {
        return null;
    }
    if (!dirArgs) {
        return unitBytes;
    }
    const parts = splitCommaArgsOutsideQuotes(dirArgs);
    if (parts.length === 0) return null;
    const countVal = evaluateNumericExprOnSources(parts[0], sources, ctx);
    return countVal !== null && Number.isFinite(countVal) && countVal >= 0
        ? unitBytes * countVal
        : null;
}

function evaluateStructOrUnionSize(scope: Scope, ctx: SizeEvalContext): number | null {
    if (scope.kind !== ScopeKind.Struct && scope.kind !== ScopeKind.Union) {
        return null;
    }
    if (ctx.visitedScopes.has(scope)) {
        return null;
    }
    const scopeDoc = getCachedTextDocumentSync(scope.uri, ctx.document);
    const scopeSymTable = ctx.allSymbolTables.get(scope.uri);
    if (!scopeDoc || !scopeSymTable) {
        return null;
    }

    ctx.visitedScopes.add(scope);
    try {
        const scopeCtx: SizeEvalContext = {
            ...ctx,
            document: scopeDoc,
            symbolTable: scopeSymTable,
        };
        const logicalLines = collectLogicalLines(
            scopeDoc,
            scope.definition.start.line + 1,
            scope.range.end.line - 1
        );
        const frames: Array<{ kind: ScopeKind.Struct | ScopeKind.Union; size: number }> = [
            { kind: scope.kind, size: 0 },
        ];

        const addMemberSize = (memberSize: number) => {
            const top = frames[frames.length - 1];
            top.size = top.kind === ScopeKind.Struct
                ? top.size + memberSize
                : Math.max(top.size, memberSize);
        };

        for (const logical of logicalLines) {
            const parsed = parseLine(logical.text);
            if (!parsed.command) continue;

            let dirToken: string;
            let dirArgs: string;
            let minChar: number;
            if (parsed.command.text.startsWith('.')) {
                dirToken = parsed.command.text.toLowerCase();
                dirArgs = parsed.args?.text.trim() ?? '';
                minChar = parsed.command.index + parsed.command.text.length;
            } else {
                const rest = parsed.args?.text.trim() ?? '';
                const sub = parseLine(rest);
                if (!sub.command || !sub.command.text.startsWith('.')) {
                    return null;
                }
                dirToken = sub.command.text.toLowerCase();
                dirArgs = sub.args?.text.trim() ?? '';
                minChar = parsed.command.index + parsed.command.text.length;
            }

            if (dirToken === '.struct' || dirToken === '.union') {
                frames.push({
                    kind: dirToken === '.struct' ? ScopeKind.Struct : ScopeKind.Union,
                    size: 0,
                });
                continue;
            }
            if (dirToken === '.endstruct' || dirToken === '.endunion') {
                const expected = dirToken === '.endstruct' ? ScopeKind.Struct : ScopeKind.Union;
                if (frames.length <= 1 || frames[frames.length - 1].kind !== expected) {
                    return null;
                }
                const finished = frames.pop()!;
                addMemberSize(finished.size);
                continue;
            }

            const adjustedSources = logical.sources.map((s, idx) =>
                idx === 0 ? { line: s.line, minChar } : s
            );

            const memberSize = evaluateStructMemberDirectiveBytes(dirToken, dirArgs, adjustedSources, scopeCtx);
            if (memberSize === null) return null;
            addMemberSize(memberSize);
        }

        return frames.length === 1 ? frames[0].size : null;
    } finally {
        ctx.visitedScopes.delete(scope);
    }
}

function tryResolveLocalConstantValue(
    entity: SymbolTableEntity,
    document: TextDocument,
    symbolTable: SymbolTable,
    allSymbolTables: Map<string, SymbolTable>,
    includesGraph: IncludesGraph,
    implicitImports: boolean,
    visited: Set<SymbolTableEntity>,
    constCache?: Map<SymbolTableEntity, number | null>,
    visitedScopes: Set<Scope> = new Set(),
    binIncludeDirs?: string[]
): number | null {
    if (constCache && constCache.has(entity)) {
        return constCache.get(entity) ?? null;
    }
    if (visited.has(entity)) {
        return null;
    }

    const targetDoc = getCachedTextDocumentSync(entity.uri, document);
    const targetSymTable = allSymbolTables.get(entity.uri) ?? (entity.uri === symbolTable.uri ? symbolTable : undefined);
    if (!targetDoc || !targetSymTable) {
        return null;
    }

    const ctx: SizeEvalContext = {
        document: targetDoc,
        symbolTable: targetSymTable,
        allSymbolTables,
        includesGraph,
        implicitImports,
        binIncludeDirs,
        visitedEntities: visited,
        visitedScopes,
        constCache,
    };

    if (entity instanceof Macro) {
        if (entity.kind !== MacroKind.Define || entity.params.length > 0) {
            return null;
        }
        visited.add(entity);
        try {
            const defLine = entity.definition.start.line;
            if (defLine < 0 || defLine >= targetDoc.lineCount) {
                constCache?.set(entity, null);
                return null;
            }
            const logical = collectLogicalLines(
                targetDoc,
                defLine,
                targetDoc.lineCount - 1,
                entity.definition.end.character,
                true
            )[0];
            if (!logical) {
                constCache?.set(entity, null);
                return null;
            }
            const defMatch = logical.text.match(/^\s*\.define\s+[a-zA-Z_][a-zA-Z0-9_]*\s+(.+)$/i);
            if (!defMatch) {
                constCache?.set(entity, null);
                return null;
            }
            const rhs = defMatch[1].trim();
            const resolvedVal = evaluateNumericExprOnSources(rhs, logical.sources, ctx);
            constCache?.set(entity, resolvedVal);
            return resolvedVal;
        } finally {
            visited.delete(entity);
        }
    }

    if (
        !(entity instanceof Symbol)
        || (
            entity.kind !== SymbolKind.Constant
            && entity.kind !== SymbolKind.Variable
            && entity.kind !== SymbolKind.EnumMember
        )
    ) {
        return null;
    }

    visited.add(entity);
    try {
        const defLine = entity.definition.start.line;
        if (defLine < 0 || defLine >= targetDoc.lineCount) {
            constCache?.set(entity, null);
            return null;
        }

        if (entity.kind === SymbolKind.EnumMember && entity.scope?.kind === ScopeKind.Enum) {
            let nextVal: number | null = 0;
            for (const member of entity.scope.getSymbols()) {
                const mLine = member.definition.start.line;
                if (mLine >= 0 && mLine < targetDoc.lineCount) {
                    const mLogical = collectLogicalLines(
                        targetDoc,
                        mLine,
                        targetDoc.lineCount - 1,
                        member.definition.end.character,
                        true
                    )[0];
                    if (mLogical && mLogical.sources[0]?.line === mLine) {
                        const mAfter = mLogical.text.slice(member.definition.end.character);
                        const mEq = mAfter.match(/^\s*=\s*(.+)$/);
                        if (mEq) {
                            nextVal = evaluateNumericExprOnSources(
                                mEq[1].trim(),
                                mLogical.sources,
                                ctx
                            );
                        }
                    }
                }
                if (member === entity) {
                    constCache?.set(entity, nextVal);
                    return nextVal;
                }
                if (nextVal !== null) {
                    nextVal++;
                }
            }
            constCache?.set(entity, null);
            return null;
        }

        const logical = collectLogicalLines(
            targetDoc,
            defLine,
            targetDoc.lineCount - 1,
            entity.definition.end.character,
            true
        )[0];
        if (!logical || logical.sources[0]?.line !== defLine) {
            constCache?.set(entity, null);
            return null;
        }
        const afterDef = logical.text.slice(entity.definition.end.character);
        const rhsCandidate = splitCommaArgsOutsideQuotes(afterDef)[0] ?? '';
        const eqMatch = rhsCandidate.match(/^\s*(?:=|:=|\.(?:equ|set))\s*(.+)$/i);
        if (!eqMatch) {
            constCache?.set(entity, null);
            return null;
        }

        const rhs = eqMatch[1].trim();
        const resolvedVal = evaluateNumericExprOnSources(rhs, logical.sources, ctx);
        constCache?.set(entity, resolvedVal);
        return resolvedVal;
    } finally {
        visited.delete(entity);
    }
}

/**
 * Evaluates a constant symbol's numeric value within its defining document if statically resolvable.
 */
export function evaluateConstantEntity(
    entity: SymbolTableEntity,
    document: TextDocument,
    symbolTable: SymbolTable,
    allSymbolTables: Map<string, SymbolTable>,
    includesGraph: IncludesGraph,
    implicitImports: boolean
): number | null {
    return tryResolveLocalConstantValue(
        entity,
        document,
        symbolTable,
        allSymbolTables,
        includesGraph,
        implicitImports,
        new Set()
    );
}

function evaluateLabelSpanSize(
    startLine: number,
    endLine: number,
    defEndChar: number,
    stopAtAnyLabel: boolean,
    ctx: SizeEvalContext
): number | null {
    if (startLine < 0 || startLine > endLine) {
        return null;
    }

    const logicalLines = collectLogicalLines(
        ctx.document,
        startLine,
        endLine,
        defEndChar
    );

    let totalBytes = 0;
    let sawData = false;
    let sawTrailingAlign = false;
    let checkedStringEscapes: boolean | undefined;
    const repeatStack: number[] = [];

    const hasStringEscapes = (): boolean => {
        if (checkedStringEscapes === undefined) {
            checkedStringEscapes = HAS_STRING_ESCAPES_RE.test(ctx.document.getText());
        }
        return checkedStringEscapes;
    };

    for (const logical of logicalLines) {
        const parsed = parseLine(logical.text);
        const isFirstLine = logical.sources[0].line === startLine;

        if (!isFirstLine && parsed.label !== undefined && parsed.label.text !== '') {
            if (stopAtAnyLabel || !parsed.label.text.startsWith('@')) {
                break;
            }
        }

        if (!parsed.command) {
            continue;
        }

        const cmd = parsed.command.text.toLowerCase();
        if (!cmd.startsWith('.') && LABEL_ASSIGNMENT_RE.test(
            isFirstLine && parsed.label
                ? logical.text.slice(defEndChar).replace(/^\s*:?\s*/, '')
                : logical.text
        )) {
            continue;
        }

        if (NON_EMITTING_LABEL_DIRECTIVES.has(cmd)) {
            continue;
        }

        if (STOP_SEGMENT_OR_SCOPE_DIRECTIVES.has(cmd)) {
            if (!sawData || repeatStack.length > 0) return null;
            break;
        }

        if (cmd === '.align') {
            if (!sawData || repeatStack.length > 0) return null;
            sawTrailingAlign = true;
            continue;
        }

        if (sawTrailingAlign) {
            return null;
        }

        const argsText = parsed.args?.text.trim() ?? '';

        if (cmd === '.repeat' || cmd === '.rep') {
            const parts = splitCommaArgsOutsideQuotes(argsText);
            if (parts.length === 0) return null;
            const repVal = evaluateNumericExprOnSources(parts[0], logical.sources, ctx);
            if (repVal === null || !Number.isFinite(repVal) || repVal < 0) {
                return null;
            }
            repeatStack.push(Math.floor(repVal));
            continue;
        }

        if (cmd === '.endrepeat' || cmd === '.endrep') {
            if (repeatStack.length === 0) {
                if (!sawData) return null;
                break;
            }
            repeatStack.pop();
            continue;
        }

        let mult = 1;
        for (const r of repeatStack) {
            mult *= r;
        }

        if (cmd === '.res') {
            const parts = splitCommaArgsOutsideQuotes(argsText);
            if (parts.length === 0) return null;
            const countVal = evaluateNumericExprOnSources(parts[0], logical.sources, ctx);
            if (countVal === null || !Number.isFinite(countVal) || countVal < 0) {
                return null;
            }
            totalBytes += countVal * mult;
            sawData = true;
            continue;
        }

        if (cmd === '.tag') {
            const structName = argsText.split(/\s+/)[0] ?? '';
            if (!structName) return null;
            const target = resolveEntityOnSources(
                structName,
                logical.sources,
                'scope',
                ctx.symbolTable,
                ctx.allSymbolTables,
                ctx.includesGraph,
                ctx.implicitImports
            );
            if (!(target instanceof Scope)) return null;
            const tagSize = evaluateStructOrUnionSize(target, ctx);
            if (tagSize === null) return null;
            totalBytes += tagSize * mult;
            sawData = true;
            continue;
        }

        if (cmd === '.incbin') {
            const parts = splitCommaArgsOutsideQuotes(argsText);
            if (parts.length === 0) return null;
            if (parts.length >= 3) {
                const countVal = evaluateNumericExprOnSources(parts[2], logical.sources, ctx);
                if (countVal === null || !Number.isFinite(countVal) || countVal < 0) {
                    return null;
                }
                totalBytes += countVal * mult;
                sawData = true;
                continue;
            }
            if (!isSimpleQuotedString(parts[0])) return null;
            const filename = parts[0].slice(1, -1);
            const offsetVal = parts.length >= 2
                ? evaluateNumericExprOnSources(parts[1], logical.sources, ctx)
                : 0;
            if (offsetVal === null || !Number.isFinite(offsetVal) || offsetVal < 0) {
                return null;
            }
            const fileSize = resolveIncbinFileSizeSync(ctx.document.uri, filename, ctx.binIncludeDirs);
            if (fileSize === null || offsetVal > fileSize) {
                return null;
            }
            totalBytes += (fileSize - offsetVal) * mult;
            sawData = true;
            continue;
        }

        const unitBytes = DATA_DIRECTIVE_UNIT_BYTES[cmd];
        if (unitBytes !== undefined) {
            const allowEscapes = STRING_CAPABLE_DATA_DIRECTIVES.has(cmd) && argsText.includes('\\') && hasStringEscapes();
            const items = splitCommaArgsOutsideQuotes(argsText, allowEscapes);
            if (items.length === 0) return null;
            let lineBytes = 0;
            for (const item of items) {
                if (STRING_CAPABLE_DATA_DIRECTIVES.has(cmd) && isSimpleQuotedString(item, allowEscapes)) {
                    lineBytes += measureQuotedStringBytes(item, allowEscapes);
                } else {
                    lineBytes += unitBytes;
                }
            }
            if (cmd === '.asciiz') {
                lineBytes += 1;
            }
            totalBytes += lineBytes * mult;
            sawData = true;
            continue;
        }

        return null;
    }

    if (repeatStack.length > 0) {
        return null;
    }
    return sawData ? totalBytes : null;
}

function evaluateLabelSizeInternal(
    entity: SymbolTableEntity,
    ctx: SizeEvalContext
): number | null {
    if (ctx.visitedEntities.has(entity)) {
        return null;
    }
    ctx.visitedEntities.add(entity);
    try {
        return evaluateLabelSpanSize(
            entity.definition.start.line,
            Math.min(entity.range.end.line, ctx.document.lineCount - 1),
            entity.definition.end.character,
            false,
            ctx
        );
    } finally {
        ctx.visitedEntities.delete(entity);
    }
}

function createSizeEvalContext(
    document: TextDocument,
    symbolTable: SymbolTable | undefined,
    allSymbolTables: Map<string, SymbolTable>,
    includesGraph: IncludesGraph,
    implicitImports: boolean,
    binIncludeDirs?: string[]
): SizeEvalContext {
    return {
        document,
        symbolTable,
        allSymbolTables,
        includesGraph,
        implicitImports,
        binIncludeDirs,
        visitedEntities: new Set(),
        visitedScopes: new Set(),
    };
}

/**
 * Evaluates a label's total allocated/emitted byte size (`.res`, `.tag`, `.incbin`, `.byte`, `.lobytes`,
 * `.hibytes`, `.bankbytes`, `.word`, `.addr`, `.dbyt`, `.faraddr`, `.dword`, `.literal`, `.asciiz`, `.repeat`).
 */
export function evaluateLabelSize(
    entity: SymbolTableEntity,
    document: TextDocument,
    symbolTable: SymbolTable | undefined,
    allSymbolTables: Map<string, SymbolTable>,
    includesGraph: IncludesGraph,
    implicitImports: boolean,
    binIncludeDirs?: string[]
): number | null {
    return evaluateLabelSizeInternal(
        entity,
        createSizeEvalContext(document, symbolTable, allSymbolTables, includesGraph, implicitImports, binIncludeDirs)
    );
}

/**
 * Evaluates a cheap local label's total allocated/emitted byte size within `[defRange.start.line, endLine]`.
 */
export function evaluateLocationLabelSize(
    defRange: Range,
    endLine: number,
    document: TextDocument,
    symbolTable: SymbolTable | undefined,
    allSymbolTables: Map<string, SymbolTable>,
    includesGraph: IncludesGraph,
    implicitImports: boolean,
    binIncludeDirs?: string[]
): number | null {
    return evaluateLabelSpanSize(
        defRange.start.line,
        Math.min(endLine, document.lineCount - 1),
        defRange.end.character,
        true,
        createSizeEvalContext(document, symbolTable, allSymbolTables, includesGraph, implicitImports, binIncludeDirs)
    );
}

/**
 * Evaluates a `.struct` or `.union` scope's total byte size (`.sizeof(scope)`).
 */
export function evaluateScopeSize(
    scope: Scope,
    document: TextDocument,
    symbolTable: SymbolTable | undefined,
    allSymbolTables: Map<string, SymbolTable>,
    includesGraph: IncludesGraph,
    implicitImports: boolean,
    binIncludeDirs?: string[]
): number | null {
    return evaluateStructOrUnionSize(scope, {
        document,
        symbolTable,
        allSymbolTables,
        includesGraph,
        implicitImports,
        binIncludeDirs,
        visitedEntities: new Set(),
        visitedScopes: new Set(),
    });
}

export interface StructFieldHoverInfo {
    badge: string | null;
    count: number | null;
    totalBytes: number | null;
}

/**
 * Extracts a compact type badge, declared count, and total byte size for a `.struct` or `.union` field
 * (e.g. `byte`, `word`, `word ...[2]`, `...[4]` for `.res 4`, `Vec2`).
 */
export function evaluateStructFieldBadge(
    entity: SymbolTableEntity,
    document: TextDocument,
    symbolTable: SymbolTable | undefined,
    allSymbolTables: Map<string, SymbolTable>,
    includesGraph: IncludesGraph,
    implicitImports: boolean,
    binIncludeDirs?: string[]
): StructFieldHoverInfo | null {
    const line = entity.definition.start.line;
    if (line < 0 || line >= document.lineCount) return null;

    const logical = collectLogicalLines(
        document,
        line,
        document.lineCount - 1,
        entity.definition.end.character,
        true
    )[0];
    if (!logical) return null;

    const afterName = logical.text.slice(entity.definition.end.character).replace(/^\s*:?\s*/, '');
    const match = afterName.match(/^\.([a-zA-Z0-9_]+)(?:\s+(.+))?$/);
    if (!match) return null;

    const rawDir = match[1].toLowerCase();
    const dir = rawDir === 'byt' ? 'byte' : rawDir;
    const dirArgs = match[2]?.trim() ?? '';

    let badge: string | null;
    if (dir === 'res') {
        badge = null;
    } else if (dir === 'tag') {
        const tagTarget = dirArgs ? dirArgs.split(/\s+/)[0] : '';
        badge = tagTarget || null;
    } else {
        badge = dir;
    }

    const ctx = createSizeEvalContext(document, symbolTable, allSymbolTables, includesGraph, implicitImports, binIncludeDirs);
    let count: number | null = null;
    if (dir === 'res' || (STRUCT_FIELD_UNIT_BYTES[`.${dir}`] !== undefined && dirArgs)) {
        const parts = splitCommaArgsOutsideQuotes(dirArgs);
        if (parts.length > 0) {
            const val = evaluateNumericExprOnSources(parts[0], logical.sources, ctx);
            if (val !== null && Number.isFinite(val) && val >= 0) {
                count = val;
            }
        }
    }

    const totalBytes = evaluateStructMemberDirectiveBytes(`.${dir}`, dirArgs, logical.sources, ctx);
    return { badge, count, totalBytes };
}

function classifyEntityWidth(
    entity: SymbolTableEntity,
    document: TextDocument,
    symbolTable: SymbolTable,
    allSymbolTables: Map<string, SymbolTable>,
    includesGraph: IncludesGraph,
    implicitImports: boolean,
    visited: Set<SymbolTableEntity> = new Set(),
    constCache?: Map<SymbolTableEntity, number | null>
): AddressWidth {
    if (visited.has(entity)) return 'unknown';
    visited.add(entity);

    if (entity instanceof Import) {
        if (entity.isZeroPage) return 'zp';
        const resolved = resolveImport(entity.name, allSymbolTables, includesGraph);
        return resolved
            ? classifyEntityWidth(resolved, document, symbolTable, allSymbolTables, includesGraph, implicitImports, visited, constCache)
            : 'unknown';
    }

    if (entity.segment) {
        const ownerTable = allSymbolTables.get(entity.uri) ?? symbolTable;
        const addrSize = resolveSegmentAddrSize(entity.segment, ownerTable, allSymbolTables);
        if (addrSize === 'zp') return 'zp';
        if (addrSize === 'far') return 'far';
        return 'abs';
    }

    if (entity instanceof Symbol && entity.kind === SymbolKind.Constant) {
        const val = tryResolveLocalConstantValue(
            entity,
            document,
            symbolTable,
            allSymbolTables,
            includesGraph,
            implicitImports,
            new Set(),
            constCache
        );
        if (val !== null) {
            if (val >= 0 && val <= 0xFF) return 'zp';
            if (val > 0xFFFF && val <= 0xFFFFFF) return 'far';
            return 'abs';
        }
    }

    return 'unknown';
}

function collectRefsOnSources(
    symbolTable: SymbolTable | undefined,
    sources: readonly LineSource[]
): ReferenceInfo[] {
    if (!symbolTable) return [];
    const result: ReferenceInfo[] = [];
    for (const src of sources) {
        const lineRefs = symbolTable.getReferencesOnLine(src.line);
        for (let i = 0; i < lineRefs.length; i++) {
            const r = lineRefs[i];
            if (r.location.start.character > src.minChar) {
                result.push(r);
            }
        }
    }
    return result;
}

function sliceSourcesFromOffset(sources: readonly LineSource[], offset: number): LineSource[] {
    const out: LineSource[] = [];
    for (const src of sources) {
        const jStart = src.joinedStart ?? 0;
        const jEnd = src.joinedEnd ?? Number.MAX_SAFE_INTEGER;
        if (jEnd <= offset) continue;
        const localMin = offset > jStart ? (offset - jStart) - 1 : src.minChar;
        out.push({ line: src.line, minChar: localMin });
    }
    return out.length > 0 ? out : [{ line: sources[0].line, minChar: -1 }];
}

function createIdentValueResolver(
    operandSources: readonly LineSource[],
    document: TextDocument,
    symbolTable: SymbolTable | undefined,
    allSymbolTables: Map<string, SymbolTable>,
    includesGraph: IncludesGraph,
    implicitImports: boolean,
    constCache?: Map<SymbolTableEntity, number | null>
): ((identName: string) => number | null) | undefined {
    if (!symbolTable) return undefined;
    const lineRefs = collectRefsOnSources(symbolTable, operandSources);
    return (identName: string): number | null => {
        const ref = lineRefs.find(r => r.name === identName);
        if (!ref) return null;
        let resolved = resolveReference(ref, allSymbolTables, includesGraph, implicitImports);
        if (!resolved && ref.qualifiers.length === 0 && !identName.includes('::')) {
            for (const uri of includesGraph.getTranslationUnit(symbolTable.uri)) {
                const candidate = allSymbolTables.get(uri)?.getMacro(identName);
                if (candidate && candidate.kind === MacroKind.Define && candidate.params.length === 0) {
                    resolved = candidate;
                    break;
                }
            }
        }
        if (!resolved) return null;
        return tryResolveLocalConstantValue(
            resolved,
            document,
            symbolTable,
            allSymbolTables,
            includesGraph,
            implicitImports,
            new Set(),
            constCache
        );
    };
}

function classifyOperandWidth(
    baseExpr: string,
    operandSources: readonly LineSource[],
    document: TextDocument,
    symbolTable: SymbolTable | undefined,
    allSymbolTables: Map<string, SymbolTable>,
    includesGraph: IncludesGraph,
    implicitImports: boolean,
    constCache?: Map<SymbolTableEntity, number | null>
): AddressWidth {
    // Explicit ca65 address-size override (`z:`, `a:`, `f:`). Exclude `::` scope operator.
    const overrideMatch = baseExpr.match(/^([azfAZF]):(?!=)/);
    if (overrideMatch) {
        const prefix = overrideMatch[1].toLowerCase();
        if (prefix === 'z') return 'zp';
        if (prefix === 'a') return 'abs';
        if (prefix === 'f') return 'far';
    }

    const lineRefs = collectRefsOnSources(symbolTable, operandSources);
    const resolveIdentValue = createIdentValueResolver(
        operandSources,
        document,
        symbolTable,
        allSymbolTables,
        includesGraph,
        implicitImports,
        constCache
    );

    const evaluated = tryEvaluateNumericExpr(baseExpr, resolveIdentValue);
    if (evaluated !== null) {
        if (evaluated >= 0 && evaluated <= 0xFF) return 'zp';
        if (evaluated > 0xFFFF && evaluated <= 0xFFFFFF) return 'far';
        return 'abs';
    }

    // Fall back to resolved symbol segment / .importzp metadata if any identifier exists in baseExpr.
    if (symbolTable) {
        let sawZp = false;
        let sawAbs = false;
        let sawFar = false;
        let sawUnknown = false;
        let matchedAny = false;

        for (let i = 0; i < lineRefs.length; i++) {
            const ref = lineRefs[i];
            if (!baseExpr.includes(ref.name)) {
                continue;
            }
            matchedAny = true;
            const resolved = resolveReference(ref, allSymbolTables, includesGraph, implicitImports);
            if (!resolved) {
                sawUnknown = true;
                continue;
            }
            const width = classifyEntityWidth(
                resolved,
                document,
                symbolTable,
                allSymbolTables,
                includesGraph,
                implicitImports,
                new Set(),
                constCache
            );
            if (width === 'zp') sawZp = true;
            else if (width === 'far') sawFar = true;
            else if (width === 'abs') sawAbs = true;
            else sawUnknown = true;
        }

        if (matchedAny) {
            if (sawFar) return 'far';
            if (sawAbs) return 'abs';
            if (sawZp && !sawUnknown) return 'zp';
        }
    }

    return 'unknown';
}

function pickDirectOrZeroPageMode(
    modes: Record<string, MnemonicModeInfo>,
    indexReg?: 'X' | 'Y'
): string | undefined {
    const candidates = indexReg
        ? [`Direct page, ${indexReg}`, `Zero page, ${indexReg}`]
        : ['Direct page', 'Zero page'];
    return candidates.find(m => Boolean(modes[m]));
}

function resolveInstructionModes(
    modes: Record<string, MnemonicModeInfo>,
    modeCount: number,
    singleModeName: string,
    operand: string,
    operandSources: readonly LineSource[],
    document: TextDocument,
    symbolTable: SymbolTable | undefined,
    allSymbolTables: Map<string, SymbolTable>,
    includesGraph: IncludesGraph,
    implicitImports: boolean,
    constCache: Map<SymbolTableEntity, number | null>
): { modeA: string; modeB: string } {
    if (!operand) {
        if (modes['Implied']) return { modeA: 'Implied', modeB: '' };
        if (modes['Accumulator']) return { modeA: 'Accumulator', modeB: '' };
        return { modeA: '', modeB: '' };
    }

    if (modeCount === 1) {
        return { modeA: singleModeName, modeB: '' };
    }

    if (modes['Signature']) {
        return { modeA: 'Signature', modeB: '' };
    }

    if (/^[aA]$/.test(operand) && modes['Accumulator']) {
        return { modeA: 'Accumulator', modeB: '' };
    }

    if (operand.startsWith('#') && modes['Immediate']) {
        return { modeA: 'Immediate', modeB: '' };
    }

    const bracket = matchOuterDelimited(operand, '[', ']');
    if (bracket) {
        if (bracket.trailing === '') {
            if (modes['[Direct page]']) return { modeA: '[Direct page]', modeB: '' };
            if (modes['[Indirect long]']) return { modeA: '[Indirect long]', modeB: '' };
        } else if (/^,\s*[yY]$/.test(bracket.trailing) && modes['[Direct page], Y']) {
            return { modeA: '[Direct page], Y', modeB: '' };
        }
        return { modeA: '', modeB: '' };
    }

    const paren = matchOuterDelimited(operand, '(', ')');
    if (paren) {
        const innerSplit = splitIndexSuffix(paren.inside);
        if (paren.trailing === '') {
            if (innerSplit.indexReg === 'X') {
                if (modes['(Indirect, X)']) return { modeA: '(Indirect, X)', modeB: '' };
                if (modes['(Direct page, X)']) return { modeA: '(Direct page, X)', modeB: '' };
                if (modes['(Absolute, X)']) return { modeA: '(Absolute, X)', modeB: '' };
            } else if (!innerSplit.indexReg) {
                if (modes['Indirect']) return { modeA: 'Indirect', modeB: '' };
                if (modes['(Zero page)']) return { modeA: '(Zero page)', modeB: '' };
                if (modes['(Direct page)']) return { modeA: '(Direct page)', modeB: '' };
            }
        } else if (/^,\s*[yY]$/.test(paren.trailing)) {
            if (innerSplit.indexReg === 'S' && modes['(Stack relative, S), Y']) {
                return { modeA: '(Stack relative, S), Y', modeB: '' };
            }
            if (!innerSplit.indexReg) {
                if (modes['(Indirect), Y']) return { modeA: '(Indirect), Y', modeB: '' };
                if (modes['(Direct page), Y']) return { modeA: '(Direct page), Y', modeB: '' };
            }
        }
        return { modeA: '', modeB: '' };
    }

    const { base, indexReg } = splitIndexSuffix(operand);
    if (indexReg === 'S') {
        return modes['Stack relative']
            ? { modeA: 'Stack relative', modeB: '' }
            : { modeA: '', modeB: '' };
    }

    const zpMode = pickDirectOrZeroPageMode(modes, indexReg);
    const absCandidate = indexReg ? `Absolute, ${indexReg}` : 'Absolute';
    const absMode = modes[absCandidate] ? absCandidate : undefined;
    const farCandidate = indexReg === 'X' ? 'Absolute long, X' : (!indexReg ? 'Absolute long' : undefined);
    const farMode = farCandidate && modes[farCandidate] ? farCandidate : undefined;

    if (zpMode && absMode) {
        const width = classifyOperandWidth(
            base,
            operandSources,
            document,
            symbolTable,
            allSymbolTables,
            includesGraph,
            implicitImports,
            constCache
        );
        if (width === 'zp') return { modeA: zpMode, modeB: '' };
        if (width === 'far' && farMode) return { modeA: farMode, modeB: '' };
        if (width === 'abs' || width === 'far') return { modeA: absMode, modeB: '' };
        return { modeA: zpMode, modeB: absMode };
    }

    if (absMode && farMode) {
        const width = classifyOperandWidth(
            base,
            operandSources,
            document,
            symbolTable,
            allSymbolTables,
            includesGraph,
            implicitImports,
            constCache
        );
        return { modeA: width === 'far' ? farMode : absMode, modeB: '' };
    }

    if (zpMode) return { modeA: zpMode, modeB: '' };
    if (absMode) return { modeA: absMode, modeB: '' };
    if (farMode) return { modeA: farMode, modeB: '' };
    return { modeA: '', modeB: '' };
}

interface ModeMetrics {
    minBytes: number;
    maxBytes: number;
    minCycles: number;
    maxCycles: number;
    hasBranchPenalty: boolean;
    hasPagePenalty: boolean;
    hasVariableWidth16: boolean;
    hasDpOffsetPenalty: boolean;
    hasEmulationPagePenalty: boolean;
    hasPerByteCycles: boolean;
}

/**
 * Extracts the leading opcode hex byte from a parsed `.lst` bytes string (excluding `.res` `xx` placeholders).
 */
function extractOpcodeHex(bytesText: string): string | null {
    const trimmed = bytesText.trim();
    if (trimmed.length < 2) return null;
    const spaceIdx = trimmed.indexOf(' ');
    const firstToken = spaceIdx === -1 ? trimmed : trimmed.slice(0, spaceIdx);
    if (!/^[0-9a-fA-F]{2}$/.test(firstToken)) return null;
    return firstToken.toUpperCase();
}

/**
 * Matches a mnemonic's candidate modes against the assembled opcode byte and byte count from `ca65 -l`.
 */
function resolveModeFromLst(
    modes: Record<string, MnemonicModeInfo>,
    lstInfo: LstLineInfo
): string | undefined {
    const opcodeHex = extractOpcodeHex(lstInfo.bytesText);
    if (!opcodeHex) return undefined;

    let varWidthMatch: string | undefined;
    let imm3ByteMatch: string | undefined;

    for (const [modeName, info] of Object.entries(modes)) {
        if (info.opcode.toUpperCase() !== opcodeHex) continue;
        if (lstInfo.byteCount === info.bytes) {
            return modeName;
        }
        if (
            (info.byteVariableM || info.byteVariableX)
            && lstInfo.byteCount === info.bytes + 1
            && !varWidthMatch
        ) {
            varWidthMatch = modeName;
        }
        if (
            modeName === 'Immediate'
            && lstInfo.byteCount === info.bytes + 1
            && !imm3ByteMatch
        ) {
            imm3ByteMatch = modeName;
        }
    }

    return varWidthMatch ?? imm3ByteMatch;
}

function computeModeMetrics(
    modeName: string,
    info: MnemonicModeInfo,
    operand: string,
    operandSources: readonly LineSource[],
    document: TextDocument,
    symbolTable: SymbolTable | undefined,
    allSymbolTables: Map<string, SymbolTable>,
    includesGraph: IncludesGraph,
    implicitImports: boolean,
    constCache: Map<SymbolTableEntity, number | null>,
    lstInfo?: LstLineInfo
): ModeMetrics {
    const varByte = (info.byteVariableM || info.byteVariableX) ? 1 : 0;
    const varCycle = (info.cycleVariableM ?? 0) + (info.cycleVariableX ?? 0);
    let widthKnown8 = false;
    let narrowed16 = false;
    let byteCountOverride: number | undefined;

    if (lstInfo && modeName === 'Immediate') {
        if (varByte) {
            if (lstInfo.byteCount === info.bytes) {
                widthKnown8 = true;
            } else if (lstInfo.byteCount === info.bytes + 1) {
                narrowed16 = true;
            }
        } else if (lstInfo.byteCount === info.bytes + 1) {
            // Inline `.p816` + `.a16`/`.i16` inside a non-65816 config still emits 3 immediate bytes
            byteCountOverride = lstInfo.byteCount;
        }
    }

    if (!widthKnown8 && !narrowed16 && varByte && modeName === 'Immediate' && operand.startsWith('#')) {
        const resolveIdentValue = createIdentValueResolver(
            operandSources,
            document,
            symbolTable,
            allSymbolTables,
            includesGraph,
            implicitImports,
            constCache
        );
        const immVal = tryEvaluateNumericExpr(operand.slice(1).trim(), resolveIdentValue);
        if (immVal !== null && immVal > 0xFF) {
            narrowed16 = true;
        }
    }

    const extraFixedCycles = (info.branchPenalty ? 1 : 0)
        + (info.pagePenalty ? 1 : 0)
        + (info.pageOrIndex16Penalty ? 1 : 0)
        + (info.nativeModeCyclePenalty ?? 0);

    const minBytes = byteCountOverride ?? (info.bytes + (narrowed16 ? 1 : 0));
    const maxBytes = byteCountOverride ?? (widthKnown8 ? info.bytes : info.bytes + varByte);
    const minCycles = info.cycles + (narrowed16 ? varCycle : 0);
    const maxCycles = info.cycles + extraFixedCycles + (widthKnown8 ? 0 : varCycle);

    return {
        minBytes,
        maxBytes,
        minCycles,
        maxCycles,
        hasBranchPenalty: Boolean(info.branchPenalty),
        hasPagePenalty: Boolean(info.pagePenalty || info.pageOrIndex16Penalty),
        hasVariableWidth16: !widthKnown8 && !narrowed16 && (varByte > 0 || varCycle > 0),
        hasDpOffsetPenalty: Boolean(info.dpNonZeroPenalty),
        hasEmulationPagePenalty: Boolean(info.emulationOnlyPagePenalty),
        hasPerByteCycles: Boolean(info.perByteCycles),
    };
}

/**
 * Analyzes assembly instructions within a document range for the active CPU target
 * and returns byte and cycle estimates.
 */
export function analyzeInstructionRange(
    document: TextDocument,
    range: Range,
    symbolTable: SymbolTable | undefined,
    allSymbolTables: Map<string, SymbolTable>,
    includesGraph: IncludesGraph,
    implicitImports: boolean,
    cpu?: unknown,
    cComments: boolean = true,
    lineContinuations: boolean = true,
    lstLines?: ReadonlyMap<number, LstLineInfo>
): InstructionAnalysisSummary {
    const normalizedCpu = normalizeCpu(cpu);
    const startLine = Math.max(0, range.start.line);
    let endLine = Math.min(document.lineCount - 1, range.end.line);
    if (endLine > startLine && range.end.character === 0) {
        endLine--;
    }

    const items: InstructionAnalysisItem[] = [];
    let minBytes = 0;
    let maxBytes = 0;
    let minCycles = 0;
    let maxCycles = 0;
    let uncertainCount = 0;
    let usedListing = false;
    let hasBranchPenalty = false;
    let hasPagePenalty = false;
    let hasVariableWidth16 = false;
    let hasDpOffsetPenalty = false;
    let hasEmulationPagePenalty = false;
    let hasPerByteCycles = false;

    const constCache = new Map<SymbolTableEntity, number | null>();
    const logicalLines = collectLogicalLines(document, startLine, endLine, -1, false, true, cComments, lineContinuations);

    for (const logical of logicalLines) {
        const lineNum = logical.sources[0].line;
        if (logical.text.trim().length === 0) {
            continue;
        }

        const parsed = parseLine(logical.text);
        if (!parsed.command || parsed.command.text.startsWith('.')) {
            continue;
        }

        const mnemonic = parsed.command.text.toUpperCase();
        const entry = getMnemonicInfo(mnemonic, normalizedCpu);
        if (!entry || !entry.modes) {
            continue;
        }

        const modes = entry.modes;
        let modeCount = 0;
        let singleModeName = '';
        for (const k in modes) {
            modeCount++;
            if (modeCount === 1) {
                singleModeName = k;
            } else {
                break;
            }
        }
        if (modeCount === 0) continue;

        const operand = parsed.args?.text.trim() ?? '';
        const operandOffset = parsed.args?.index ?? (parsed.command.index + parsed.command.text.length);
        const operandSources = sliceSourcesFromOffset(logical.sources, operandOffset);

        const lstInfo = lstLines?.get(lineNum);
        const lstMode = lstInfo ? resolveModeFromLst(modes, lstInfo) : undefined;
        const { modeA, modeB } = lstMode
            ? { modeA: lstMode, modeB: '' }
            : resolveInstructionModes(
                modes,
                modeCount,
                singleModeName,
                operand,
                operandSources,
                document,
                symbolTable,
                allSymbolTables,
                includesGraph,
                implicitImports,
                constCache
            );

        if (!modeA) {
            continue;
        }

        if (lstMode) {
            usedListing = true;
        }

        const metricsA = computeModeMetrics(
            modeA,
            modes[modeA],
            operand,
            operandSources,
            document,
            symbolTable,
            allSymbolTables,
            includesGraph,
            implicitImports,
            constCache,
            lstMode ? lstInfo : undefined
        );
        let instMinBytes = metricsA.minBytes;
        let instMaxBytes = metricsA.maxBytes;
        let instMinCycles = metricsA.minCycles;
        let instMaxCycles = metricsA.maxCycles;
        let instBranchPenalty = metricsA.hasBranchPenalty;
        let instPagePenalty = metricsA.hasPagePenalty;
        let instVarWidth16 = metricsA.hasVariableWidth16;
        let instDpPenalty = metricsA.hasDpOffsetPenalty;
        let instEmuPagePenalty = metricsA.hasEmulationPagePenalty;
        let instPerByteCycles = metricsA.hasPerByteCycles;
        let modeLabel = modeA;
        let uncertain = false;

        if (modeB) {
            const metricsB = computeModeMetrics(
                modeB,
                modes[modeB],
                operand,
                operandSources,
                document,
                symbolTable,
                allSymbolTables,
                includesGraph,
                implicitImports,
                constCache
            );
            uncertain = true;
            if (metricsB.minBytes < instMinBytes) instMinBytes = metricsB.minBytes;
            if (metricsB.maxBytes > instMaxBytes) instMaxBytes = metricsB.maxBytes;
            if (metricsB.minCycles < instMinCycles) instMinCycles = metricsB.minCycles;
            if (metricsB.maxCycles > instMaxCycles) instMaxCycles = metricsB.maxCycles;
            if (metricsB.hasBranchPenalty) instBranchPenalty = true;
            if (metricsB.hasPagePenalty) instPagePenalty = true;
            if (metricsB.hasVariableWidth16) instVarWidth16 = true;
            if (metricsB.hasDpOffsetPenalty) instDpPenalty = true;
            if (metricsB.hasEmulationPagePenalty) instEmuPagePenalty = true;
            if (metricsB.hasPerByteCycles) instPerByteCycles = true;
            modeLabel = `${modeA} / ${modeB}`;
        }

        if (uncertain) uncertainCount++;
        if (instBranchPenalty) hasBranchPenalty = true;
        if (instPagePenalty) hasPagePenalty = true;
        if (instVarWidth16) hasVariableWidth16 = true;
        if (instDpPenalty) hasDpOffsetPenalty = true;
        if (instEmuPagePenalty) hasEmulationPagePenalty = true;
        if (instPerByteCycles) hasPerByteCycles = true;

        minBytes += instMinBytes;
        maxBytes += instMaxBytes;
        minCycles += instMinCycles;
        maxCycles += instMaxCycles;

        items.push({
            line: lineNum,
            mnemonic,
            mode: modeLabel,
            minBytes: instMinBytes,
            maxBytes: instMaxBytes,
            minCycles: instMinCycles,
            maxCycles: instMaxCycles,
            bytesText: lstMode && lstInfo ? lstInfo.bytesText : undefined,
            uncertainMode: uncertain || undefined,
            hasBranchPenalty: instBranchPenalty || undefined,
            hasPagePenalty: instPagePenalty || undefined,
            hasVariableWidth16: instVarWidth16 || undefined,
            hasDpOffsetPenalty: instDpPenalty || undefined,
            hasEmulationPagePenalty: instEmuPagePenalty || undefined,
            hasPerByteCycles: instPerByteCycles || undefined,
        });
    }

    let listingLines: ListingLineRangeItem[] | undefined;
    let lineListing: InstructionAnalysisSummary['lineListing'];
    if (startLine <= endLine && lstLines) {
        const instructionLineSet = items.length > 0 ? new Set(items.map(item => item.line)) : undefined;
        const extraLines: ListingLineRangeItem[] = [];
        let totalListingBytes = 0;

        for (let l = startLine; l <= endLine; l++) {
            if (instructionLineSet?.has(l)) continue;
            const entry = lstLines.get(l);
            if (!entry || entry.byteCount <= 0) continue;
            const normalized = normalizeListingBytesText(entry.bytesText, entry.byteCount);
            if (!normalized) continue;
            extraLines.push({
                line: l,
                bytesText: normalized,
                byteCount: entry.byteCount,
            });
            totalListingBytes += entry.byteCount;
        }

        if (extraLines.length > 0) {
            listingLines = extraLines;
            if (items.length === 0) {
                lineListing = {
                    bytesText: extraLines.length === 1 ? extraLines[0].bytesText : '',
                    byteCount: totalListingBytes,
                };
            }
        }
    }

    return {
        cpu: normalizedCpu,
        instructionCount: items.length,
        minBytes,
        maxBytes,
        minCycles,
        maxCycles,
        uncertainCount,
        usedListing: (usedListing || Boolean(listingLines)) || undefined,
        hasBranchPenalty,
        hasPagePenalty,
        hasVariableWidth16,
        hasDpOffsetPenalty,
        hasEmulationPagePenalty,
        hasPerByteCycles,
        lineListing,
        listingLines,
        items,
    };
}
