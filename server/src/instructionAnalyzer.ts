import { Range } from 'vscode-languageserver-types';
import { TextDocument } from 'vscode-languageserver-textdocument';
import { getMnemonicInfo, MnemonicModeInfo } from './dataManager';
import { findCommentStart, parseLine } from './documentScanner';
import { getLineText } from './editUtils';
import { IncludesGraph } from './includesGraph';
import { Ca65Cpu, normalizeCpu } from './settings';
import { resolveImport, resolveReference } from './symbolResolver';
import { Import, isZeroPageSegmentName, Scope, ScopeKind, Symbol, SymbolKind, SymbolTable, SymbolTableEntity } from './symbolTable';

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
    hasVariableWidth16?: boolean;
    hasDpOffsetPenalty?: boolean;
    hasEmulationPagePenalty?: boolean;
    hasPerByteCycles?: boolean;
}

export interface InstructionAnalysisSummary {
    cpu?: Ca65Cpu;
    instructionCount: number;
    minBytes: number;
    maxBytes: number;
    minCycles: number;
    maxCycles: number;
    uncertainCount: number;
    hasBranchPenalty: boolean;
    hasPagePenalty: boolean;
    hasVariableWidth16: boolean;
    hasDpOffsetPenalty: boolean;
    hasEmulationPagePenalty: boolean;
    hasPerByteCycles: boolean;
    items: InstructionAnalysisItem[];
}

type AddressWidth = 'zp' | 'abs' | 'far' | 'unknown';

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
        return isZeroPageSegmentName(entity.segment) ? 'zp' : 'abs';
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

function createIdentValueResolver(
    lineNum: number,
    operandStartCol: number,
    document: TextDocument,
    symbolTable: SymbolTable | undefined,
    allSymbolTables: Map<string, SymbolTable>,
    includesGraph: IncludesGraph,
    implicitImports: boolean,
    constCache?: Map<SymbolTableEntity, number | null>
): ((identName: string) => number | null) | undefined {
    if (!symbolTable) return undefined;
    const lineRefs = symbolTable.getReferencesOnLine(lineNum);
    return (identName: string): number | null => {
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
    };
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
        if (prefix === 'a') return 'abs';
        if (prefix === 'f') return 'far';
    }

    const lineRefs = symbolTable?.getReferencesOnLine(lineNum) ?? [];
    const resolveIdentValue = createIdentValueResolver(
        lineNum,
        operandStartCol,
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
        ? [`Direct Page, ${indexReg}`, `Zero Page, ${indexReg}`]
        : ['Direct Page', 'Zero Page'];
    return candidates.find(m => Boolean(modes[m]));
}

