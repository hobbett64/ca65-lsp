import {
    createConnection,
    TextDocuments,
    ProposedFeatures,
    InitializeParams,
    DidChangeWatchedFilesParams,
    FileChangeType,
    CodeActionKind,
    Range,
} from 'vscode-languageserver/node';
import { TextDocument } from 'vscode-languageserver-textdocument';
import { URI } from 'vscode-uri';
import * as path from 'path';
import * as fs from 'fs/promises';
import { glob } from 'glob';

import { loadAllData } from './dataManager';
import { abortValidation, clearExecutablePathCache, initializeDiagnostics, triggerValidation } from './diagnostics';
import { initializeDocumentSymbolProvider } from './documentSymbolProvider';
import { scanDocument } from './documentScanner';
import { initializeFoldingRangeProvider } from './foldingRangeProvider';
import { initializeDocumentLinkProvider } from './documentLinkProvider';
import { initializeWorkspaceSymbolProvider } from './workspaceSymbolProvider';
import { initializeInlayHintProvider } from './inlayHintProvider';
import { IncludesGraph } from './includesGraph';
import { SymbolTable } from './symbolTable';
import { initializeHoverProvider } from './hoverProvider';
import { initializeReferencesProvider } from './referencesProvider';
import { initializeDefinitionProvider } from './definitionProvider';
import { initializeRenameProvider } from './renameProvider';
import { initializeCallHierarchyProvider } from './callHierarchyProvider';
import { initializeDocumentHighlightProvider } from './documentHighlightProvider';
import { initializeCompletionProvider } from './completionProvider';
import { initializeCodeActionProvider } from './codeActionProvider';
import { analyzeInstructionRange } from './instructionAnalyzer';
import { invalidateOverlaySignatures, initializeOverlayProvider } from './overlayProvider';
import { deleteCachedResolutions } from './symbolResolver';
import { ExportsMap } from './exportsMap';
import { Ca65Settings, documentSettings } from './settings';
import { Performance as PerformanceMonitor } from './performance';
import { clearResolvedDirsCache, resolveIncludeUri } from './pathUtils';

// --- Connection and Document Manager Setup ---
const connection = createConnection(ProposedFeatures.all);
const documents: TextDocuments<TextDocument> = new TextDocuments(TextDocument);
export let workspaceFolderUris: string[] = [];
export const symbolTables = new Map<string, SymbolTable>();
export const includesGraph = new IncludesGraph();
export const exportsMap = new ExportsMap();
export const performanceMonitor = new PerformanceMonitor();

export const initializationGate = (() => {
    let resolve: () => void;
    const promise = new Promise<void>(r => {
        resolve = r;
    });
    return {
        isInitialized: promise,
        open: () => resolve(),
    };
})();

// --- Server Initialization ---
connection.onInitialize(async (params: InitializeParams) => {
    if (params.workspaceFolders) {
        workspaceFolderUris = params.workspaceFolders.map(folder => folder.uri);
    }

    return {
        capabilities: {
            hoverProvider: true,
            documentSymbolProvider: true,
            definitionProvider: true,
            referencesProvider: true,
            foldingRangeProvider: true,
            documentLinkProvider: { resolveProvider: false },
            callHierarchyProvider: true,
            renameProvider: true,
            workspaceSymbolProvider: true,
            completionProvider: {
                triggerCharacters: ['.', '@'],
                resolveProvider: true,
            },
            inlayHintProvider: { resolveProvider: false },
            documentHighlightProvider: true,
            codeActionProvider: {
                codeActionKinds: [CodeActionKind.QuickFix, CodeActionKind.RefactorRewrite],
            },
            workspace: {
                workspaceFolders: {
                    supported: true,
                    changeNotifications: true
                }
            }
        },
    };
});

async function mapWithConcurrency<T>(
    items: readonly T[],
    limit: number,
    fn: (item: T) => Promise<void>
): Promise<void> {
    let index = 0;
    const workers = Array.from({ length: Math.min(limit, items.length) }, async () => {
        while (index < items.length) {
            const current = items[index++];
            await fn(current);
        }
    });
    await Promise.all(workers);
}

