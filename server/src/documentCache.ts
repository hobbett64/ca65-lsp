import * as fs from 'fs/promises';
import { TextDocument } from 'vscode-languageserver-textdocument';
import { TextDocuments } from 'vscode-languageserver/node';
import { uriToFsPath } from './pathUtils';

const MAX_UNOPENED_DOC_CACHE = 64;

const unopenedDocCache = new Map<string, TextDocument>();
const dirtySinceSave = new Set<string>();
const verifiedCleanVersions = new Map<string, number>();

export function invalidateCachedDocument(uri: string): void {
    unopenedDocCache.delete(uri);
}

export function clearUnopenedDocumentCache(): void {
    unopenedDocCache.clear();
}

export function markDocumentModifiedSinceSave(uri: string): void {
    dirtySinceSave.add(uri);
    verifiedCleanVersions.delete(uri);
}

export function markDocumentSaved(uri: string, version: number): void {
    dirtySinceSave.delete(uri);
    verifiedCleanVersions.set(uri, version);
}

export function clearDocumentDirtyState(uri: string): void {
    dirtySinceSave.delete(uri);
    verifiedCleanVersions.delete(uri);
}

/**
 * Returns true if an open document may differ from its on-disk copy.
 * Avoids repeated disk reads once a version is known clean or already marked dirty by an edit.
 */
export async function isOpenDocumentPotentiallyDirty(doc: TextDocument): Promise<boolean> {
    if (dirtySinceSave.has(doc.uri)) {
        return true;
    }
    if (verifiedCleanVersions.get(doc.uri) === doc.version) {
        return false;
    }
    try {
        const diskContent = await fs.readFile(uriToFsPath(doc.uri), 'utf-8');
        if (diskContent === doc.getText()) {
            verifiedCleanVersions.set(doc.uri, doc.version);
            return false;
        }
    } catch {
        // Missing or unreadable on disk -> treat as dirty so a shadow file is created
    }
    return true;
}

/**
 * Returns the live open TextDocument or reads and caches unopened files in a bounded LRU cache.
 */
export async function getCachedTextDocument(
    uri: string,
    documents: TextDocuments<TextDocument>,
    perRequestCache?: Map<string, TextDocument | null>
): Promise<TextDocument | null> {
    const openDoc = documents.get(uri);
    if (openDoc) {
        return openDoc;
    }
    if (perRequestCache && perRequestCache.has(uri)) {
        return perRequestCache.get(uri) ?? null;
    }

    const cached = unopenedDocCache.get(uri);
    if (cached) {
        unopenedDocCache.delete(uri);
        unopenedDocCache.set(uri, cached);
        perRequestCache?.set(uri, cached);
        return cached;
    }

    try {
        const content = await fs.readFile(uriToFsPath(uri), 'utf-8');
        const doc = TextDocument.create(uri, 'ca65', 0, content);
        if (unopenedDocCache.size >= MAX_UNOPENED_DOC_CACHE) {
            const oldestKey = unopenedDocCache.keys().next().value;
            if (oldestKey !== undefined) {
                unopenedDocCache.delete(oldestKey);
            }
        }
        unopenedDocCache.set(uri, doc);
        perRequestCache?.set(uri, doc);
        return doc;
    } catch {
        perRequestCache?.set(uri, null);
        return null;
    }
}
