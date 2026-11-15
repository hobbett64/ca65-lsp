import {
    _Connection,
    TextDocuments,
    CallHierarchyPrepareParams,
    CallHierarchyItem,
    CallHierarchyIncomingCallsParams,
    CallHierarchyIncomingCall,
    CallHierarchyOutgoingCallsParams,
    CallHierarchyOutgoingCall,
} from 'vscode-languageserver/node';
import { Range, TextDocument } from 'vscode-languageserver-textdocument';
import { ensureDocumentRefreshed, getDocumentSettings, includesGraph, initializationGate, symbolTables } from './server';
import { getAllReferencesForEntity, resolveReferenceAtPosition, getLSPSymbolKind, resolveReference } from './symbolResolver';
import { Scope, ScopeKind, Symbol, SymbolTableEntity } from './symbolTable';

function toCallHierarchyItem(entity: SymbolTableEntity): CallHierarchyItem {
    return {
        kind: getLSPSymbolKind(entity),
        name: entity.getQualifiedName(),
        uri: entity.uri,
        range: entity.range,
        selectionRange: entity.definition,
        data: {
            uri: entity.uri,
            name: entity.name,
            scopeStack: entity.getScopeStack()
        },
    };
}

export function initializeCallHierarchyProvider(
    connection: _Connection,
    documents: TextDocuments<TextDocument>
) {
    connection.languages.callHierarchy.onPrepare(
        async (
            params: CallHierarchyPrepareParams
        ): Promise<CallHierarchyItem[] | null> => {
            await initializationGate.isInitialized;
            await ensureDocumentRefreshed?.(params.textDocument.uri);

            const document = documents.get(params.textDocument.uri);
            if (!document) {
                return null;
            }

            const settings = await getDocumentSettings(params.textDocument.uri);

            const foundEntity = resolveReferenceAtPosition(
                params.textDocument.uri, params.position, symbolTables, includesGraph, settings.implicitImports
            );
            if (!foundEntity) {
                return null;
            }

            if (foundEntity instanceof Symbol
                || (foundEntity instanceof Scope && foundEntity.kind === ScopeKind.Proc)) {
                return [toCallHierarchyItem(foundEntity)];
            }
            return null;
        }
    );

    connection.languages.callHierarchy.onIncomingCalls(
        async (
            params: CallHierarchyIncomingCallsParams
        ): Promise<CallHierarchyIncomingCall[] | null> => {
            await initializationGate.isInitialized;
            await ensureDocumentRefreshed?.(params.item.uri);

            const settings = await getDocumentSettings(params.item.uri);

            if (!params.item.data) return null;
            const {uri, name, scopeStack} = params.item.data;
            if (!uri || !name || !scopeStack ) return null;

            
            const symbolTable = symbolTables.get(uri);
            if (!symbolTable) return null;

            const entity = symbolTable.getRootScope().findDefinition(name, scopeStack, 'symbol');
            if (!entity) return null;

            const allReferences = getAllReferencesForEntity(
                entity,
                symbolTables,
                includesGraph,
                settings.implicitImports
            );

            // 3. Group references by the function/scope they are called FROM.
            const callsByCaller = new Map<SymbolTableEntity, Range[]>();
            for (const ref of allReferences) {
                if (ref.callingEntity) {
                    if (!callsByCaller.has(ref.callingEntity)) {
                        callsByCaller.set(ref.callingEntity, []);
                    }
                    // The range of the call is the reference's location.
                    callsByCaller.get(ref.callingEntity)!.push(ref.location);
                }
            }

            // 4. Format the results from the grouped map.
            const incomingCalls: CallHierarchyIncomingCall[] = [];
            for (const [caller, ranges] of callsByCaller.entries()) {
                incomingCalls.push({
                    from: toCallHierarchyItem(caller),
                    fromRanges: ranges,
                });
            }

            return incomingCalls;
        });

    connection.languages.callHierarchy.onOutgoingCalls(
        async (
            params: CallHierarchyOutgoingCallsParams
        ): Promise<CallHierarchyOutgoingCall[] | null> => {
            await initializationGate.isInitialized;
            await ensureDocumentRefreshed?.(params.item.uri);

            const settings = await getDocumentSettings(params.item.uri);

            if (!params.item.data) return null;
            const {uri, name, scopeStack} = params.item.data;
            if (!uri || !name || !scopeStack ) return null;
            
            const symbolTable = symbolTables.get(uri);
            if (!symbolTable) return null;

            const entity = symbolTable.getRootScope().findDefinitionOrImport(name, scopeStack, 'symbol');
            if (!entity) return null;

            const outgoingReferences = symbolTable.getReferencesByCaller(entity);

            // 3. Resolve each outgoing reference and group them by what they call (the definition).
            const callsByDefinition = new Map<SymbolTableEntity, Range[]>();
            for (const ref of outgoingReferences) {
                const resolvedEntity =
                    resolveReference(ref, symbolTables, includesGraph, settings.implicitImports);
                if (resolvedEntity) {
                    if (!callsByDefinition.has(resolvedEntity)) {
                        callsByDefinition.set(resolvedEntity, []);
                    }
                    // The range of the call is the reference's location.
                    callsByDefinition.get(resolvedEntity)!.push(ref.location);
                }
            }
            
            // 4. Format the results.
            const outgoingCalls: CallHierarchyOutgoingCall[] = [];
            for (const [calledEntity, ranges] of callsByDefinition.entries()) {
                outgoingCalls.push({
                    to: toCallHierarchyItem(calledEntity),
                    fromRanges: ranges
                });
            }
            
            return outgoingCalls;
        });
}
