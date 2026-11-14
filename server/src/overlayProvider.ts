import { _Connection, TextDocuments } from 'vscode-languageserver/node';
import { TextDocument } from 'vscode-languageserver-textdocument';
import { URI } from 'vscode-uri';
import * as fs from 'fs/promises';
import { assembleTranslationUnit } from './diagnostics';
import { LstLineInfo, parseLstContent } from './lstParser';
import { resolveWorkspaceRelativeDirs } from './pathUtils';
import {
    getDocumentSettings,
    includesGraph,
    initializationGate,
    performanceMonitor,
} from './server';
import { Ca65Settings } from './settings';

export type OverlaySourceKind = 'live-lst' | 'none';

export interface OverlayLineItem {
    line: number;
    addressLabel: string;
    bytesText?: string;
    byteCount: number;
}

export interface OverlayDataResponse {
    source: OverlaySourceKind;
    stale?: boolean;
    error?: boolean;
    lines: OverlayLineItem[];
}

interface ValidLstCacheEntry {
    signature: string;
    byUri: Map<string, Map<number, LstLineInfo>>;
}

const lastValidLstCache = new Map<string, ValidLstCacheEntry>();
const activeOverlayControllers = new Map<string, AbortController>();

export function clearOverlayCaches(): void {
    lastValidLstCache.clear();
}

export function invalidateOverlaySignatures(): void {
    for (const entry of lastValidLstCache.values()) {
        entry.signature = '';
    }
}

function formatHexAddr(addr: number): string {
    const width = addr <= 0xFF ? 2 : 4;
    return '$' + (addr >>> 0).toString(16).toUpperCase().padStart(width, '0');
}

function normalizeListingBytesText(bytesText: string, byteCount: number): string | undefined {
    if (!bytesText) return undefined;
    if (/^xx(?:\s+xx)*$/i.test(bytesText.trim())) {
        return `res ${byteCount}B`;
    }
    return bytesText;
}

function mapLstLinesToOverlay(lstLines: Map<number, LstLineInfo>): OverlayLineItem[] {
    const items: OverlayLineItem[] = [];
    for (const entry of lstLines.values()) {
        const addrText = formatHexAddr(entry.offset);
        items.push({
            line: entry.line,
            addressLabel: entry.isRelocatable ? `+${addrText}r` : addrText,
            bytesText: normalizeListingBytesText(entry.bytesText, entry.byteCount),
            byteCount: entry.byteCount,
        });
    }
    items.sort((a, b) => a.line - b.line);
    return items;
}

function getTuSignature(
    rootUri: string,
    tuUris: Iterable<string>,
    documents: TextDocuments<TextDocument>,
    settings: Ca65Settings | null | undefined
): string {
    const docVersions: string[] = [];
    for (const uri of Array.from(tuUris).sort()) {
        const openDoc = documents.get(uri);
        docVersions.push(`${uri}@${openDoc ? openDoc.version : 'disk'}`);
    }
    const includeDirsKey = Array.isArray(settings?.includeDirs) ? settings.includeDirs.join(',') : '';
    const binIncludeDirsKey = Array.isArray(settings?.binIncludeDirs) ? settings.binIncludeDirs.join(',') : '';
    return `${rootUri}|${Boolean(settings?.implicitImports)}|${Boolean(settings?.lineContinuations)}|${includeDirsKey}|${binIncludeDirsKey}|${docVersions.join(';')}`;
}

export function initializeOverlayProvider(connection: _Connection, documents: TextDocuments<TextDocument>): void {
    connection.onRequest('ca65/getOverlayData', async (params: { uri?: string }): Promise<OverlayDataResponse> => {
        await initializationGate.isInitialized;
        if (!params?.uri) return { source: 'none', lines: [] };

        const targetUri = params.uri;

        // Abort any previous listing run for the same URI
        activeOverlayControllers.get(targetUri)?.abort();
        const controller = new AbortController();
        activeOverlayControllers.set(targetUri, controller);
        const signal = controller.signal;

        try {
            return await performanceMonitor.timeAsync('getOverlayData', async () => {
                const settings = await getDocumentSettings(targetUri);
                if (signal.aborted) return { source: 'none', lines: [] };

                const roots = Array.from(includesGraph.getIncludingRoots(targetUri));
                const rootUri = roots[0] ?? targetUri;
                const tuUris = new Set<string>(includesGraph.getTranslationUnit(targetUri));
                tuUris.add(targetUri);
                tuUris.add(rootUri);

                const signature = getTuSignature(rootUri, tuUris, documents, settings);
                const cached = lastValidLstCache.get(rootUri);
                if (cached && cached.signature === signature) {
                    const cachedLines = cached.byUri.get(targetUri) ?? new Map();
                    return {
                        source: 'live-lst',
                        stale: false,
                        lines: mapLstLinesToOverlay(cachedLines),
                    };
                }

                let rootDoc = documents.get(rootUri) ?? null;
                if (!rootDoc) {
                    try {
                        const content = await fs.readFile(URI.parse(rootUri).fsPath, 'utf-8');
                        rootDoc = TextDocument.create(rootUri, 'ca65', 0, content);
                    } catch {
                        rootDoc = null;
                    }
                }

                const assembled = rootDoc
                    ? await assembleTranslationUnit(rootDoc, signal, {
                        generateListing: true,
                        ignoreDiagnosticSetting: true,
                    })
                    : null;

                if (signal.aborted) return { source: 'none', lines: [] };

                if (assembled && !assembled.hasErrors && assembled.listingContent) {
                    const includeDirs = resolveWorkspaceRelativeDirs(rootUri, settings?.includeDirs);
                    const byUri = parseLstContent(assembled.listingContent, rootUri, includeDirs);
                    lastValidLstCache.set(rootUri, { signature, byUri });
                    const targetLines = byUri.get(targetUri) ?? new Map();
                    return {
                        source: 'live-lst',
                        stale: false,
                        lines: mapLstLinesToOverlay(targetLines),
                    };
                }

                // Assembly failed or ca65 was unavailable: keep last valid output marked stale if available.
                const hasErrors = Boolean(assembled?.hasErrors);
                if (cached) {
                    const prevLines = cached.byUri.get(targetUri) ?? new Map();
                    return {
                        source: 'live-lst',
                        stale: true,
                        error: hasErrors,
                        lines: mapLstLinesToOverlay(prevLines),
                    };
                }

                return {
                    source: 'none',
                    error: hasErrors,
                    lines: [],
                };
            });
        } finally {
            if (activeOverlayControllers.get(targetUri) === controller) {
                activeOverlayControllers.delete(targetUri);
            }
        }
    });
}
