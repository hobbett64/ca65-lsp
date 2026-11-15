import { Range } from 'vscode-languageserver-types';
import { TextDocument } from 'vscode-languageserver-textdocument';
import { mnemonicData } from './dataManager';
import { findCommentStart, parseLine } from './documentScanner';
import { getLineText } from './editUtils';
import { IncludesGraph } from './includesGraph';
import { resolveImport, resolveReference } from './symbolResolver';
import { Import, Scope, ScopeKind, Symbol, SymbolKind, SymbolTable, SymbolTableEntity } from './symbolTable';

export interface InstructionAnalysisItem {
    line: number;
    mnemonic: string;
    mode: string;
    minBytes: number;
    maxBytes: number;
    minCycles: number;
    maxCycles: number;
    uncertainMode?: boolean;
    hasBranchPenalty?: boolean;
    hasPagePenalty?: boolean;
}

export interface InstructionAnalysisSummary {
    instructionCount: number;
    minBytes: number;
    maxBytes: number;
    minCycles: number;
    maxCycles: number;
    uncertainCount: number;
    hasBranchPenalty: boolean;
    hasPagePenalty: boolean;
    items: InstructionAnalysisItem[];
}

interface ModeEntry {
    opcode: string;
    bytes: number;
    cycles: number;
    branchPenalty?: boolean;
    pagePenalty?: boolean;
}

type AddressWidth = 'zp' | 'abs' | 'unknown';

