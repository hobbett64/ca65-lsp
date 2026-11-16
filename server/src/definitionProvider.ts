import {
    _Connection,
    TextDocuments,
    Definition,
    DefinitionParams,
    Location,
} from 'vscode-languageserver/node';
import { TextDocument } from 'vscode-languageserver-textdocument';
import { getAnonymousLabelDefinition } from './anonymousLabelUtils';
import { findCheapLocalLabelAtPosition, findCheapLocalLabelDefinition } from './cheapLocalLabelUtils';
import { resolveReferenceAtPosition } from './symbolResolver';
import { ensureDocumentRefreshed, getDocumentSettings, includesGraph, initializationGate, symbolTables } from './server';
import {
    findBuiltinSegmentDirectiveAtPosition,
    findSegmentDirectiveAtPosition,
    loadLinkerConfigForUri,
    lookupLinkerSegment,
} from './linkerConfig';

export function initializeDefinitionProvider(connection: _Connection, documents: TextDocuments<TextDocument>) {
    /**
     * Handles the "Go to Definition" request.
     */
    connection.onDefinition(async (params: DefinitionParams): Promise<Definition | undefined> => {
        await initializationGate.isInitialized;
        await ensureDocumentRefreshed?.(params.textDocument.uri);

        const document = documents.get(params.textDocument.uri);
        if (!document) {
            return undefined;
        }
        
        const settings = await getDocumentSettings(params.textDocument.uri);

        const foundEntity = resolveReferenceAtPosition(
            params.textDocument.uri, params.position, symbolTables, includesGraph, settings.implicitImports
        );

        if (foundEntity) {
            return Location.create(foundEntity.uri, foundEntity.definition);
        }

        const segHit = findSegmentDirectiveAtPosition(document, params.position, settings.cComments)
            ?? findBuiltinSegmentDirectiveAtPosition(document, params.position, settings.cComments);
        if (segHit) {
            const linkerConfig = loadLinkerConfigForUri(params.textDocument.uri, settings, documents);
            const segDef = lookupLinkerSegment(linkerConfig, segHit.segmentName);
            if (segDef) {
                return Location.create(segDef.uri, segDef.range);
            }
        }

        // Fallback for special, non-symbol labels
        const cheapLabelName = findCheapLocalLabelAtPosition(document, params.position);
        if (cheapLabelName) {
            const defCheap = findCheapLocalLabelDefinition(document, params.position, cheapLabelName);
            if (defCheap) return defCheap;
        }

        const anonLabelDef = getAnonymousLabelDefinition(document, params.position);
        if (anonLabelDef) return anonLabelDef;
    });
}
