import {
    _Connection,
    DocumentLinkParams,
    DocumentLink,
    TextDocuments,
    Range,
} from 'vscode-languageserver/node';
import { TextDocument } from 'vscode-languageserver-textdocument';
import { resolveIncbinUri, resolveIncludeUri } from './pathUtils';
import { ensureDocumentRefreshed, getDocumentSettings, initializationGate, symbolTables } from './server';

export function initializeDocumentLinkProvider(connection: _Connection, documents: TextDocuments<TextDocument>) {
    connection.onDocumentLinks(async (params: DocumentLinkParams): Promise<DocumentLink[] | undefined> => {
        await initializationGate.isInitialized;
        await ensureDocumentRefreshed?.(params.textDocument.uri);

        const document = documents.get(params.textDocument.uri);
        if (!document) {
            return undefined;
        }

        const settings = await getDocumentSettings(document.uri);
        const symbolTable = symbolTables.get(document.uri);
        if (!symbolTable) {
            return undefined;
        }

        const links: DocumentLink[] = [];
        for (const directive of symbolTable.documentLinkDirectives) {
            const targetUri = directive.isBinary
                ? await resolveIncbinUri(document.uri, directive.filename, settings.binIncludeDirs)
                : (directive.resolvedUri || resolveIncludeUri(document.uri, directive.filename, settings.includeDirs));

            if (targetUri) {
                links.push({
                    range: Range.create(directive.line, directive.startChar, directive.line, directive.endChar),
                    target: targetUri,
                    tooltip: `Click to open ${directive.filename}`
                });
            }
        }
        return links;
    });
}