async function getDiscoveryGlobs(): Promise<string[]> {
    const defaultGlobs = ['**/*.s', '**/*.asm', '**/*.inc'];
    const configuredGlobs: string[] = [];

    try {
        const config = await connection.workspace.getConfiguration({ section: 'files' });
        const associations = config?.associations || {};

        for (const [pattern, langId] of Object.entries(associations)) {
            if (langId !== 'ca65') continue;
            configuredGlobs.push(
                !pattern.includes('/') && !pattern.includes('\\')
                    ? `**/${pattern}`
                    : pattern
            );
        }
    } catch (e) {
        connection.console.error(`Could not fetch 'files.associations' from client: ${e}`);
    }

    try {
        const ca65Config = await connection.workspace.getConfiguration({ section: 'ca65' });
        const customExtensions = Array.isArray(ca65Config?.additionalExtensions)
            ? ca65Config.additionalExtensions
            : [];
        for (const ext of customExtensions) {
            if (typeof ext !== 'string' || !ext) continue;
            const cleanExt = ext.startsWith('.') ? ext : `.${ext}`;
            configuredGlobs.push(`**/*${cleanExt}`);
        }
    } catch (e) {
        connection.console.error(`Could not fetch 'ca65.additionalExtensions' from client: ${e}`);
    }

    return [...new Set([...defaultGlobs, ...configuredGlobs])];
}

async function indexWorkspaceFolder(folderUri: string, globs: string[]): Promise<void> {
    const folderPath = URI.parse(folderUri).fsPath;
    const files = await glob(globs, {
        cwd: folderPath,
        nodir: true,
        ignore: ['**/.git/**', '**/node_modules/**', '**/build/**', '**/dist/**', '**/out/**']
    });

    const docs: TextDocument[] = [];
    await mapWithConcurrency(files, 32, async (file) => {
        try {
            const filePath = path.join(folderPath, file);
            const uri = URI.file(filePath).toString();
            const openDoc = documents.get(uri);
            const doc = openDoc ?? TextDocument.create(uri, 'ca65', 0, await fs.readFile(filePath, 'utf-8'));

            docs.push(doc);
            if (!symbolTables.has(uri)) {
                symbolTables.set(uri, new SymbolTable(doc.uri));
            }
        } catch (e) {
            connection.console.error(`Failed to scan ${file}: ${e}`);
        }
    });

    await mapWithConcurrency(docs, 32, async (doc) => {
        try {
            const symbolTable = await scanDocument(doc);
            symbolTables.set(doc.uri, symbolTable);
            includesGraph.updateIncludes(doc.uri, symbolTable.includedFiles);
            exportsMap.updateExports(doc.uri, symbolTable.exports);
        } catch (e) {
            connection.console.error(`Failed to parse ${doc.uri}: ${e}`);
        }
    });
}

connection.onInitialized(async () => {
    try {
        // Load data for mnemonic and directive hovers
        loadAllData(connection);

        // Initial scan of all symbol tables so includes graph and import/export info are available.
        await performanceMonitor.timeAsync('onInitialized', async () => {
            const allGlobs = await getDiscoveryGlobs();
            for (const folderUri of workspaceFolderUris) {
                await indexWorkspaceFolder(folderUri, allGlobs);
            }
        });
    } catch (e) {
        connection.console.error(`A critical error occurred during initialization: ${e}`);
    }

    initializationGate.open();

    try {
        connection.workspace?.onDidChangeWorkspaceFolders(async (event) => {
            try {
                await initializationGate.isInitialized;
                clearResolvedDirsCache();

                for (const removed of event.removed) {
                    workspaceFolderUris = workspaceFolderUris.filter(uri => uri !== removed.uri);
                    const prefix = removed.uri.endsWith('/') ? removed.uri : `${removed.uri}/`;
                    for (const uri of Array.from(symbolTables.keys())) {
                        if ((uri === removed.uri || uri.startsWith(prefix)) && !documents.get(uri)) {
                            deleteCachedResolutions(uri);
                            documentSettings.delete(uri);
                            symbolTables.delete(uri);
                            includesGraph.removeFile(uri);
                            exportsMap.removeUri(uri);
                            connection.sendDiagnostics({ uri, diagnostics: [] });
                        }
                    }
                }

                if (event.added.length > 0) {
                    const allGlobs = await getDiscoveryGlobs();
                    for (const added of event.added) {
                        if (!workspaceFolderUris.includes(added.uri)) {
                            workspaceFolderUris.push(added.uri);
                            await indexWorkspaceFolder(added.uri, allGlobs);
                        }
                    }
                }
            } catch (err) {
                connection.console.error(`Failed to handle workspace folder change: ${err}`);
            }
        });
    } catch (e) {
        connection.console.error(`Could not register workspace folder change listener: ${e}`);
    }
});

// Helper function to get the setting for a document
export function getDocumentSettings(resource: string): Thenable<Ca65Settings> {
    let result = documentSettings.get(resource);
    if (!result) {
        result = connection.workspace.getConfiguration({
            scopeUri: resource,
            section: 'ca65'
        }).then(
            settings => settings,
            err => {
                documentSettings.delete(resource);
                throw err;
            }
        );
        documentSettings.set(resource, result);
    }
    return result;
}

