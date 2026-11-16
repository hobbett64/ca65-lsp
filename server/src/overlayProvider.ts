import * as path from 'path';
import { _Connection, TextDocuments } from 'vscode-languageserver/node';
import { TextDocument } from 'vscode-languageserver-textdocument';
import { assembleTranslationUnit, Ca65AssembleResult } from './diagnostics';
import { getCachedTextDocument } from './documentCache';
import {
    collectRootTuUris,
    computeTuSignature,
    getCachedLstEntry,
    getOrParseLstByUri,
    invalidateLstSignatures,
    storeFailedLstAttempt,
    storeValidLstEntry,
    ValidLstCacheEntry,
} from './listingCache';
import { formatListingAddressLabel, LstLineInfo, normalizeListingBytesText } from './lstParser';
import { resolveWorkspaceRelativeDirs } from './pathUtils';
import {
    ensureDocumentRefreshed,
    getDocumentSettings,
    includesGraph,
    initializationGate,
    performanceMonitor,
} from './server';

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
    errors?: string[];
    lines: OverlayLineItem[];
}

const MAX_OVERLAY_ERROR_LINES = 50;

function formatOverlayErrors(assembled: Ca65AssembleResult | null): string[] | undefined {
    if (!assembled?.hasErrors || !assembled.stderr) return undefined;
    const lines: string[] = [];
    const shadowFwd = assembled.shadowDir ? `${assembled.shadowDir.replace(/\\/g, '/')}/` : undefined;
    const shadowNative = assembled.shadowDir ? `${assembled.shadowDir}${path.sep}` : undefined;

    for (const rawLine of assembled.stderr.split(/\r?\n/)) {
        let line = rawLine.trimEnd();
        if (!line) continue;
        if (shadowNative) {
            line = line.split(shadowNative).join('');
        }
        if (shadowFwd && shadowFwd !== shadowNative) {
            line = line.split(shadowFwd).join('');
        }
        lines.push(line);
        if (lines.length >= MAX_OVERLAY_ERROR_LINES) {
            lines.push('…');
            break;
        }
    }
    return lines.length > 0 ? lines : undefined;
}

const mappedOverlayCache = new WeakMap<ValidLstCacheEntry, Map<string, OverlayLineItem[]>>();

function getMappedOverlayLines(entry: ValidLstCacheEntry, uri: string): OverlayLineItem[] {
    let perEntry = mappedOverlayCache.get(entry);
    if (!perEntry) {
        perEntry = new Map<string, OverlayLineItem[]>();
        mappedOverlayCache.set(entry, perEntry);
    }
    let mapped = perEntry.get(uri);
    if (!mapped) {
        const lstLines = getOrParseLstByUri(entry).get(uri);
        mapped = lstLines ? mapLstLinesToOverlay(lstLines) : [];
        perEntry.set(uri, mapped);
    }
    return mapped;
}

const activeOverlayControllers = new Map<string, AbortController>();

export function invalidateOverlaySignatures(): void {
    invalidateLstSignatures();
}

function mapLstLinesToOverlay(lstLines: Map<number, LstLineInfo>): OverlayLineItem[] {
    const items: OverlayLineItem[] = [];
    for (const entry of lstLines.values()) {
        items.push({
            line: entry.line,
            addressLabel: formatListingAddressLabel(entry),
            bytesText: normalizeListingBytesText(entry.bytesText, entry.byteCount),
            byteCount: entry.byteCount,
        });
    }
    items.sort((a, b) => a.line - b.line);
    return items;
}

export function initializeOverlayProvider(connection: _Connection, documents: TextDocuments<TextDocument>): void {
    connection.onRequest('ca65/getOverlayData', async (params: { uri?: string }): Promise<OverlayDataResponse> => {
        await initializationGate.isInitialized;
        if (!params?.uri) return { source: 'none', lines: [] };

        const targetUri = params.uri;
        await ensureDocumentRefreshed?.(targetUri);

        // Abort any previous listing run for the same URI
        activeOverlayControllers.get(targetUri)?.abort();
        const controller = new AbortController();
        activeOverlayControllers.set(targetUri, controller);
        const signal = controller.signal;

        try {
            return await performanceMonitor.timeAsync('getOverlayData', async () => {
                const roots = includesGraph.getIncludingRootsArray(targetUri);
                const rootUri = roots[0] ?? targetUri;
                const settings = await getDocumentSettings(rootUri);
                if (signal.aborted) return { source: 'none', lines: [] };

                const tuUris = collectRootTuUris(rootUri, includesGraph, rootUri === targetUri ? undefined : targetUri);
                const signature = computeTuSignature(rootUri, tuUris, documents, settings);
                const cached = getCachedLstEntry(rootUri);
                if (cached && cached.signature === signature) {
                    return {
                        source: 'live-lst',
                        stale: false,
                        lines: getMappedOverlayLines(cached, targetUri),
                    };
                }

                const rootDoc = await getCachedTextDocument(rootUri, documents);

                const assembled = rootDoc
                    ? await assembleTranslationUnit(rootDoc, signal, {
                        generateListing: true,
                        ignoreDiagnosticSetting: true,
                    })
                    : null;

                if (signal.aborted) return { source: 'none', lines: [] };

                if (assembled && !assembled.hasErrors && assembled.listingContent) {
                    const includeDirs = assembled.resolvedIncludeDirs
                        ?? resolveWorkspaceRelativeDirs(rootUri, settings?.includeDirs);
                    const newEntry = storeValidLstEntry(
                        rootUri,
                        assembled.tuSignature || signature,
                        includeDirs,
                        assembled.listingContent
                    );
                    return {
                        source: 'live-lst',
                        stale: false,
                        lines: getMappedOverlayLines(newEntry, targetUri),
                    };
                }

                // Assembly failed or ca65 was unavailable: surface error details (and keep last valid lines on server if available).
                const hasErrors = Boolean(assembled?.hasErrors);
                if (hasErrors && (assembled?.tuSignature || signature)) {
                    storeFailedLstAttempt(rootUri, assembled?.tuSignature || signature);
                }
                const errors = formatOverlayErrors(assembled);
                if (cached) {
                    return {
                        source: 'live-lst',
                        stale: true,
                        error: hasErrors,
                        errors,
                        lines: getMappedOverlayLines(cached, targetUri),
                    };
                }

                return {
                    source: 'none',
                    error: hasErrors,
                    errors,
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
