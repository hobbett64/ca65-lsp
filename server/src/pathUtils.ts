import * as path from 'path';
import * as fsSync from 'fs';
import { URI } from 'vscode-uri';
import { symbolTables, workspaceFolderUris } from './server';
import * as fs from 'fs/promises';

const IGNORED_WALK_DIRS = new Set(['.git', 'node_modules', 'build', 'dist', 'out']);

function hasGlobMagic(pattern: string): boolean {
    return /[*?{[]/.test(pattern);
}

/**
 * Converts a workspace-relative glob pattern (`**`, `*`, `?`, `{a,b}`, `[...]`) into an anchored RegExp matching `/`-normalized relative paths.
 */
export function globPatternToRegExp(pattern: string): RegExp {
    const normalized = pattern.replace(/\\/g, '/').replace(/^(?:\.\/)+/, '').replace(/^\/+/, '').replace(/\/+$/, '');
    let out = '^';
    let i = 0;

    while (i < normalized.length) {
        if (normalized.startsWith('**/', i)) {
            out += '(?:.+/)?';
            i += 3;
            continue;
        }
        if (normalized.startsWith('/**', i) && i + 3 === normalized.length) {
            out += '(?:/.*)?';
            i += 3;
            continue;
        }
        if (normalized.startsWith('**', i)) {
            out += '.*';
            i += 2;
            continue;
        }

        const ch = normalized[i];
        if (ch === '*') {
            out += '[^/]*';
            i++;
        } else if (ch === '?') {
            out += '[^/]';
            i++;
        } else if (ch === '{') {
            const closeIdx = normalized.indexOf('}', i + 1);
            if (closeIdx > i + 1 && !normalized.slice(i + 1, closeIdx).includes('{')) {
                const parts = normalized.slice(i + 1, closeIdx).split(',').map(part =>
                    globPatternToRegExp(part).source.slice(1, -1)
                );
                out += `(?:${parts.join('|')})`;
                i = closeIdx + 1;
                continue;
            }
            out += '\\{';
            i++;
        } else if (ch === '[') {
            const closeIdx = normalized.indexOf(']', i + 1);
            if (closeIdx > i + 1) {
                let inner = normalized.slice(i + 1, closeIdx);
                if (inner.startsWith('!')) {
                    inner = `^${inner.slice(1)}`;
                }
                out += `[${inner}]`;
                i = closeIdx + 1;
                continue;
            }
            out += '\\[';
            i++;
        } else if ('.+^$()|\\'.includes(ch)) {
            out += `\\${ch}`;
            i++;
        } else {
            out += ch;
            i++;
        }
    }

    return new RegExp(`${out}$`);
}

function buildFileMatcher(patterns: readonly string[]): (relSlashPath: string, entryName: string) => boolean {
    const extMatches: string[] = [];
    const regexes: RegExp[] = [];

    for (const pat of patterns) {
        const trimmed = pat.trim();
        if (!trimmed) continue;
        // Fast path for `**/*.ext` or `*.ext`
        const simpleExt = trimmed.match(/^(?:\*\*\/)?\*(\.[^*/?{}[\]\\]+)$/);
        if (simpleExt) {
            extMatches.push(simpleExt[1]);
        } else {
            regexes.push(globPatternToRegExp(trimmed));
        }
    }

    return (relSlashPath: string, entryName: string): boolean => {
        for (let i = 0; i < extMatches.length; i++) {
            if (entryName.endsWith(extMatches[i])) return true;
        }
        for (let i = 0; i < regexes.length; i++) {
            if (regexes[i].test(relSlashPath)) return true;
        }
        return false;
    };
}

/**
 * Walks `rootDir` (skipping `.git`, `node_modules`, `build`, `dist`, `out`) and returns relative paths matching `patterns`.
 */
export async function findMatchingFiles(rootDir: string, patterns: readonly string[]): Promise<string[]> {
    if (patterns.length === 0) return [];
    const matches = buildFileMatcher(patterns);
    const results: string[] = [];
    const visitedRealDirs = new Set<string>();

    const walk = async (absDir: string, relDirSlash: string): Promise<void> => {
        let realDir: string;
        try {
            realDir = await fs.realpath(absDir);
        } catch {
            return;
        }
        if (visitedRealDirs.has(realDir)) return;
        visitedRealDirs.add(realDir);

        let entries: fsSync.Dirent[];
        try {
            entries = await fs.readdir(absDir, { withFileTypes: true });
        } catch {
            return;
        }

        const subdirs: Array<{ abs: string; relSlash: string }> = [];
        for (const entry of entries) {
            if (IGNORED_WALK_DIRS.has(entry.name)) continue;

            let isDir = entry.isDirectory();
            let isFile = entry.isFile();
            if (!isDir && !isFile && entry.isSymbolicLink()) {
                try {
                    const st = await fs.stat(path.join(absDir, entry.name));
                    isDir = st.isDirectory();
                    isFile = st.isFile();
                } catch {
                    continue;
                }
            }

            const relSlash = relDirSlash ? `${relDirSlash}/${entry.name}` : entry.name;
            if (isDir) {
                subdirs.push({ abs: path.join(absDir, entry.name), relSlash });
            } else if (isFile && matches(relSlash, entry.name)) {
                results.push(path.sep === '/' ? relSlash : relSlash.replace(/\//g, path.sep));
            }
        }

        for (const sub of subdirs) {
            await walk(sub.abs, sub.relSlash);
        }
    };

    await walk(rootDir, '');
    return results;
}

function findMatchingDirsSync(rootDir: string, patterns: readonly string[]): string[] {
    if (patterns.length === 0) return [];
    const regexes = patterns.map(globPatternToRegExp);
    const results: string[] = [];
    const visitedRealDirs = new Set<string>();

    const walkSync = (absDir: string, relDirSlash: string): void => {
        let realDir: string;
        try {
            realDir = fsSync.realpathSync(absDir);
        } catch {
            return;
        }
        if (visitedRealDirs.has(realDir)) return;
        visitedRealDirs.add(realDir);

        let entries: fsSync.Dirent[];
        try {
            entries = fsSync.readdirSync(absDir, { withFileTypes: true });
        } catch {
            return;
        }

        for (const entry of entries) {
            if (IGNORED_WALK_DIRS.has(entry.name)) continue;

            const absEntry = path.join(absDir, entry.name);
            let isDir = entry.isDirectory();
            if (!isDir && entry.isSymbolicLink()) {
                try {
                    isDir = fsSync.statSync(absEntry).isDirectory();
                } catch {
                    continue;
                }
            }
            if (!isDir) continue;

            const relSlash = relDirSlash ? `${relDirSlash}/${entry.name}` : entry.name;
            if (regexes.some(re => re.test(relSlash))) {
                results.push(absEntry);
            }
            walkSync(absEntry, relSlash);
        }
    };

    walkSync(rootDir, '');
    return results;
}

const MAX_URI_CACHE_SIZE = 4096;

interface WorkspaceFolderEntry {
    uri: string;
    prefix: string;
    fsPath: string;
}

let cachedWorkspaceFoldersSource: string[] | null = null;
let cachedWorkspaceFoldersLength = -1;
let cachedWorkspaceFolderEntries: WorkspaceFolderEntry[] = [];

const uriToFsPathCache = new Map<string, string>();
const fsPathToUriCache = new Map<string, string>();
const uriDirnameCache = new Map<string, string>();
const workspaceRelPathCache = new Map<string, string | null>();
const workspaceFolderLookupCache = new Map<string, WorkspaceFolderEntry | null>();
const resolvedDirsCache = new Map<string, string[]>();
const searchDirsCache = new Map<string, string[]>();
const EMPTY_STRING_ARRAY: string[] = [];

function getSortedWorkspaceFolderEntries(): WorkspaceFolderEntry[] {
    if (
        cachedWorkspaceFoldersSource !== workspaceFolderUris
        || cachedWorkspaceFoldersLength !== workspaceFolderUris.length
    ) {
        cachedWorkspaceFoldersSource = workspaceFolderUris;
        cachedWorkspaceFoldersLength = workspaceFolderUris.length;
        workspaceRelPathCache.clear();
        workspaceFolderLookupCache.clear();
        resolvedDirsCache.clear();
        searchDirsCache.clear();
        cachedWorkspaceFolderEntries = workspaceFolderUris
            .map(uri => ({
                uri,
                prefix: uri.endsWith('/') ? uri : `${uri}/`,
                fsPath: URI.parse(uri).fsPath,
            }))
            .sort((a, b) => b.uri.length - a.uri.length);
    }
    return cachedWorkspaceFolderEntries;
}

function getWorkspaceFolderEntry(fileUri: string): WorkspaceFolderEntry | undefined {
    getSortedWorkspaceFolderEntries();
    const cached = workspaceFolderLookupCache.get(fileUri);
    if (cached !== undefined) {
        return cached ?? undefined;
    }

    let found: WorkspaceFolderEntry | null = null;
    for (const entry of cachedWorkspaceFolderEntries) {
        if (fileUri === entry.uri || fileUri.startsWith(entry.prefix)) {
            found = entry;
            break;
        }
    }
    if (workspaceFolderLookupCache.size >= MAX_URI_CACHE_SIZE) {
        workspaceFolderLookupCache.clear();
    }
    workspaceFolderLookupCache.set(fileUri, found);
    return found ?? undefined;
}

export function uriToFsPath(uri: string): string {
    let cached = uriToFsPathCache.get(uri);
    if (cached !== undefined) return cached;

    cached = URI.parse(uri).fsPath;
    if (uriToFsPathCache.size >= MAX_URI_CACHE_SIZE) {
        uriToFsPathCache.clear();
    }
    uriToFsPathCache.set(uri, cached);
    return cached;
}

function uriDirname(uri: string): string {
    let cached = uriDirnameCache.get(uri);
    if (cached !== undefined) return cached;

    cached = path.dirname(uriToFsPath(uri));
    if (uriDirnameCache.size >= MAX_URI_CACHE_SIZE) {
        uriDirnameCache.clear();
    }
    uriDirnameCache.set(uri, cached);
    return cached;
}

export function fsPathToUri(fsPath: string): string {
    let cached = fsPathToUriCache.get(fsPath);
    if (cached !== undefined) return cached;

    cached = URI.file(fsPath).toString();
    if (fsPathToUriCache.size >= MAX_URI_CACHE_SIZE) {
        fsPathToUriCache.clear();
    }
    fsPathToUriCache.set(fsPath, cached);
    return cached;
}

export function getWorkspaceRelativePath(fileUri: string): string | null {
    getSortedWorkspaceFolderEntries();
    if (workspaceRelPathCache.has(fileUri)) {
        return workspaceRelPathCache.get(fileUri) ?? null;
    }
    const entry = getWorkspaceFolderEntry(fileUri);
    const rel = entry ? path.relative(entry.fsPath, uriToFsPath(fileUri)) : null;
    if (workspaceRelPathCache.size >= MAX_URI_CACHE_SIZE) {
        workspaceRelPathCache.clear();
    }
    workspaceRelPathCache.set(fileUri, rel);
    return rel;
}

export function getWorkspaceFolderOfFile(fileUri: string): string | undefined {
    return getWorkspaceFolderEntry(fileUri)?.uri;
}

export function clearResolvedDirsCache(): void {
    resolvedDirsCache.clear();
    searchDirsCache.clear();
    workspaceRelPathCache.clear();
    workspaceFolderLookupCache.clear();
    cachedWorkspaceFoldersSource = null;
    cachedWorkspaceFoldersLength = -1;
}

export function resolveWorkspaceRelativeDirs(
    currentFileUri: string,
    relativeDirs: string[] | undefined
): string[] {
    if (!relativeDirs || relativeDirs.length === 0) return EMPTY_STRING_ARRAY;
    const entry = getWorkspaceFolderEntry(currentFileUri);
    if (!entry) return EMPTY_STRING_ARRAY;

    const workspaceRoot = entry.fsPath;
    const dirsKey = relativeDirs.length === 1 ? relativeDirs[0] : relativeDirs.join('|');
    const cacheKey = `${workspaceRoot}\0${dirsKey}`;
    const cached = resolvedDirsCache.get(cacheKey);
    if (cached) {
        return cached;
    }

    const resolvedPaths: string[] = [];
    const globPatterns: string[] = [];

    for (const dirPattern of relativeDirs) {
        if (!hasGlobMagic(dirPattern)) {
            const candidate = path.resolve(workspaceRoot, dirPattern);
            if (fsSync.existsSync(candidate)) {
                resolvedPaths.push(candidate);
            }
            continue;
        }
        globPatterns.push(dirPattern);
    }

    if (globPatterns.length > 0) {
        resolvedPaths.push(...findMatchingDirsSync(workspaceRoot, globPatterns));
    }

    const uniquePaths = Array.from(new Set(resolvedPaths));
    resolvedDirsCache.set(cacheKey, uniquePaths);
    return uniquePaths;
}

export function getSearchDirectories(
    currentFileUri: string,
    relativeDirs: string[] | undefined,
): string[] {
    const currentDir = uriDirname(currentFileUri);
    const entry = getWorkspaceFolderEntry(currentFileUri);
    const workspaceRoot = entry?.fsPath;
    const dirsKey = !relativeDirs || relativeDirs.length === 0
        ? ''
        : (relativeDirs.length === 1 ? relativeDirs[0] : relativeDirs.join('|'));
    const cacheKey = `${currentDir}\0${workspaceRoot ?? ''}\0${dirsKey}`;
    const cached = searchDirsCache.get(cacheKey);
    if (cached) {
        return cached;
    }

    const resolvedDirs = resolveWorkspaceRelativeDirs(currentFileUri, relativeDirs);
    const searchDirs = [
        currentDir,
        ...(workspaceRoot && workspaceRoot !== currentDir ? [workspaceRoot] : []),
        ...resolvedDirs
    ];
    if (searchDirsCache.size >= MAX_URI_CACHE_SIZE) {
        searchDirsCache.clear();
    }
    searchDirsCache.set(cacheKey, searchDirs);
    return searchDirs;
}

export function resolveIncludeUri(
    currentFileUri: string,
    includeFile: string,
    includeDirs: string[] | undefined,
): string | null {
    for (const dir of getSearchDirectories(currentFileUri, includeDirs)) {
        const fullPath = path.join(dir, includeFile);
        const uri = fsPathToUri(fullPath);
        if (symbolTables.has(uri)) {
            return uri;
        }
    }

    return null;
}

export async function resolveIncbinUri(
    currentFileUri: string,
    incbinFile: string,
    binIncludeDirs: string[] | undefined,
): Promise<string | null> {
    for (const dir of getSearchDirectories(currentFileUri, binIncludeDirs)) {
        const fullPath = path.join(dir, incbinFile);
        try {
            const stat = await fs.stat(fullPath);
            if (stat.isFile()) {
                return fsPathToUri(fullPath);
            }
        } catch {
            // File does not exist in this directory, continue searching
        }
    }

    return null;
}

/**
 * Synchronously resolves an `.incbin` asset path and returns its byte size, or `null` if unavailable.
 */
export function resolveIncbinFileSizeSync(
    currentFileUri: string,
    incbinFile: string,
    binIncludeDirs: string[] | undefined,
): number | null {
    for (const dir of getSearchDirectories(currentFileUri, binIncludeDirs)) {
        const fullPath = path.join(dir, incbinFile);
        try {
            const stat = fsSync.statSync(fullPath);
            if (stat.isFile()) {
                return stat.size;
            }
        } catch {
            // File does not exist in this directory, continue searching
        }
    }

    return null;
}

export function findCanonicalIncludePath(
    currentFileUri: string,
    importFileUri: string,
    includeDirs: string[] | undefined,
): string {
    const currentDir = path.dirname(uriToFsPath(currentFileUri));
    const importFsPath = uriToFsPath(importFileUri);

    const candidates: string[] = [];

    // Current file directory
    candidates.push(path.relative(currentDir, importFsPath));

    // From include dirs
    const resolvedIncludeDirs = resolveWorkspaceRelativeDirs(currentFileUri, includeDirs);
    for (const incDir of resolvedIncludeDirs) {
        const relPath = path.relative(incDir, importFsPath);
        candidates.push(relPath);
    }

    candidates.sort((a, b) => {
        const aBack = a.includes('..') ? 1 : 0;
        const bBack = b.includes('..') ? 1 : 0;
        if (aBack !== bBack) return aBack - bBack;
        return a.length - b.length;
    });

    for (const candidate of candidates) {
        const resolvedUri = resolveIncludeUri(currentFileUri, candidate, includeDirs);
        if (resolvedUri && resolvedUri === importFileUri) {
            return candidate; // Found canonical relative path
        }
    }

    return path.relative(currentDir, importFsPath);
}
