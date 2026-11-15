import {
    _Connection,
    DocumentSymbolParams,
    DocumentSymbol,
} from 'vscode-languageserver/node';
import { ensureDocumentRefreshed, initializationGate, symbolTables } from './server';
import { Macro, MacroKind, Scope } from './symbolTable';
import { getLSPSymbolKind } from './symbolResolver';

function formatSegmentDetail(segment: string | null | undefined, parentSegment: string): string | undefined {
    if (!segment || segment === parentSegment) {
        return undefined;
    }
    const upper = segment.toUpperCase();
    return (upper === 'ZEROPAGE' || upper === 'ZP') ? '(zp)' : undefined;
}

function formatMacroDetail(macro: Macro): string | undefined {
    return macro.kind === MacroKind.Macro ? '(macro)' : undefined;
}

export function initializeDocumentSymbolProvider(connection: _Connection) {
    connection.onDocumentSymbol(async (params: DocumentSymbolParams): Promise<DocumentSymbol[] | undefined> => {
        await initializationGate.isInitialized;
        await ensureDocumentRefreshed?.(params.textDocument.uri);

        const symbolTable = symbolTables.get(params.textDocument.uri);
        if (!symbolTable) return undefined;

        // Recursive function to convert our Symbol/Scope hierarchy to DocumentSymbols
        function getDocumentSymbols(scope: Scope, parentSegment: string): DocumentSymbol[] {
            const symbols: DocumentSymbol[] = [];
            const currentSegment = scope.segment ?? parentSegment;

            // Add all symbols in this scope
            for (const sym of scope.getSymbols()) {
                symbols.push({
                    name: sym.name,
                    kind: getLSPSymbolKind(sym),
                    range: sym.range,
                    selectionRange: sym.definition,
                    children: undefined, // symbols don't have children
                    detail: formatSegmentDetail(sym.segment, currentSegment),
                });
            }

            // Add child scopes recursively
            for (const childScope of scope.getChildScopes()) {
                const children = getDocumentSymbols(childScope, currentSegment);
                symbols.push({
                    name: childScope.name,
                    kind: getLSPSymbolKind(childScope),
                    range: childScope.range,
                    selectionRange: childScope.definition,
                    children: children.length > 0 ? children : undefined,
                    detail: formatSegmentDetail(childScope.segment, currentSegment),
                });
            }

            symbols.sort((a, b) => a.range.start.line - b.range.start.line || a.range.start.character - b.range.start.character);
            return symbols;
        }

        const rootSymbols = getDocumentSymbols(symbolTable.getRootScope(), 'CODE');

        // Add macros and sort top-level symbols in source order
        for (const macro of symbolTable.getAllMacros()) {
            rootSymbols.push({
                name: macro.name,
                kind: getLSPSymbolKind(macro),
                range: macro.range,
                selectionRange: macro.definition,
                children: undefined,
                detail: formatMacroDetail(macro),
            });
        }

        rootSymbols.sort((a, b) => a.range.start.line - b.range.start.line || a.range.start.character - b.range.start.character);
        return rootSymbols;
    });
}
