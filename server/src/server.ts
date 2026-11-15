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
import * as path from 'path';
import * as fs from 'fs/promises';
import { glob } from 'glob';

import { loadAllData } from './dataManager';
import {
    abortValidation,
    addPendingValidationFiles,
    clearExecutablePathCache,
    hasPendingValidation,
    initializeDiagnostics,
    triggerValidation,
} from './diagnostics';
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
import { initializeCodeLensProvider } from './codeLensProvider';
import { initializeSignatureHelpProvider } from './signatureHelpProvider';
import { initializeCodeActionProvider } from './codeActionProvider';
import { analyzeInstructionRange } from './instructionAnalyzer';
import { invalidateOverlaySignatures, initializeOverlayProvider } from './overlayProvider';
import { deleteCachedResolutions } from './symbolResolver';
import { ExportsMap } from './exportsMap';
import { Ca65Settings, documentSettings } from './settings';
import { Performance as PerformanceMonitor } from './performance';
import {
    clearResolvedDirsCache,
    fsPathToUri,
    getWorkspaceFolderOfFile,
    resolveIncludeUri,
    uriToFsPath,
} from './pathUtils';
import {
    clearDocumentDirtyState,
    clearUnopenedDocumentCache,
    getCachedTextDocument,
    invalidateCachedDocument,
    markDocumentModifiedSinceSave,
    markDocumentSaved,
} from './documentCache';

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
        clearResolvedDirsCache();
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
                triggerCharacters: ['.', '@', ':', '"', '/'],
                resolveProvider: true,
            },
            codeLensProvider: {
                resolveProvider: false,
            },
            signatureHelpProvider: {
                triggerCharacters: [' ', '(', ','],
                retriggerCharacters: [','],
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
        const configs = await connection.workspace.getConfiguration([
            { section: 'files' },
            { section: 'ca65' },
        ]);
        const config = Array.isArray(configs) ? configs[0] : undefined;
        const ca65Config = Array.isArray(configs) ? configs[1] : undefined;

        const associations = config?.associations || {};
        for (const [pattern, langId] of Object.entries(associations)) {
            if (langId !== 'ca65') continue;
            configuredGlobs.push(
                !pattern.includes('/') && !pattern.includes('\\')
                    ? `**/${pattern}`
                    : pattern
            );
        }

        const customExtensions = Array.isArray(ca65Config?.additionalExtensions)
            ? ca65Config.additionalExtensions
            : [];
        for (const ext of customExtensions) {
            if (typeof ext !== 'string' || !ext) continue;
            const cleanExt = ext.startsWith('.') ? ext : `.${ext}`;
            configuredGlobs.push(`**/*${cleanExt}`);
        }
    } catch (e) {
        connection.console.error(`Could not fetch workspace discovery configuration from client: ${e}`);
    }

    return [...new Set([...defaultGlobs, ...configuredGlobs])];
}

