import * as path from 'path';
import * as fsSync from 'fs';
import { URI } from 'vscode-uri';
import { symbolTables, workspaceFolderUris } from './server';
import { globSync } from 'glob';
import * as fs from 'fs/promises';

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

    for (const dirPattern of relativeDirs) {
        if (!dirPattern.includes('*') && !dirPattern.includes('?') && !dirPattern.includes('{') && !dirPattern.includes('[')) {
            const candidate = path.resolve(workspaceRoot, dirPattern);
            if (fsSync.existsSync(candidate)) {
                resolvedPaths.push(candidate);
            }
            continue;
        }

        const expandedDirs = globSync(dirPattern, {
            cwd: workspaceRoot,
            absolute: true,
            nodir: false,
            ignore: ['**/.git/**', '**/node_modules/**', '**/build/**', '**/dist/**', '**/out/**']
        });
        resolvedPaths.push(...expandedDirs);
    }

    resolvedDirsCache.set(cacheKey, resolvedPaths);
    return resolvedPaths;
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
