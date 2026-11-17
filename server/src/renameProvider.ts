import {
    _Connection,
    TextDocuments,
    RenameParams,
    PrepareRenameParams,
    Range,
    WorkspaceEdit,
    TextEdit,
    Location,
} from 'vscode-languageserver/node';
import { TextDocument } from 'vscode-languageserver-textdocument';
import { ensureDocumentRefreshed, getDocumentSettings, includesGraph, initializationGate, symbolTables } from './server';
import {
    findCommentReferenceLocationsForEntity,
    getAllReferenceLocationsForEntity,
    mergeUniqueLocations,
    resolveCommentSegmentAtPosition,
    resolveReference,
} from './symbolResolver';
import { findAllCheapLocalLabelReferences } from './cheapLocalLabelUtils';
import { SymbolTable, SymbolTableEntity } from './symbolTable';
import { Ca65Settings } from './settings';

interface RenameTarget {
    range: Range;
    placeholder: string;
    entity?: SymbolTableEntity;
    cheapLocations?: Location[];
}

function resolveRenameTarget(
    position: { line: number; character: number },
    document: TextDocument,
    symbolTable: SymbolTable,
    settings: Ca65Settings
): RenameTarget | null {
    const ref = symbolTable.getReferenceAtPosition(position);
    if (ref) {
        const entity = resolveReference(ref, symbolTables, includesGraph, settings.implicitImports);
        if (entity) {
            return {
                range: ref.location,
                placeholder: ref.name,
                entity,
            };
        }
    }

    const commentTarget = resolveCommentSegmentAtPosition(
        document.uri,
        position,
        document,
        symbolTables,
        includesGraph,
        settings.implicitImports,
        settings.cComments
    );
    if (commentTarget) {
        return {
            range: commentTarget.range,
            placeholder: commentTarget.placeholder,
            entity: commentTarget.entity,
        };
    }

    const cheapLocations = findAllCheapLocalLabelReferences(document, position);
    if (cheapLocations.length > 0) {
        const hit = cheapLocations.find(loc => symbolTable.isPositionInRange(position, loc.range));
        if (hit) {
            return {
                range: hit.range,
                placeholder: document.getText(hit.range),
                cheapLocations,
            };
        }
    }

    return null;
}

export function initializeRenameProvider(connection: _Connection, documents: TextDocuments<TextDocument>) {
    connection.onPrepareRename(async (params: PrepareRenameParams) => {
        await initializationGate.isInitialized;
        await ensureDocumentRefreshed?.(params.textDocument.uri);

        const uri = params.textDocument.uri;
        const document = documents.get(uri);
        const symbolTable = symbolTables.get(uri);
        if (!document || !symbolTable) {
            return null;
        }

        const settings = await getDocumentSettings(uri);
        const target = resolveRenameTarget(params.position, document, symbolTable, settings);
        if (!target) {
            return null;
        }

        return {
            range: target.range,
            placeholder: target.placeholder,
        };
    });

    /**
     * Handles the "Rename Symbol" request.
     */
    connection.onRenameRequest(async (params: RenameParams): Promise<WorkspaceEdit | null> => {
        await initializationGate.isInitialized;
        await ensureDocumentRefreshed?.(params.textDocument.uri);

        const uri = params.textDocument.uri;
        const document = documents.get(uri);
        const symbolTable = symbolTables.get(uri);
        if (!document || !symbolTable) {
            return null;
        }

        const settings = await getDocumentSettings(uri);
        const target = resolveRenameTarget(params.position, document, symbolTable, settings);
        if (!target) {
            return null;
        }

        let allLocations: Location[];
        let effectiveNewName = params.newName;
        if (target.entity) {
            const codeLocations = getAllReferenceLocationsForEntity(
                target.entity,
                symbolTables,
                includesGraph,
                settings.implicitImports
            );
            const commentLocations = await findCommentReferenceLocationsForEntity(
                target.entity,
                documents,
                symbolTables,
                includesGraph,
                settings.implicitImports,
                settings.cComments
            );
            allLocations = mergeUniqueLocations(codeLocations, commentLocations);
        } else {
            allLocations = target.cheapLocations || [];
            if (!effectiveNewName.startsWith('@')) {
                effectiveNewName = `@${effectiveNewName}`;
            }
        }

        const edits: { [uri: string]: TextEdit[] } = {};
        for (const location of allLocations) {
            if (!edits[location.uri]) {
                edits[location.uri] = [];
            }
            edits[location.uri].push(TextEdit.replace(location.range, effectiveNewName));
        }

        return { changes: edits };
    });
}