function resolveInstructionModes(
    modes: Record<string, MnemonicModeInfo>,
    modeCount: number,
    singleModeName: string,
    operand: string,
    lineNum: number,
    operandCol: number,
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
            if (modes['[Direct Page]']) return { modeA: '[Direct Page]', modeB: '' };
            if (modes['[Indirect Long]']) return { modeA: '[Indirect Long]', modeB: '' };
        } else if (/^,\s*[yY]$/.test(bracket.trailing) && modes['[Direct Page], Y']) {
            return { modeA: '[Direct Page], Y', modeB: '' };
        }
        return { modeA: '', modeB: '' };
    }

    const paren = matchOuterDelimited(operand, '(', ')');
    if (paren) {
        const innerSplit = splitIndexSuffix(paren.inside);
        if (paren.trailing === '') {
            if (innerSplit.indexReg === 'X') {
                if (modes['(Indirect, X)']) return { modeA: '(Indirect, X)', modeB: '' };
                if (modes['(Direct Page, X)']) return { modeA: '(Direct Page, X)', modeB: '' };
                if (modes['(Absolute, X)']) return { modeA: '(Absolute, X)', modeB: '' };
            } else if (!innerSplit.indexReg) {
                if (modes['Indirect']) return { modeA: 'Indirect', modeB: '' };
                if (modes['(Zero Page)']) return { modeA: '(Zero Page)', modeB: '' };
                if (modes['(Direct Page)']) return { modeA: '(Direct Page)', modeB: '' };
            }
        } else if (/^,\s*[yY]$/.test(paren.trailing)) {
            if (innerSplit.indexReg === 'S' && modes['(Stack Relative, S), Y']) {
                return { modeA: '(Stack Relative, S), Y', modeB: '' };
            }
            if (!innerSplit.indexReg) {
                if (modes['(Indirect), Y']) return { modeA: '(Indirect), Y', modeB: '' };
                if (modes['(Direct Page), Y']) return { modeA: '(Direct Page), Y', modeB: '' };
            }
        }
        return { modeA: '', modeB: '' };
    }

    const { base, indexReg } = splitIndexSuffix(operand);
    if (indexReg === 'S') {
        return modes['Stack Relative']
            ? { modeA: 'Stack Relative', modeB: '' }
            : { modeA: '', modeB: '' };
    }

    const zpMode = pickDirectOrZeroPageMode(modes, indexReg);
    const absCandidate = indexReg ? `Absolute, ${indexReg}` : 'Absolute';
    const absMode = modes[absCandidate] ? absCandidate : undefined;
    const farCandidate = indexReg === 'X' ? 'Absolute Long, X' : (!indexReg ? 'Absolute Long' : undefined);
    const farMode = farCandidate && modes[farCandidate] ? farCandidate : undefined;

    if (zpMode && absMode) {
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
        if (width === 'zp') return { modeA: zpMode, modeB: '' };
        if (width === 'far' && farMode) return { modeA: farMode, modeB: '' };
        if (width === 'abs' || width === 'far') return { modeA: absMode, modeB: '' };
        return { modeA: zpMode, modeB: absMode };
    }

    if (absMode && farMode) {
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

function computeModeMetrics(
    modeName: string,
    info: MnemonicModeInfo,
    operand: string,
    lineNum: number,
    operandCol: number,
    document: TextDocument,
    symbolTable: SymbolTable | undefined,
    allSymbolTables: Map<string, SymbolTable>,
    includesGraph: IncludesGraph,
    implicitImports: boolean,
    constCache: Map<SymbolTableEntity, number | null>
): ModeMetrics {
    const varByte = (info.byteVariableM || info.byteVariableX) ? 1 : 0;
    const varCycle = (info.cycleVariableM ?? 0) + (info.cycleVariableX ?? 0);
    let narrowed16 = false;

    if (varByte && modeName === 'Immediate' && operand.startsWith('#')) {
        const resolveIdentValue = createIdentValueResolver(
            lineNum,
            operandCol,
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

    const minBytes = info.bytes + (narrowed16 ? 1 : 0);
    const maxBytes = info.bytes + varByte;
    const minCycles = info.cycles + (narrowed16 ? varCycle : 0);
    const maxCycles = info.cycles + extraFixedCycles + varCycle;

    return {
        minBytes,
        maxBytes,
        minCycles,
        maxCycles,
        hasBranchPenalty: Boolean(info.branchPenalty),
        hasPagePenalty: Boolean(info.pagePenalty || info.pageOrIndex16Penalty),
        hasVariableWidth16: !narrowed16 && (varByte > 0 || varCycle > 0),
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
    cpu?: unknown
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
    let hasBranchPenalty = false;
    let hasPagePenalty = false;
    let hasVariableWidth16 = false;
    let hasDpOffsetPenalty = false;
    let hasEmulationPagePenalty = false;
    let hasPerByteCycles = false;

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
        const operandCol = parsed.args?.index ?? (parsed.command.index + parsed.command.text.length);

        const { modeA, modeB } = resolveInstructionModes(
            modes,
            modeCount,
            singleModeName,
            operand,
            lineNum,
            operandCol,
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

        const metricsA = computeModeMetrics(
            modeA,
            modes[modeA],
            operand,
            lineNum,
            operandCol,
            document,
            symbolTable,
            allSymbolTables,
            includesGraph,
            implicitImports,
            constCache
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
                lineNum,
                operandCol,
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
            uncertainMode: uncertain || undefined,
            hasBranchPenalty: instBranchPenalty || undefined,
            hasPagePenalty: instPagePenalty || undefined,
            hasVariableWidth16: instVarWidth16 || undefined,
            hasDpOffsetPenalty: instDpPenalty || undefined,
            hasEmulationPagePenalty: instEmuPagePenalty || undefined,
            hasPerByteCycles: instPerByteCycles || undefined,
        });
    }

    return {
        cpu: normalizedCpu,
        instructionCount: items.length,
        minBytes,
        maxBytes,
        minCycles,
        maxCycles,
        uncertainCount,
        hasBranchPenalty,
        hasPagePenalty,
        hasVariableWidth16,
        hasDpOffsetPenalty,
        hasEmulationPagePenalty,
        hasPerByteCycles,
        items,
    };
}
