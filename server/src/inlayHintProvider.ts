import * as path from 'path';
import {
    _Connection,
    TextDocuments,
    InlayHintParams,
    InlayHint,
    InlayHintKind,
} from 'vscode-languageserver/node';
import { TextDocument } from 'vscode-languageserver-textdocument';
import { ensureDocumentRefreshed, getDocumentSettings, includesGraph, initializationGate, symbolTables } from './server';
import { resolveImport } from './symbolResolver';
import { getWorkspaceRelativePath, uriToFsPath } from './pathUtils';

export function initializeInlayHintProvider(connection: _Connection, documents: TextDocuments<TextDocument>) {
    connection.languages.inlayHint.on(async (params: InlayHintParams): Promise<InlayHint[]> => {
        await initializationGate.isInitialized;
        await ensureDocumentRefreshed?.(params.textDocument.uri);
        
        const document = documents.get(params.textDocument.uri);
        if (!document) return [];
        const symbolTable = symbolTables.get(document.uri);
        if (!symbolTable) return [];

        const settings = await getDocumentSettings(document.uri);
        const inlayHints: InlayHint[] = [];
        const startLine = params.range.start.line;
        const endLine = params.range.end.line;

        // Anonymous label index hints
        if (settings.anonymousLabelIndexHints !== false) {
            const references = symbolTable.anonymousLabelReferences;
            if (references) {
                for (const labelIndex of references.keys()) {
                    const ranges = references.get(labelIndex);
                    if (!ranges) continue;
                    for (const range of ranges) {
                        if (range.end.line < startLine || range.end.line > endLine) continue;
                        // Index just left of the colon for both: `3:` on declarations, `3:-` / `3:++` on references.
                        inlayHints.push({
                            label: `${labelIndex + 1}`,
                            position: { line: range.start.line, character: range.start.character },
                            kind: InlayHintKind.Parameter,
                        });
                    }
                }
            }
        }

        // Import statement `from file` hints
        if (settings.importFromHints) {
            for (const importInfo of symbolTable.imports) {
                const defLine = importInfo.definition.end.line;
                if (defLine < startLine || defLine > endLine) continue;
                const resolvedImport = resolveImport(importInfo.name, symbolTables, includesGraph);
                if (!resolvedImport) continue;

                const relativePath = getWorkspaceRelativePath(resolvedImport.uri) ?? path.basename(uriToFsPath(resolvedImport.uri));

                inlayHints.push({
                    label: ` from ${relativePath}`,
                    position: {
                        line: defLine,
                        character: importInfo.definition.end.character
                    },
                    kind: InlayHintKind.Parameter,
                    paddingLeft: false,
                });
            }
        }

        return inlayHints;
    });
}
