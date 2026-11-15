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
        if (symbolTable) {
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
        }

        const links: DocumentLink[] = [];
        const includeRegex = /^\s*\.(include|incbin)\s+"([^"]+)"/i;
        const lines = document.getText().split(/\r?\n/);

        for (let i = 0; i < lines.length; i++) {
            const line = lines[i];
            const match = line.match(includeRegex);

            if (match) {
                const directive = match[1].toLowerCase(); // "include" or "incbin"
                const filename = match[2];

                const quotedStart = line.indexOf(`"${filename}"`);
                const startChar = quotedStart >= 0 ? quotedStart + 1 : line.indexOf(filename);
                const endChar = startChar + filename.length;
                const range = Range.create(i, startChar, i, endChar);

                let targetUri: string | null = null;
                if (directive === "include") {
                    targetUri = resolveIncludeUri(document.uri, filename, settings.includeDirs);
                } else if (directive === "incbin") {
                    targetUri = await resolveIncbinUri(document.uri, filename, settings.binIncludeDirs);
                }

                if (targetUri) {
                    links.push({
                        range,
                        target: targetUri,
                        tooltip: `Click to open ${filename}`
                    });
                }
            }
        }
        return links;
    });
}