async function refreshDocumentSymbolTable(document: TextDocument): Promise<Set<string>> {
    const allAffectedUris: Set<string> = new Set(includesGraph.getTranslationUnit(document.uri));

    const isNewFile = !symbolTables.has(document.uri);
    const newSymbolTable = await scanDocument(document);
    symbolTables.set(document.uri, newSymbolTable);
    includesGraph.updateIncludes(document.uri, newSymbolTable.includedFiles);
    exportsMap.updateExports(document.uri, newSymbolTable.exports);

    allAffectedUris.add(document.uri);
    for (const uri of includesGraph.getTranslationUnit(document.uri)) {
        allAffectedUris.add(uri);
    }

    // If this is a newly created or discovered file, re-scan existing files that had an
    // unresolved .include matching it so the includesGraph connects them immediately.
    if (isNewFile) {
        const newFileBaseName = path.basename(URI.parse(document.uri).fsPath);
        for (const [otherUri, otherTable] of symbolTables) {
            if (otherUri === document.uri) continue;
            if (!otherTable.unresolvedIncludes.some(inc => path.basename(inc) === newFileBaseName)) {
                continue;
            }

            const otherSettings = await getDocumentSettings(otherUri);
            const resolvesToNewFile = otherTable.unresolvedIncludes.some(
                inc => resolveIncludeUri(otherUri, inc, otherSettings.includeDirs) === document.uri
            );
            if (!resolvesToNewFile) continue;

            let docToRescan = documents.get(otherUri);
            if (!docToRescan) {
                try {
                    const fsPath = URI.parse(otherUri).fsPath;
                    const content = await fs.readFile(fsPath, 'utf-8');
                    docToRescan = TextDocument.create(otherUri, 'ca65', 0, content);
                } catch {
                    continue;
                }
            }
            const updatedOtherTable = await scanDocument(docToRescan);
            symbolTables.set(otherUri, updatedOtherTable);
            includesGraph.updateIncludes(otherUri, updatedOtherTable.includedFiles);
            exportsMap.updateExports(otherUri, updatedOtherTable.exports);
        }
    }

    for (const uri of includesGraph.getTranslationUnit(document.uri)) {
        allAffectedUris.add(uri);
    }

    for (const uri of allAffectedUris) {
        deleteCachedResolutions(uri);
    }

    return allAffectedUris;
}

// --- Central Document Update and Validation Logic ---
async function updateAndValidate(document: TextDocument, debounce: boolean = true) {
    await initializationGate.isInitialized;
    abortValidation();
    await performanceMonitor.timeAsync('updateAndValidate', async () => {
        const allAffectedUris = await refreshDocumentSymbolTable(document);
        triggerValidation(document.uri, debounce, allAffectedUris);
    });
}

// Custom request from the client to dump performance stats
connection.onRequest('ca65/dumpPerformanceStats', () => {
    connection.console.info(performanceMonitor.getReport());
});

// Custom request from the client to dump symbol tables
connection.onRequest('ca65/dumpSymbolTables', () => {
    for (const table of symbolTables.values()) {
        connection.console.info(table.toString());
    }
});

// Custom request from the client to dump include graph
connection.onRequest('ca65/dumpIncludesGraph', () => {
    connection.console.info('Current Includes Graph:');
    connection.console.info(includesGraph.toString());
});

// Custom request from the client to dump exports map
connection.onRequest('ca65/dumpExportsMap', () => {
    connection.console.info(exportsMap.toString());
});

// Custom request from the client to estimate cycles and byte sizes in a range
connection.onRequest('ca65/analyzeSelection', async (params: { uri?: string; range?: Range }) => {
    await initializationGate.isInitialized;
    if (!params?.uri || !params?.range) {
        return null;
    }
    const document = documents.get(params.uri);
    if (!document) {
        return null;
    }
    const symbolTable = symbolTables.get(params.uri);
    const settings = await getDocumentSettings(params.uri);
    return analyzeInstructionRange(
        document,
        params.range,
        symbolTable,
        symbolTables,
        includesGraph,
        settings.implicitImports
    );
});

// --- Event Listeners ---
const lastDocumentVersions = new Map<string, number>();

