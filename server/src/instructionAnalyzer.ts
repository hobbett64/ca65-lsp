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

/**
 * Tokenizes a 6502/ca65 constant arithmetic expression.
 * Returns null if an unsupported construct is encountered.
 */
function tokenizeExpr(expr: string): ExprToken[] | null {
    const tokens: ExprToken[] = [];
    let i = 0;

    while (i < expr.length) {
        const ch = expr[i];
        if (/\s/.test(ch)) {
            i++;
            continue;
        }
        if (ch === '(') {
            tokens.push({ type: 'lparen', value: '(' });
            i++;
            continue;
        }
        if (ch === ')') {
            tokens.push({ type: 'rparen', value: ')' });
            i++;
            continue;
        }
        if (expr.startsWith('<<', i) || expr.startsWith('>>', i)) {
            tokens.push({ type: 'op', value: expr.slice(i, i + 2) });
            i += 2;
            continue;
        }
        if ('+-*/&|^~<>'.includes(ch)) {
            tokens.push({ type: 'op', value: ch });
            i++;
            continue;
        }
        if (ch === '$') {
            const m = expr.slice(i + 1).match(/^[0-9a-fA-F_]+/);
            if (!m) return null;
            const cleaned = m[0].replace(/_/g, '');
            tokens.push({ type: 'num', value: '$' + m[0], numValue: parseInt(cleaned, 16) });
            i += 1 + m[0].length;
            continue;
        }
        if (ch === '%') {
            const m = expr.slice(i + 1).match(/^[01_]+/);
            if (!m) return null;
            const cleaned = m[0].replace(/_/g, '');
            tokens.push({ type: 'num', value: '%' + m[0], numValue: parseInt(cleaned, 2) });
            i += 1 + m[0].length;
            continue;
        }
        if (ch === "'" && i + 2 < expr.length && expr[i + 2] === "'") {
            tokens.push({ type: 'num', value: expr.slice(i, i + 3), numValue: expr.charCodeAt(i + 1) });
            i += 3;
            continue;
        }
        if (/[0-9]/.test(ch)) {
            const m = expr.slice(i).match(/^(?:0x([0-9a-fA-F_]+)|([0-9_]+))/i);
            if (!m) return null;
            const numVal = m[1]
                ? parseInt(m[1].replace(/_/g, ''), 16)
                : parseInt(m[2].replace(/_/g, ''), 10);
            tokens.push({ type: 'num', value: m[0], numValue: numVal });
            i += m[0].length;
            continue;
        }
        if (/[a-zA-Z_@]/.test(ch)) {
            const m = expr.slice(i).match(/^[a-zA-Z_@.][a-zA-Z0-9_@.:]*/);
            if (!m) return null;
            tokens.push({ type: 'ident', value: m[0] });
            i += m[0].length;
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
    visited: Set<SymbolTableEntity>
): number | null {
    if (!(entity instanceof Symbol) || entity.kind !== SymbolKind.Constant) {
        return null;
    }
    if (entity.uri !== document.uri || visited.has(entity)) {
        return null;
    }
    visited.add(entity);

    const defLine = entity.definition.start.line;
    if (defLine < 0 || defLine >= document.lineCount) {
        return null;
    }
    const rawLine = getLineText(document, defLine);
    const commentIdx = findCommentStart(rawLine);
    const code = commentIdx >= 0 ? rawLine.slice(0, commentIdx) : rawLine;
    const eqMatch = code.match(/(?:=|:=|\.(?:equ|EQU))\s*(.+)$/);
    if (!eqMatch) return null;

    const rhs = eqMatch[1].trim();
    return tryEvaluateNumericExpr(rhs, (identName) => {
        const lineRefs = symbolTable.getReferencesOnLine(defLine);
        const matchRef = lineRefs.find(r => r.name === identName && r.location.start.character > entity.definition.end.character);
        if (!matchRef) return null;
        const target = resolveReference(matchRef, allSymbolTables, includesGraph, implicitImports);
        if (!target) return null;
        return tryResolveLocalConstantValue(target, document, symbolTable, allSymbolTables, includesGraph, implicitImports, visited);
    });
}

function classifyEntityWidth(
    entity: SymbolTableEntity,
    document: TextDocument,
    symbolTable: SymbolTable,
    allSymbolTables: Map<string, SymbolTable>,
    includesGraph: IncludesGraph,
    implicitImports: boolean,
    visited: Set<SymbolTableEntity> = new Set()
): AddressWidth {
    if (visited.has(entity)) return 'unknown';
    visited.add(entity);

    if (entity instanceof Import) {
        if (entity.isZeroPage) return 'zp';
        const resolved = resolveImport(entity.name, allSymbolTables, includesGraph);
        return resolved
            ? classifyEntityWidth(resolved, document, symbolTable, allSymbolTables, includesGraph, implicitImports, visited)
            : 'unknown';
    }

    if (entity.segment) {
        const segUpper = entity.segment.toUpperCase();
        return (segUpper === 'ZEROPAGE' || segUpper === 'ZP') ? 'zp' : 'abs';
    }

    if (entity instanceof Symbol && entity.kind === SymbolKind.Constant) {
        const val = tryResolveLocalConstantValue(entity, document, symbolTable, allSymbolTables, includesGraph, implicitImports, new Set());
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
    implicitImports: boolean
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
                new Set()
            );
        }
        : undefined;

    const evaluated = tryEvaluateNumericExpr(baseExpr, resolveIdentValue);
    if (evaluated !== null) {
        return (evaluated >= 0 && evaluated <= 0xFF) ? 'zp' : 'abs';
    }

    // Fall back to resolved symbol segment / .importzp metadata if any identifier exists in baseExpr.
    if (symbolTable) {
        const operandRefs = lineRefs.filter(
            r => r.location.start.character >= operandStartCol && baseExpr.includes(r.name)
        );
        if (operandRefs.length > 0) {
            let sawZp = false;
            let sawAbs = false;
            let sawUnknown = false;

            for (const ref of operandRefs) {
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
                    implicitImports
                );
                if (width === 'zp') sawZp = true;
                else if (width === 'abs') sawAbs = true;
                else sawUnknown = true;
            }

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
    let startLine = Math.max(0, range.start.line);
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

    for (let lineNum = startLine; lineNum <= endLine; lineNum++) {
        const lineText = getLineText(document, lineNum);
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
        const modeNames = Object.keys(modes);
        if (modeNames.length === 0) continue;

        const operand = parsed.args?.text.trim() ?? '';
        const operandCol = parsed.args?.index ?? (parsed.command.index + parsed.command.text.length);

        let candidateModes: string[] = [];

        if (!operand) {
            if (modes['Implied']) candidateModes = ['Implied'];
            else if (modes['Accumulator']) candidateModes = ['Accumulator'];
        } else if (modeNames.length === 1) {
            candidateModes = [modeNames[0]];
        } else if (/^[aA]$/.test(operand) && modes['Accumulator']) {
            candidateModes = ['Accumulator'];
        } else if (operand.startsWith('#') && modes['Immediate']) {
            candidateModes = ['Immediate'];
        } else {
            const paren = matchOuterParentheses(operand);
            if (paren) {
                if (paren.trailing === '' && modes['Indirect'] && !/,/i.test(paren.inside)) {
                    candidateModes = ['Indirect'];
                } else if (paren.trailing === '' && modes['(Indirect, X)']) {
                    const innerSplit = splitIndexSuffix(paren.inside);
                    if (innerSplit.indexReg === 'X') {
                        candidateModes = ['(Indirect, X)'];
                    }
                } else if (/^,\s*[yY]$/.test(paren.trailing) && modes['(Indirect), Y']) {
                    candidateModes = ['(Indirect), Y'];
                }
            }

            if (candidateModes.length === 0) {
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
                        implicitImports
                    );
                    if (width === 'zp') candidateModes = [zpMode];
                    else if (width === 'abs') candidateModes = [absMode];
                    else candidateModes = [zpMode, absMode];
                } else if (hasZp) {
                    candidateModes = [zpMode];
                } else if (hasAbs) {
                    candidateModes = [absMode];
                }
            }
        }

        if (candidateModes.length === 0) {
            continue;
        }

        const resolvedEntries = candidateModes.map(name => ({ name, info: modes[name] }));
        const instMinBytes = Math.min(...resolvedEntries.map(e => e.info.bytes));
        const instMaxBytes = Math.max(...resolvedEntries.map(e => e.info.bytes));
        const instMinCycles = Math.min(...resolvedEntries.map(e => e.info.cycles));
        const instMaxCycles = Math.max(
            ...resolvedEntries.map(
                e => e.info.cycles + (e.info.branchPenalty ? 1 : 0) + (e.info.pagePenalty ? 1 : 0)
            )
        );
        const uncertain = resolvedEntries.length > 1;
        const instBranchPenalty = resolvedEntries.some(e => Boolean(e.info.branchPenalty));
        const instPagePenalty = resolvedEntries.some(e => Boolean(e.info.pagePenalty));

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
            mode: resolvedEntries.map(e => e.name).join(' / '),
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
