import {
    _Connection,
    SemanticTokens,
    SemanticTokensBuilder,
    SemanticTokensLegend,
    SemanticTokenModifiers,
    SemanticTokenTypes,
} from 'vscode-languageserver/node';
import {
    ensureDocumentRefreshed,
    getDocumentSettings,
    includesGraph,
    initializationGate,
    performanceMonitor,
    symbolTables,
} from './server';
import {
    Macro,
    MacroKind,
    Scope,
    ScopeKind,
    Symbol as Ca65Symbol,
    SymbolKind as Ca65SymbolKind,
    SymbolTableEntity,
} from './symbolTable';
import { resolveReference } from './symbolResolver';

const TOKEN_TYPES = [
    SemanticTokenTypes.function,
    SemanticTokenTypes.macro,
    SemanticTokenTypes.variable,
    SemanticTokenTypes.enum,
    SemanticTokenTypes.enumMember,
    SemanticTokenTypes.struct,
    SemanticTokenTypes.namespace,
] as const;

const TOKEN_MODIFIERS = [
    SemanticTokenModifiers.declaration,
    SemanticTokenModifiers.readonly,
] as const;

const TOKEN_TYPE_INDEX: Record<(typeof TOKEN_TYPES)[number], number> = {
    [SemanticTokenTypes.function]: 0,
    [SemanticTokenTypes.macro]: 1,
    [SemanticTokenTypes.variable]: 2,
    [SemanticTokenTypes.enum]: 3,
    [SemanticTokenTypes.enumMember]: 4,
    [SemanticTokenTypes.struct]: 5,
    [SemanticTokenTypes.namespace]: 6,
};

const MOD_DECLARATION = 1 << 0;
const MOD_READONLY = 1 << 1;

export const SEMANTIC_TOKENS_LEGEND: SemanticTokensLegend = {
    tokenTypes: [...TOKEN_TYPES],
    tokenModifiers: [...TOKEN_MODIFIERS],
};

interface RawSemanticToken {
    line: number;
    char: number;
    length: number;
    tokenType: number;
    tokenModifiers: number;
}

function classifyEntity(
    entity: SymbolTableEntity,
    isDeclaration: boolean
): { tokenType: number; tokenModifiers: number } | null {
    const declFlag = isDeclaration ? MOD_DECLARATION : 0;

    if (entity instanceof Scope) {
        const scopeTypeMap: Partial<Record<ScopeKind, number>> = {
            [ScopeKind.Proc]: TOKEN_TYPE_INDEX[SemanticTokenTypes.function],
            [ScopeKind.Enum]: TOKEN_TYPE_INDEX[SemanticTokenTypes.enum],
            [ScopeKind.Struct]: TOKEN_TYPE_INDEX[SemanticTokenTypes.struct],
            [ScopeKind.Union]: TOKEN_TYPE_INDEX[SemanticTokenTypes.struct],
            [ScopeKind.Scope]: TOKEN_TYPE_INDEX[SemanticTokenTypes.namespace],
        };
        const tokenType = scopeTypeMap[entity.kind];
        return tokenType !== undefined ? { tokenType, tokenModifiers: declFlag } : null;
    }

    if (entity instanceof Macro) {
        if (entity.kind === MacroKind.Define && entity.params.length === 0) {
            return {
                tokenType: TOKEN_TYPE_INDEX[SemanticTokenTypes.variable],
                tokenModifiers: declFlag | MOD_READONLY,
            };
        }
        return {
            tokenType: TOKEN_TYPE_INDEX[SemanticTokenTypes.macro],
            tokenModifiers: declFlag,
        };
    }

    if (entity instanceof Ca65Symbol) {
        switch (entity.kind) {
            case Ca65SymbolKind.Constant:
                return {
                    tokenType: TOKEN_TYPE_INDEX[SemanticTokenTypes.variable],
                    tokenModifiers: declFlag | MOD_READONLY,
                };
            case Ca65SymbolKind.EnumMember:
                return {
                    tokenType: TOKEN_TYPE_INDEX[SemanticTokenTypes.enumMember],
                    tokenModifiers: declFlag | MOD_READONLY,
                };
            case Ca65SymbolKind.Variable:
            case Ca65SymbolKind.StructMember:
                return {
                    tokenType: TOKEN_TYPE_INDEX[SemanticTokenTypes.variable],
                    tokenModifiers: declFlag,
                };
            case Ca65SymbolKind.Label:
            case Ca65SymbolKind.ResLabel:
            case Ca65SymbolKind.DataLabel:
            case Ca65SymbolKind.StringLabel:
                return null;
        }
    }

    return null;
}

export async function computeSemanticTokens(uri: string): Promise<SemanticTokens> {
    const builder = new SemanticTokensBuilder();
    const symbolTable = symbolTables.get(uri);
    if (!symbolTable) {
        return builder.build();
    }

    const settings = await getDocumentSettings(uri);
    const tokens: RawSemanticToken[] = [];

    for (const entity of symbolTable.getAllDefinedEntities()) {
        const def = entity.definition;
        if (def.start.line !== def.end.line || def.end.character <= def.start.character) {
            continue;
        }
        const classified = classifyEntity(entity, true);
        if (!classified) continue;

        tokens.push({
            line: def.start.line,
            char: def.start.character,
            length: def.end.character - def.start.character,
            tokenType: classified.tokenType,
            tokenModifiers: classified.tokenModifiers,
        });
    }

    for (const ref of symbolTable.getAllReferences()) {
        const loc = ref.location;
        if (loc.start.line !== loc.end.line || loc.end.character <= loc.start.character) {
            continue;
        }
        const resolved = resolveReference(
            ref,
            symbolTables,
            includesGraph,
            settings.implicitImports
        );
        if (!resolved || resolved instanceof Array) continue;

        const classified = classifyEntity(resolved, false);
        if (!classified) continue;

        tokens.push({
            line: loc.start.line,
            char: loc.start.character,
            length: loc.end.character - loc.start.character,
            tokenType: classified.tokenType,
            tokenModifiers: classified.tokenModifiers,
        });
    }

    tokens.sort((a, b) => a.line - b.line || a.char - b.char);

    let lastLine = -1;
    let lastEndChar = -1;
    for (const tok of tokens) {
        if (tok.line === lastLine && tok.char < lastEndChar) {
            continue;
        }
        builder.push(tok.line, tok.char, tok.length, tok.tokenType, tok.tokenModifiers);
        lastLine = tok.line;
        lastEndChar = tok.char + tok.length;
    }

    return builder.build();
}

export function initializeSemanticTokensProvider(connection: _Connection): void {
    connection.languages.semanticTokens.on(async (params) => {
        await initializationGate.isInitialized;
        await ensureDocumentRefreshed?.(params.textDocument.uri);

        return performanceMonitor.timeAsync('onSemanticTokens', () => {
            return computeSemanticTokens(params.textDocument.uri);
        });
    });
}