connection.onDidChangeConfiguration(async () => {
    try {
        documentSettings.clear();
        clearResolvedDirsCache();
        clearExecutablePathCache();
        invalidateOverlaySignatures();
        await initializationGate.isInitialized;
        abortValidation();

        const openDocs = documents.all();
        for (const doc of openDocs) {
            await refreshDocumentSymbolTable(doc);
        }

        const validatedRoots = new Set<string>();
        for (const doc of openDocs) {
            const roots = Array.from(includesGraph.getIncludingRoots(doc.uri));
            const unvalidatedRoots = roots.filter(root => !validatedRoots.has(root));
            if (roots.length === 0 || unvalidatedRoots.length > 0) {
                for (const root of roots) validatedRoots.add(root);
                triggerValidation(doc.uri, false);
            }
        }
    } catch (err) {
        connection.console.error(`Failed to handle configuration change: ${err}`);
    }
});

documents.onDidClose((event) => {
    documentSettings.delete(event.document.uri);
    lastDocumentVersions.delete(event.document.uri);
});

documents.onDidChangeContent(async (change) => {
    const doc = change.document;
    const isInitialOpen = !lastDocumentVersions.has(doc.uri);
    if (!isInitialOpen && lastDocumentVersions.get(doc.uri) === doc.version) {
        return;
    }
    lastDocumentVersions.set(doc.uri, doc.version);

    try {
        await updateAndValidate(doc, !isInitialOpen);
    } catch (err) {
        connection.console.error(`Failed to update document ${doc.uri}: ${err}`);
    }
});

connection.onDidChangeWatchedFiles(async (params: DidChangeWatchedFilesParams) => {
    await initializationGate.isInitialized;

    connection.console.log('Watched file change detected. Re-scanning affected files.');
    clearResolvedDirsCache();
    invalidateOverlaySignatures();
    for (const event of params.changes) {
        const openDoc = documents.get(event.uri);
        if (openDoc) {
            // Already handled via onDidSave or onDidChangeContent
            continue;
        }

        // Handle files not currently open
        try {
            if (event.type === FileChangeType.Deleted) {
                const affectedUris = new Set(includesGraph.getTranslationUnit(event.uri));
                affectedUris.delete(event.uri);

                for (const uri of affectedUris) {
                    deleteCachedResolutions(uri);
                }
                deleteCachedResolutions(event.uri);
                documentSettings.delete(event.uri);

                symbolTables.delete(event.uri);
                includesGraph.removeFile(event.uri);
                exportsMap.removeUri(event.uri);
                connection.sendDiagnostics({ uri: event.uri, diagnostics: [] });

                for (const otherUri of affectedUris) {
                    const otherTable = symbolTables.get(otherUri);
                    if (otherTable?.includedFiles.includes(event.uri)) {
                        let docToRescan = documents.get(otherUri);
                        if (!docToRescan) {
                            try {
                                const content = await fs.readFile(URI.parse(otherUri).fsPath, 'utf-8');
                                docToRescan = TextDocument.create(otherUri, 'ca65', 0, content);
                            } catch {
                                continue;
                            }
                        }
                        const updatedTable = await scanDocument(docToRescan);
                        symbolTables.set(otherUri, updatedTable);
                        includesGraph.updateIncludes(otherUri, updatedTable.includedFiles);
                        exportsMap.updateExports(otherUri, updatedTable.exports);
                    }
                }

                for (const remainingUri of affectedUris) {
                    if (includesGraph.isTranslationUnitRoot(remainingUri)) {
                        triggerValidation(remainingUri, false);
                    }
                }
                continue;
            }

            const filePath = URI.parse(event.uri).fsPath;
            const content = await fs.readFile(filePath, 'utf-8');
            const doc = TextDocument.create(event.uri, 'ca65', 0, content);
            await updateAndValidate(doc);
        } catch (err) {
            connection.console.error(`Failed to handle watched file: ${event.uri}, error: ${err}`);
        }
    }
});

// --- Initialize Features from Modules ---
initializeDiagnostics(connection, documents);
initializeHoverProvider(connection, documents);
initializeDocumentSymbolProvider(connection);
initializeDefinitionProvider(connection, documents);
initializeReferencesProvider(connection, documents);
initializeFoldingRangeProvider(connection);
initializeDocumentLinkProvider(connection, documents);
initializeCallHierarchyProvider(connection, documents);
initializeRenameProvider(connection, documents);
initializeWorkspaceSymbolProvider(connection);
initializeCompletionProvider(connection, documents);
initializeInlayHintProvider(connection, documents);
initializeDocumentHighlightProvider(connection, documents);
initializeCodeActionProvider(connection, documents);
initializeOverlayProvider(connection, documents);

// --- Start the server ---
documents.listen(connection);
connection.listen();
