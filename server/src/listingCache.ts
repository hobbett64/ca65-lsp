import { TextDocument } from 'vscode-languageserver-textdocument';
import { IncludesGraph } from './includesGraph';
import { LstLineInfo, parseLstContent } from './lstParser';
import { Ca65Settings, normalizeCpu } from './settings';

export interface ValidLstCacheEntry {
    signature: string;
    rootUri: string;
    includeDirs: string[];
    rawListingContent?: string;
    byUri?: Map<string, Map<number, LstLineInfo>>;
}

export interface DocumentLookup {
    get(uri: string): TextDocument | undefined;
}

export type ListingStateKind = 'ready' | 'error' | 'pending';

const lastValidLstCache = new Map<string, ValidLstCacheEntry>();
const lastFailedBuildByRoot = new Map<string, string>();

/**
 * Collects the URIs belonging to `rootUri`'s translation unit.
 */
export function collectRootTuUris(
    rootUri: string,
    includesGraph: IncludesGraph,
    extraUri?: string
): Set<string> {
    const tuUris = new Set<string>(includesGraph.getTranslationUnitSet(rootUri));
    tuUris.add(rootUri);
    if (extraUri) {
        tuUris.add(extraUri);
    }
    return tuUris;
}

/**
 * Computes a version- and settings-stamped cache key for a translation unit assembly pass.
 */
export function computeTuSignature(
    rootUri: string,
    tuUris: Iterable<string>,
    docLookup: DocumentLookup,
    settings: Ca65Settings | null | undefined
): string {
    const docVersions: string[] = [];
    for (const uri of Array.from(tuUris).sort()) {
        const openDoc = docLookup.get(uri);
        docVersions.push(`${uri}@${openDoc ? openDoc.version : 'disk'}`);
    }
    const cpuKey = normalizeCpu(settings?.cpu);
    const exeKey = typeof settings?.executablePath === 'string' ? settings.executablePath : '';
    const includeDirsKey = Array.isArray(settings?.includeDirs) ? settings.includeDirs.join('\0') : '';
    const binIncludeDirsKey = Array.isArray(settings?.binIncludeDirs) ? settings.binIncludeDirs.join('\0') : '';
    const additionalArgsKey = Array.isArray(settings?.additionalArgs) ? settings.additionalArgs.join('\0') : '';
    return `${rootUri}|${cpuKey}|${exeKey}|${Boolean(settings?.implicitImports)}|${Boolean(settings?.cComments ?? true)}|${Boolean(settings?.lineContinuations ?? true)}|${includeDirsKey}|${binIncludeDirsKey}|${additionalArgsKey}|${docVersions.join(';')}`;
}

export function invalidateLstSignatures(): void {
    for (const entry of lastValidLstCache.values()) {
        entry.signature = '';
    }
    lastFailedBuildByRoot.clear();
}

export function getCachedLstEntry(rootUri: string): ValidLstCacheEntry | undefined {
    return lastValidLstCache.get(rootUri);
}

/**
 * Records a failed `ca65` assembly attempt for a translation unit signature.
 */
export function storeFailedLstAttempt(rootUri: string, signature: string): void {
    lastFailedBuildByRoot.set(rootUri, signature);
}

/**
 * Records raw `ca65 -l` output for a translation unit so consumers can parse it lazily on demand.
 */
export function storeValidLstEntry(
    rootUri: string,
    signature: string,
    includeDirs: string[],
    listingContent: string
): ValidLstCacheEntry {
    lastFailedBuildByRoot.delete(rootUri);
    const entry: ValidLstCacheEntry = {
        signature,
        rootUri,
        includeDirs,
        rawListingContent: listingContent,
    };
    lastValidLstCache.set(rootUri, entry);
    return entry;
}

/**
 * Lazily parses and caches per-URI line metadata from a stored listing entry.
 */
export function getOrParseLstByUri(entry: ValidLstCacheEntry): Map<string, Map<number, LstLineInfo>> {
    if (!entry.byUri) {
        entry.byUri = entry.rawListingContent
            ? parseLstContent(entry.rawListingContent, entry.rootUri, entry.includeDirs)
            : new Map();
        entry.rawListingContent = undefined;
    }
    return entry.byUri;
}

/**
 * Returns the live listing state and per-line `.lst` data for `targetUri` matching current buffers/settings.
 */
export async function getListingStateForUri(
    targetUri: string,
    documents: DocumentLookup,
    includesGraph: IncludesGraph,
    getSettings: (uri: string) => PromiseLike<Ca65Settings>,
    knownTargetSettings?: Ca65Settings
): Promise<{ status: ListingStateKind; lines?: ReadonlyMap<number, LstLineInfo> }> {
    const roots = includesGraph.getIncludingRootsArray(targetUri);
    const candidateRoots = roots.length > 0 ? roots : [targetUri];
    let sawError = false;

    for (const rootUri of candidateRoots) {
        const cached = lastValidLstCache.get(rootUri);
        const failedSig = lastFailedBuildByRoot.get(rootUri);
        if ((!cached || !cached.signature) && !failedSig) {
            continue;
        }
        const rootSettings = (rootUri === targetUri && knownTargetSettings)
            ? knownTargetSettings
            : await getSettings(rootUri);
        const tuUris = collectRootTuUris(
            rootUri,
            includesGraph,
            rootUri === targetUri ? undefined : targetUri
        );
        const expectedSig = computeTuSignature(rootUri, tuUris, documents, rootSettings);
        if (cached && cached.signature === expectedSig) {
            const byUri = getOrParseLstByUri(cached);
            const lines = byUri.get(targetUri);
            if (lines) {
                return { status: 'ready', lines };
            }
            if (rootUri === targetUri || tuUris.has(targetUri)) {
                return { status: 'ready' };
            }
        }
        if (failedSig && failedSig === expectedSig) {
            sawError = true;
        }
    }

    return { status: sawError ? 'error' : 'pending' };
}