interface ExprToken {
    type: 'num' | 'op' | 'lparen' | 'rparen' | 'ident';
    value: string;
    numValue?: number;
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
        if (isIdentStartCode(code)) {
            let p = i + 1;
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
    resolveIdent?: (name: string) => number | null
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
function splitIndexSuffix(operand: string): { base: string; indexReg?: 'X' | 'Y' } {
    let depth = 0;
    let quote: '"' | "'" | null = null;
    let lastTopComma = -1;

    for (let i = 0; i < operand.length; i++) {
        const ch = operand[i];
        if (quote) {
            if (ch === quote) quote = null;
        } else if (ch === '"' || ch === "'") {
            quote = ch;
        } else if (ch === '(') {
            depth++;
        } else if (ch === ')' && depth > 0) {
            depth--;
        } else if (ch === ',' && depth === 0) {
            lastTopComma = i;
        }
    }

    if (lastTopComma >= 0) {
        const suffix = operand.slice(lastTopComma + 1).trim().toUpperCase();
        if (suffix === 'X' || suffix === 'Y') {
            return { base: operand.slice(0, lastTopComma).trim(), indexReg: suffix };
        }
    }

    return { base: operand };
}

/**
 * Checks if `operand` begins with a matching `(` ... `)` group covering the entire string
 * or ending right before `, Y` / `, X`.
 */
function matchOuterParentheses(operand: string): { inside: string; trailing: string } | null {
    if (!operand.startsWith('(')) return null;
    let depth = 0;
    let quote: '"' | "'" | null = null;

    for (let i = 0; i < operand.length; i++) {
        const ch = operand[i];
        if (quote) {
            if (ch === quote) quote = null;
        } else if (ch === '"' || ch === "'") {
            quote = ch;
        } else if (ch === '(') {
            depth++;
        } else if (ch === ')') {
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

function tryResolveLocalConstantValue(
    entity: SymbolTableEntity,
    document: TextDocument,
    symbolTable: SymbolTable,
    allSymbolTables: Map<string, SymbolTable>,
    includesGraph: IncludesGraph,
    implicitImports: boolean,
    visited: Set<SymbolTableEntity>,
    constCache?: Map<SymbolTableEntity, number | null>
): number | null {
    if (constCache && constCache.has(entity)) {
        return constCache.get(entity) ?? null;
    }
    if (!(entity instanceof Symbol) || entity.kind !== SymbolKind.Constant) {
        return null;
    }
    if (entity.uri !== document.uri || visited.has(entity)) {
        return null;
    }
    visited.add(entity);

    const defLine = entity.definition.start.line;
    if (defLine < 0 || defLine >= document.lineCount) {
        constCache?.set(entity, null);
        return null;
    }
    const rawLine = getLineText(document, defLine);
    const commentIdx = findCommentStart(rawLine);
    const code = commentIdx >= 0 ? rawLine.slice(0, commentIdx) : rawLine;
    const eqMatch = code.match(/(?:=|:=|\.(?:equ|EQU))\s*(.+)$/);
    if (!eqMatch) {
        constCache?.set(entity, null);
        return null;
    }

    const rhs = eqMatch[1].trim();
    const resolvedVal = tryEvaluateNumericExpr(rhs, (identName) => {
        const lineRefs = symbolTable.getReferencesOnLine(defLine);
        const matchRef = lineRefs.find(r => r.name === identName && r.location.start.character > entity.definition.end.character);
        if (!matchRef) return null;
        const target = resolveReference(matchRef, allSymbolTables, includesGraph, implicitImports);
        if (!target) return null;
        return tryResolveLocalConstantValue(
            target,
            document,
            symbolTable,
            allSymbolTables,
            includesGraph,
            implicitImports,
            visited,
            constCache
        );
    });
    constCache?.set(entity, resolvedVal);
    return resolvedVal;
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
        const segUpper = entity.segment.toUpperCase();
        return (segUpper === 'ZEROPAGE' || segUpper === 'ZP') ? 'zp' : 'abs';
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
            return (val >= 0 && val <= 0xFF) ? 'zp' : 'abs';
        }
    }

    return 'unknown';
}

function classifyOperandWidth(
    baseExpr: string,
    lineNum: number,
    operandStartCol: number,
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
        if (prefix === 'a' || prefix === 'f') return 'abs';
    }

    const lineRefs = symbolTable?.getReferencesOnLine(lineNum) ?? [];
    const resolveIdentValue = symbolTable
        ? (identName: string): number | null => {
            const ref = lineRefs.find(
                r => r.name === identName && r.location.start.character >= operandStartCol
            );
            if (!ref) return null;
            const resolved = resolveReference(ref, allSymbolTables, includesGraph, implicitImports);
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
        }
        : undefined;

    const evaluated = tryEvaluateNumericExpr(baseExpr, resolveIdentValue);
    if (evaluated !== null) {
        return (evaluated >= 0 && evaluated <= 0xFF) ? 'zp' : 'abs';
    }

    // Fall back to resolved symbol segment / .importzp metadata if any identifier exists in baseExpr.
    if (symbolTable) {
        let sawZp = false;
        let sawAbs = false;
        let sawUnknown = false;
        let matchedAny = false;

        for (let i = 0; i < lineRefs.length; i++) {
            const ref = lineRefs[i];
            if (ref.location.start.character < operandStartCol || !baseExpr.includes(ref.name)) {
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
            else if (width === 'abs') sawAbs = true;
            else sawUnknown = true;
        }

        if (matchedAny) {
            if (sawAbs) return 'abs';
            if (sawZp && !sawUnknown) return 'zp';
        }
    }

    return 'unknown';
}

/**
 * Analyzes 6502 instructions within a document range and returns cycle and byte estimates.
 */
export function analyzeInstructionRange(
    document: TextDocument,
    range: Range,
    symbolTable: SymbolTable | undefined,
    allSymbolTables: Map<string, SymbolTable>,
    includesGraph: IncludesGraph,
    implicitImports: boolean
): InstructionAnalysisSummary {
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
    let hasBranchPenalty = false;
    let hasPagePenalty = false;

    const docText = document.getText();
    const constCache = new Map<SymbolTableEntity, number | null>();
    let lineStart = startLine === 0 ? 0 : document.offsetAt({ line: startLine, character: 0 });

    for (let lineNum = startLine; lineNum <= endLine && lineStart <= docText.length; lineNum++) {
        const curLineStart = lineStart;
        const nl = docText.indexOf('\n', curLineStart);
        const rawEnd = nl === -1 ? docText.length : nl;
        const lineEnd = (rawEnd > curLineStart && docText.charCodeAt(rawEnd - 1) === 13) ? rawEnd - 1 : rawEnd;
        lineStart = nl === -1 ? docText.length + 1 : nl + 1;

        // Fast-skip blank or comment-only lines before parsing.
        let p = curLineStart;
        while (p < lineEnd && isWsCode(docText.charCodeAt(p))) {
            p++;
        }
        if (p >= lineEnd || docText.charCodeAt(p) === 59) { // blank or ';'
            continue;
        }

        const lineText = docText.slice(curLineStart, lineEnd);
        const parsed = parseLine(lineText);
        if (!parsed.command || parsed.command.text.startsWith('.')) {
            continue;
        }

        const mnemonic = parsed.command.text.toUpperCase();
        const entry = mnemonicData[mnemonic];
        if (!entry || !entry.modes) {
            continue;
        }

        const modes = entry.modes as Record<string, ModeEntry>;
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
        const operandCol = parsed.args?.index ?? (parsed.command.index + parsed.command.text.length);

        let modeA = '';
        let modeB = '';

        if (!operand) {
            if (modes['Implied']) modeA = 'Implied';
            else if (modes['Accumulator']) modeA = 'Accumulator';
        } else if (modeCount === 1) {
            modeA = singleModeName;
        } else if (/^[aA]$/.test(operand) && modes['Accumulator']) {
            modeA = 'Accumulator';
        } else if (operand.startsWith('#') && modes['Immediate']) {
            modeA = 'Immediate';
        } else {
            const paren = matchOuterParentheses(operand);
            if (paren) {
                if (paren.trailing === '' && modes['Indirect'] && !/,/i.test(paren.inside)) {
                    modeA = 'Indirect';
                } else if (paren.trailing === '' && modes['(Indirect, X)']) {
                    const innerSplit = splitIndexSuffix(paren.inside);
                    if (innerSplit.indexReg === 'X') {
                        modeA = '(Indirect, X)';
                    }
                } else if (/^,\s*[yY]$/.test(paren.trailing) && modes['(Indirect), Y']) {
                    modeA = '(Indirect), Y';
                }
            }

            if (!modeA) {
                const { base, indexReg } = splitIndexSuffix(operand);
                const zpMode = indexReg ? `Zero Page, ${indexReg}` : 'Zero Page';
                const absMode = indexReg ? `Absolute, ${indexReg}` : 'Absolute';
                const hasZp = Boolean(modes[zpMode]);
                const hasAbs = Boolean(modes[absMode]);

                if (hasZp && hasAbs) {
                    const width = classifyOperandWidth(
                        base,
                        lineNum,
                        operandCol,
                        document,
                        symbolTable,
                        allSymbolTables,
                        includesGraph,
                        implicitImports,
                        constCache
                    );
                    if (width === 'zp') modeA = zpMode;
                    else if (width === 'abs') modeA = absMode;
                    else {
                        modeA = zpMode;
                        modeB = absMode;
                    }
                } else if (hasZp) {
                    modeA = zpMode;
                } else if (hasAbs) {
                    modeA = absMode;
                }
            }
        }

        if (!modeA) {
            continue;
        }

        const infoA = modes[modeA];
        let instMinBytes = infoA.bytes;
        let instMaxBytes = infoA.bytes;
        let instMinCycles = infoA.cycles;
        let instMaxCycles = infoA.cycles + (infoA.branchPenalty ? 1 : 0) + (infoA.pagePenalty ? 1 : 0);
        let instBranchPenalty = Boolean(infoA.branchPenalty);
        let instPagePenalty = Boolean(infoA.pagePenalty);
        let modeLabel = modeA;
        let uncertain = false;

        if (modeB) {
            const infoB = modes[modeB];
            uncertain = true;
            if (infoB.bytes < instMinBytes) instMinBytes = infoB.bytes;
            if (infoB.bytes > instMaxBytes) instMaxBytes = infoB.bytes;
            if (infoB.cycles < instMinCycles) instMinCycles = infoB.cycles;
            const bMaxCyc = infoB.cycles + (infoB.branchPenalty ? 1 : 0) + (infoB.pagePenalty ? 1 : 0);
            if (bMaxCyc > instMaxCycles) instMaxCycles = bMaxCyc;
            if (infoB.branchPenalty) instBranchPenalty = true;
            if (infoB.pagePenalty) instPagePenalty = true;
            modeLabel = `${modeA} / ${modeB}`;
        }

        if (uncertain) uncertainCount++;
        if (instBranchPenalty) hasBranchPenalty = true;
        if (instPagePenalty) hasPagePenalty = true;

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
            uncertainMode: uncertain || undefined,
            hasBranchPenalty: instBranchPenalty || undefined,
            hasPagePenalty: instPagePenalty || undefined,
        });
    }

    return {
        instructionCount: items.length,
        minBytes,
        maxBytes,
        minCycles,
        maxCycles,
        uncertainCount,
        hasBranchPenalty,
        hasPagePenalty,
        items,
    };
}