async function indexWorkspaceFolder(folderUri: string, globs: string[]): Promise<void> {
    const folderPath = uriToFsPath(folderUri);
    const files = await glob(globs, {
        cwd: folderPath,
        nodir: true,
        ignore: ['**/.git/**', '**/node_modules/**', '**/build/**', '**/dist/**', '**/out/**']
    });

    const docs: TextDocument[] = [];
    await mapWithConcurrency(files, 32, async (file) => {
        try {
            const filePath = path.join(folderPath, file);
            const uri = fsPathToUri(filePath);
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
                    documentSettings.delete(removed.uri);
                    const prefix = removed.uri.endsWith('/') ? removed.uri : `${removed.uri}/`;
                    for (const uri of Array.from(symbolTables.keys())) {
                        if ((uri === removed.uri || uri.startsWith(prefix)) && !documents.get(uri)) {
                            deleteCachedResolutions(uri);
                            documentSettings.delete(uri);
                            invalidateCachedDocument(uri);
                            clearDocumentDirtyState(uri);
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
    const scopeKey = getWorkspaceFolderOfFile(resource) ?? resource;
    let result = documentSettings.get(scopeKey);
    if (!result) {
        result = connection.workspace.getConfiguration({
            scopeUri: scopeKey,
            section: 'ca65'
        }).then(
            settings => settings,
            err => {
                documentSettings.delete(scopeKey);
                throw err;
            }
        );
        documentSettings.set(scopeKey, result);
    }
    return result;
}

async function refreshDocumentSymbolTable(document: TextDocument): Promise<Set<string>> {
    const allAffectedUris: Set<string> = new Set(includesGraph.getTranslationUnitSet(document.uri));

    const isNewFile = !symbolTables.has(document.uri);
    const newSymbolTable = await scanDocument(document);
    symbolTables.set(document.uri, newSymbolTable);
    includesGraph.updateIncludes(document.uri, newSymbolTable.includedFiles);
    exportsMap.updateExports(document.uri, newSymbolTable.exports);

    allAffectedUris.add(document.uri);
    for (const uri of includesGraph.getTranslationUnitSet(document.uri)) {
        allAffectedUris.add(uri);
    }

    // If this is a newly created or discovered file, re-scan existing files that had an
    // unresolved .include matching it so the includesGraph connects them immediately.
    if (isNewFile) {
        const newFileBaseName = path.basename(uriToFsPath(document.uri));
        const candidates: Array<{ otherUri: string; otherTable: SymbolTable }> = [];
        for (const [otherUri, otherTable] of symbolTables) {
            if (otherUri === document.uri) continue;
            if (otherTable.unresolvedIncludes.some(inc => path.basename(inc) === newFileBaseName)) {
                candidates.push({ otherUri, otherTable });
            }
        }

        if (candidates.length > 0) {
            await mapWithConcurrency(candidates, 16, async ({ otherUri, otherTable }) => {
                const otherSettings = await getDocumentSettings(otherUri);
                const resolvesToNewFile = otherTable.unresolvedIncludes.some(
                    inc => resolveIncludeUri(otherUri, inc, otherSettings.includeDirs) === document.uri
                );
                if (!resolvesToNewFile) return;

                const docToRescan = await getCachedTextDocument(otherUri, documents);
                if (!docToRescan) return;

                const updatedOtherTable = await scanDocument(docToRescan);
                symbolTables.set(otherUri, updatedOtherTable);
                includesGraph.updateIncludes(otherUri, updatedOtherTable.includedFiles);
                exportsMap.updateExports(otherUri, updatedOtherTable.exports);
            });
            for (const uri of includesGraph.getTranslationUnitSet(document.uri)) {
                allAffectedUris.add(uri);
            }
        }
    }

    for (const uri of allAffectedUris) {
        deleteCachedResolutions(uri);
    }

    return allAffectedUris;
}

const REFRESH_DEBOUNCE_MS = 80;
const pendingRefreshDocs = new Map<string, TextDocument>();
const pendingScanTimers = new Map<string, NodeJS.Timeout>();
const pendingPreRefreshAffected = new Map<string, Set<string>>();
const inFlightRefreshes = new Map<string, Promise<void>>();

async function executeRefreshForDoc(doc: TextDocument): Promise<void> {
    const preAffected = pendingPreRefreshAffected.get(doc.uri);
    pendingPreRefreshAffected.delete(doc.uri);

    const allAffectedUris = await performanceMonitor.timeAsync('refreshDocumentSymbolTable', async () => {
        const affected = await refreshDocumentSymbolTable(doc);
        if (preAffected) {
            for (const u of preAffected) affected.add(u);
        }
        return affected;
    });
    if (hasPendingValidation(doc.uri)) {
        addPendingValidationFiles(doc.uri, allAffectedUris);
    } else {
        triggerValidation(doc.uri, true, allAffectedUris);
    }
}

/**
 * Flushes any pending debounced or in-flight document refreshes so callers
 * (hover, completion, diagnostics, etc.) observe up-to-date symbol tables.
 */
export async function ensureDocumentRefreshed(_uri?: string): Promise<void> {
    await initializationGate.isInitialized;
    while (pendingScanTimers.size > 0 || pendingRefreshDocs.size > 0 || inFlightRefreshes.size > 0) {
        for (const [uri, timer] of pendingScanTimers) {
            clearTimeout(timer);
            pendingScanTimers.delete(uri);
        }

        const inflight = Array.from(inFlightRefreshes.values());
        if (inflight.length > 0) {
            await Promise.all(inflight);
        }

        const pendingEntries = Array.from(pendingRefreshDocs.entries());
        if (pendingEntries.length === 0) {
            continue;
        }
        pendingRefreshDocs.clear();

        await Promise.all(pendingEntries.map(([uri, doc]) => {
            const p = executeRefreshForDoc(doc).finally(() => {
                if (inFlightRefreshes.get(uri) === p) {
                    inFlightRefreshes.delete(uri);
                }
            });
            inFlightRefreshes.set(uri, p);
            return p;
        }));
    }
}

function scheduleDocumentRefresh(doc: TextDocument): void {
    if (!pendingPreRefreshAffected.has(doc.uri)) {
        pendingPreRefreshAffected.set(doc.uri, new Set(includesGraph.getTranslationUnitSet(doc.uri)));
    }
    pendingRefreshDocs.set(doc.uri, doc);
    triggerValidation(doc.uri, true, pendingPreRefreshAffected.get(doc.uri));

    const existingTimer = pendingScanTimers.get(doc.uri);
    if (existingTimer) {
        clearTimeout(existingTimer);
    }
    pendingScanTimers.set(doc.uri, setTimeout(() => {
        pendingScanTimers.delete(doc.uri);
        void ensureDocumentRefreshed(doc.uri).catch((err) => {
            connection.console.error(`Failed to refresh document ${doc.uri}: ${err}`);
        });
    }, REFRESH_DEBOUNCE_MS));
}

// --- Central Document Update and Validation Logic ---
async function updateAndValidate(document: TextDocument, debounce: boolean = true) {
    await initializationGate.isInitialized;
    abortValidation();
    const timer = pendingScanTimers.get(document.uri);
    if (timer) {
        clearTimeout(timer);
        pendingScanTimers.delete(document.uri);
    }
    pendingRefreshDocs.delete(document.uri);
    const preAffected = pendingPreRefreshAffected.get(document.uri);
    pendingPreRefreshAffected.delete(document.uri);

    await performanceMonitor.timeAsync('updateAndValidate', async () => {
        const allAffectedUris = await refreshDocumentSymbolTable(document);
        if (preAffected) {
            for (const u of preAffected) allAffectedUris.add(u);
        }
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
    await ensureDocumentRefreshed(params.uri);
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
        clearUnopenedDocumentCache();
        invalidateOverlaySignatures();
        await ensureDocumentRefreshed();
        abortValidation();

        const openDocs = documents.all();
        await mapWithConcurrency(openDocs, 16, async (doc) => {
            await refreshDocumentSymbolTable(doc);
        });

        const validatedRoots = new Set<string>();
        for (const doc of openDocs) {
            const roots = includesGraph.getIncludingRootsArray(doc.uri);
            const hasUnvalidatedRoot = roots.some(root => !validatedRoots.has(root));
            if (roots.length === 0 || hasUnvalidatedRoot) {
                for (const root of roots) validatedRoots.add(root);
                triggerValidation(doc.uri, false);
            }
        }
    } catch (err) {
        connection.console.error(`Failed to handle configuration change: ${err}`);
    }
});

documents.onDidSave((event) => {
    markDocumentSaved(event.document.uri, event.document.version);
    invalidateCachedDocument(event.document.uri);
});

documents.onDidClose((event) => {
    const uri = event.document.uri;
    const timer = pendingScanTimers.get(uri);
    if (timer) {
        clearTimeout(timer);
        pendingScanTimers.delete(uri);
    }
    pendingRefreshDocs.delete(uri);
    pendingPreRefreshAffected.delete(uri);
    documentSettings.delete(uri);
    lastDocumentVersions.delete(uri);
    clearDocumentDirtyState(uri);
    invalidateCachedDocument(uri);
});

documents.onDidChangeContent(async (change) => {
    const doc = change.document;
    const isInitialOpen = !lastDocumentVersions.has(doc.uri);
    if (!isInitialOpen && lastDocumentVersions.get(doc.uri) === doc.version) {
        return;
    }
    lastDocumentVersions.set(doc.uri, doc.version);

    try {
        if (isInitialOpen) {
            await updateAndValidate(doc, false);
        } else {
            markDocumentModifiedSinceSave(doc.uri);
            scheduleDocumentRefresh(doc);
        }
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
        invalidateCachedDocument(event.uri);
        const openDoc = documents.get(event.uri);
        if (openDoc) {
            // Already handled via onDidSave or onDidChangeContent
            continue;
        }
        clearDocumentDirtyState(event.uri);

        // Handle files not currently open
        try {
            if (event.type === FileChangeType.Deleted) {
                const timer = pendingScanTimers.get(event.uri);
                if (timer) {
                    clearTimeout(timer);
                    pendingScanTimers.delete(event.uri);
                }
                pendingRefreshDocs.delete(event.uri);
                pendingPreRefreshAffected.delete(event.uri);

                const affectedUris = new Set(includesGraph.getTranslationUnitSet(event.uri));
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

                const rescannableUris = Array.from(affectedUris).filter(otherUri => {
                    const otherTable = symbolTables.get(otherUri);
                    return otherTable?.includedFiles.includes(event.uri);
                });
                await mapWithConcurrency(rescannableUris, 16, async (otherUri) => {
                    const docToRescan = await getCachedTextDocument(otherUri, documents);
                    if (!docToRescan) return;
                    const updatedTable = await scanDocument(docToRescan);
                    symbolTables.set(otherUri, updatedTable);
                    includesGraph.updateIncludes(otherUri, updatedTable.includedFiles);
                    exportsMap.updateExports(otherUri, updatedTable.exports);
                });

                for (const remainingUri of affectedUris) {
                    if (includesGraph.isTranslationUnitRoot(remainingUri)) {
                        triggerValidation(remainingUri, false);
                    }
                }
                continue;
            }

            const filePath = uriToFsPath(event.uri);
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
initializeSignatureHelpProvider(connection, documents);
initializeInlayHintProvider(connection, documents);
initializeDocumentHighlightProvider(connection, documents);
initializeCodeActionProvider(connection, documents);
initializeCodeLensProvider(connection, documents);
initializeOverlayProvider(connection, documents);

// --- Start the server ---
documents.listen(connection);
connection.listen();
