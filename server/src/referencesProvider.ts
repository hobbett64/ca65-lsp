import {
    _Connection,
    TextDocuments,
    Location,
    ReferenceParams,
} from 'vscode-languageserver/node';
import { TextDocument } from 'vscode-languageserver-textdocument';
import { ensureDocumentRefreshed, getDocumentSettings, includesGraph, initializationGate, performanceMonitor, symbolTables } from './server';
import { findAllCheapLocalLabelReferences } from './cheapLocalLabelUtils';
import { findAllAnonLabelReferences } from './anonymousLabelUtils';
import {
    findCommentReferenceLocationsForEntity,
    getAllReferenceLocationsForEntity,
    mergeUniqueLocations,
    resolveCommentSegmentAtPosition,
    resolveReferenceAtPosition,
} from './symbolResolver';

export function initializeReferencesProvider(connection: _Connection, documents: TextDocuments<TextDocument>) {
    /**
     * Handles the "Find All References" request using a pre-calculated reference map
     * and searching across all files in the workspace.
     */
    connection.onReferences(async (params: ReferenceParams): Promise<Location[] | undefined> => {
        await initializationGate.isInitialized;
        await ensureDocumentRefreshed?.(params.textDocument.uri);
        return performanceMonitor.timeAsync("onReferences", async () => {
            const uri = params.textDocument.uri;
            const document = documents.get(uri);
            const symbolTable = symbolTables.get(uri);
            if (!document || !symbolTable) {
                return undefined;
            }

            const settings = await getDocumentSettings(uri);
            
            const foundEntity = resolveReferenceAtPosition(
                uri, params.position, symbolTables, includesGraph, settings.implicitImports
            ) ?? resolveCommentSegmentAtPosition(
                uri, params.position, document, symbolTables, includesGraph, settings.implicitImports, settings.cComments
            )?.entity;

            if (foundEntity) {
                const codeLocations = getAllReferenceLocationsForEntity(
                    foundEntity,
                    symbolTables,
                    includesGraph,
                    settings.implicitImports
                );
                const commentLocations = await findCommentReferenceLocationsForEntity(
                    foundEntity,
                    documents,
                    symbolTables,
                    includesGraph,
                    settings.implicitImports,
                    settings.cComments
                );
                return mergeUniqueLocations(codeLocations, commentLocations);
            }

            // Didn't find a real symbol, check if it's a cheap or anonymous reference.
            const cheapLocalRefs = findAllCheapLocalLabelReferences(document, params.position);
            if (cheapLocalRefs.length > 0) {
                return cheapLocalRefs;
            }

            const anonLabelRef = findAllAnonLabelReferences(document, params.position);
            if (anonLabelRef.length > 0) {
                return anonLabelRef;
            }
            return undefined;
        });
    });
}
