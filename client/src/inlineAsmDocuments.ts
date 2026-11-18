/**
 * Embedded ca65 documents for cc65 inline assembly in C sources.
 *
 * Each C file with `__asm__("...")` gets a virtual `ca65-inline:` document (same lines/columns, only
 * the inline asm kept; see inlineAsm.ts). The ca65 language server indexes it like any asm file, so
 * requests inside inline asm are forwarded to it, and any results pointing into a virtual document
 * are mapped back onto the C file.
 */
import * as fs from 'fs/promises';
import {
    CompletionItem,
    CompletionList,
    Disposable,
    DocumentHighlight,
    EventEmitter,
    Hover,
    languages,
    Location,
    LocationLink,
    Position,
    Range,
    SnippetString,
    TextDocument,
    TextDocumentContentProvider,
    Uri,
    workspace,
    WorkspaceEdit,
    commands,
    Definition,
} from 'vscode';
import {
    buildEmbeddedAsmText,
    embeddedPathForHostPath,
    EMBEDDED_ASM_SCHEME,
    findInlineAsmRegions,
    findRegionAt,
    hostPathForEmbeddedPath,
    InlineAsmRegion,
    mayContainInlineAsm,
} from './inlineAsm';

const CHANGE_DEBOUNCE_MS = 100;
const SYNC_TIMEOUT_MS = 1500;

export function embeddedUriForHost(host: Uri): Uri {
    return Uri.from({ scheme: EMBEDDED_ASM_SCHEME, path: embeddedPathForHostPath(host.path) });
}

export function hostUriForEmbedded(uri: Uri): Uri | undefined {
    if (uri.scheme !== EMBEDDED_ASM_SCHEME) return undefined;
    const hostPath = hostPathForEmbeddedPath(uri.path);
    return hostPath ? Uri.from({ scheme: 'file', path: hostPath }) : undefined;
}

/** Maps a URI of an embedded document back to its C host (other URIs unchanged). */
export function mapEmbeddedUri(uri: Uri): Uri {
    return hostUriForEmbedded(uri) ?? uri;
}

export function mapEmbeddedLocations(locations: Location[] | null | undefined): Location[] | null | undefined {
    return locations?.map(l => l.uri.scheme === EMBEDDED_ASM_SCHEME ? new Location(mapEmbeddedUri(l.uri), l.range) : l);
}

export function mapEmbeddedDefinition<T extends Definition | LocationLink[] | null | undefined>(def: T): T {
    if (!def) return def;
    if (def instanceof Location) {
        return (def.uri.scheme === EMBEDDED_ASM_SCHEME ? new Location(mapEmbeddedUri(def.uri), def.range) : def) as T;
    }
    return (def as Array<Location | LocationLink>).map(item => {
        if (item instanceof Location) {
            return item.uri.scheme === EMBEDDED_ASM_SCHEME ? new Location(mapEmbeddedUri(item.uri), item.range) : item;
        }
        return item.targetUri.scheme === EMBEDDED_ASM_SCHEME ? { ...item, targetUri: mapEmbeddedUri(item.targetUri) } : item;
    }) as T;
}

/** Rewrites edits on embedded documents onto their C hosts (positions map 1:1). */
export function mapEmbeddedWorkspaceEdit(edit: WorkspaceEdit | null | undefined): WorkspaceEdit | null | undefined {
    if (!edit) return edit;
    const entries = edit.entries();
    if (!entries.some(([uri]) => uri.scheme === EMBEDDED_ASM_SCHEME)) return edit;
    const mapped = new WorkspaceEdit();
    const seen = new Set<string>();
    for (const [uri, edits] of entries) {
        const target = mapEmbeddedUri(uri);
        for (const e of edits) {
            const key = `${target.toString()}#${e.range.start.line}:${e.range.start.character}-${e.range.end.line}:${e.range.end.character}`;
            if (seen.has(key)) continue;
            seen.add(key);
            mapped.replace(target, e.range, e.newText);
        }
    }
    return mapped;
}

export class InlineAsmDocuments implements Disposable, TextDocumentContentProvider {
    private readonly changeEmitter = new EventEmitter<Uri>();
    readonly onDidChange = this.changeEmitter.event;
    private readonly disposables: Disposable[] = [];
    private readonly regionCache = new Map<string, { version: number; regions: InlineAsmRegion[] }>();
    private readonly pendingChanges = new Map<string, NodeJS.Timeout>();
    /** Per C file on disk: whether it contains inline asm (keyed by mtime). */
    private readonly diskScanCache = new Map<string, { mtimeMs: number; hasAsm: boolean }>();

    constructor() {
        this.disposables.push(
            this.changeEmitter,
            workspace.registerTextDocumentContentProvider(EMBEDDED_ASM_SCHEME, this),
            workspace.onDidChangeTextDocument((event) => {
                if (event.document.uri.scheme === 'file' && this.isEmbeddedOpen(event.document.uri)) {
                    this.scheduleChange(event.document.uri);
                }
            }),
            workspace.onDidCloseTextDocument((doc) => {
                this.regionCache.delete(doc.uri.toString());
            }),
        );
    }

    dispose(): void {
        for (const timer of this.pendingChanges.values()) clearTimeout(timer);
        this.pendingChanges.clear();
        for (const d of this.disposables) d.dispose();
    }

    async provideTextDocumentContent(uri: Uri): Promise<string> {
        const host = hostUriForEmbedded(uri);
        if (!host) return '';
        const open = workspace.textDocuments.find(d => d.uri.toString() === host.toString());
        if (open) return buildEmbeddedAsmText(open.getText());
        try {
            return buildEmbeddedAsmText(await fs.readFile(host.fsPath, 'utf8'));
        } catch {
            return '';
        }
    }

    private isEmbeddedOpen(host: Uri): boolean {
        const embedded = embeddedUriForHost(host).toString();
        return workspace.textDocuments.some(d => d.uri.toString() === embedded);
    }

    private scheduleChange(host: Uri): void {
        const key = host.toString();
        const existing = this.pendingChanges.get(key);
        if (existing) clearTimeout(existing);
        this.pendingChanges.set(key, setTimeout(() => {
            this.pendingChanges.delete(key);
            this.changeEmitter.fire(embeddedUriForHost(host));
        }, CHANGE_DEBOUNCE_MS));
    }

    /** Notifies that a C file changed on disk (e.g. while closed). */
    notifyHostChangedOnDisk(host: Uri): void {
        this.diskScanCache.delete(host.fsPath);
        if (this.isEmbeddedOpen(host)) this.scheduleChange(host);
    }

    private regionsFor(document: TextDocument): InlineAsmRegion[] {
        const key = document.uri.toString();
        const cached = this.regionCache.get(key);
        if (cached && cached.version === document.version) return cached.regions;
        const text = document.getText();
        const regions = mayContainInlineAsm(text) ? findInlineAsmRegions(text) : [];
        this.regionCache.set(key, { version: document.version, regions });
        return regions;
    }

    /** True when `position` in a C document is inside an inline asm string. */
    isInInlineAsm(document: TextDocument, position: Position): boolean {
        const regions = this.regionsFor(document);
        return regions.length > 0 && findRegionAt(regions, document.offsetAt(position)) !== undefined;
    }

    /** Opens the embedded document for a C file and waits until it reflects the C file's current text. */
    async getSyncedEmbedded(host: TextDocument): Promise<TextDocument> {
        const uri = embeddedUriForHost(host.uri);
        const expected = buildEmbeddedAsmText(host.getText());
        const embedded = await this.openEmbedded(uri);
        if (embedded.getText() === expected) return embedded;

        await new Promise<void>((resolve) => {
            const timer = setTimeout(() => {
                sub.dispose();
                resolve();
            }, SYNC_TIMEOUT_MS);
            const sub = workspace.onDidChangeTextDocument((event) => {
                if (event.document.uri.toString() === uri.toString() && event.document.getText() === expected) {
                    clearTimeout(timer);
                    sub.dispose();
                    resolve();
                }
            });
            const pending = this.pendingChanges.get(host.uri.toString());
            if (pending) {
                clearTimeout(pending);
                this.pendingChanges.delete(host.uri.toString());
            }
            this.changeEmitter.fire(uri);
        });
        return embedded;
    }

    private async openEmbedded(uri: Uri): Promise<TextDocument> {
        let doc = await workspace.openTextDocument(uri);
        if (doc.languageId !== 'ca65') {
            // e.g. when files.associations maps *.s to another language
            doc = await languages.setTextDocumentLanguage(doc, 'ca65');
        }
        return doc;
    }

    /**
     * Opens the embedded documents of every C file that contains inline asm, so the ca65 server knows
     * all inline uses (for references and rename started anywhere).
     */
    async openAll(cFiles: string[]): Promise<void> {
        await Promise.all(cFiles.map(async (file) => {
            try {
                const stat = await fs.stat(file);
                let entry = this.diskScanCache.get(file);
                if (!entry || entry.mtimeMs !== stat.mtimeMs) {
                    const open = workspace.textDocuments.find(d => d.uri.fsPath === file);
                    const text = open ? open.getText() : await fs.readFile(file, 'utf8');
                    entry = { mtimeMs: stat.mtimeMs, hasAsm: mayContainInlineAsm(text) && findInlineAsmRegions(text).length > 0 };
                    this.diskScanCache.set(file, entry);
                }
                if (entry.hasAsm) {
                    const host = workspace.textDocuments.find(d => d.uri.fsPath === file);
                    if (host) {
                        await this.getSyncedEmbedded(host);
                    } else {
                        await this.openEmbedded(embeddedUriForHost(Uri.file(file)));
                    }
                }
            } catch {
                // unreadable file: skip
            }
        }));
    }

    // ---------------------------------------------------------------------------------------------
    // Forwarding (C document position inside inline asm -> embedded ca65 document)
    // ---------------------------------------------------------------------------------------------

    async hover(host: TextDocument, position: Position): Promise<Hover | undefined> {
        const embedded = await this.getSyncedEmbedded(host);
        const hovers = await commands.executeCommand<Hover[]>('vscode.executeHoverProvider', embedded.uri, position);
        if (!hovers || hovers.length === 0) return undefined;
        return new Hover(hovers.flatMap(h => h.contents), hovers.find(h => h.range)?.range);
    }

    async definition(host: TextDocument, position: Position): Promise<LocationLink[] | undefined> {
        const embedded = await this.getSyncedEmbedded(host);
        const defs = await commands.executeCommand<Array<Location | LocationLink>>('vscode.executeDefinitionProvider', embedded.uri, position);
        return (defs ?? []).map((d): LocationLink => d instanceof Location
            ? { targetUri: mapEmbeddedUri(d.uri), targetRange: d.range, targetSelectionRange: d.range }
            : { ...d, targetUri: mapEmbeddedUri(d.targetUri) });
    }

    async references(host: TextDocument, position: Position): Promise<Location[] | undefined> {
        const embedded = await this.getSyncedEmbedded(host);
        const refs = await commands.executeCommand<Location[]>('vscode.executeReferenceProvider', embedded.uri, position);
        return mapEmbeddedLocations(refs) ?? undefined;
    }

    async documentHighlights(host: TextDocument, position: Position): Promise<DocumentHighlight[] | undefined> {
        const embedded = await this.getSyncedEmbedded(host);
        return commands.executeCommand<DocumentHighlight[]>('vscode.executeDocumentHighlights', embedded.uri, position);
    }

    async prepareRename(host: TextDocument, position: Position): Promise<{ range: Range; placeholder: string } | undefined> {
        const embedded = await this.getSyncedEmbedded(host);
        return commands.executeCommand<{ range: Range; placeholder: string }>('vscode.prepareRename', embedded.uri, position);
    }

    async rename(host: TextDocument, position: Position, newName: string): Promise<WorkspaceEdit | undefined> {
        const embedded = await this.getSyncedEmbedded(host);
        const edit = await commands.executeCommand<WorkspaceEdit>('vscode.executeDocumentRenameProvider', embedded.uri, position, newName);
        return mapEmbeddedWorkspaceEdit(edit) ?? undefined;
    }

    async completion(host: TextDocument, position: Position, triggerCharacter: string | undefined): Promise<CompletionList> {
        const embedded = await this.getSyncedEmbedded(host);
        const list = await commands.executeCommand<CompletionList>(
            'vscode.executeCompletionItemProvider', embedded.uri, position, triggerCharacter, 50
        );
        // cc65 rejects pseudo instructions (`.byte`, ...) as inline asm instructions, but pseudo
        // functions such as `.lobyte(...)` are fine in operands.
        const atInstruction = /^\s*[.\w@]*$/.test(embedded.lineAt(position.line).text.slice(0, position.character));
        const items = (list?.items ?? []).filter((item: CompletionItem) => {
            const text = item.insertText instanceof SnippetString ? item.insertText.value : (item.insertText ?? '');
            // A C string holds one line of asm: drop multi-line snippets (block templates).
            if (text.includes('\n')) return false;
            const label = typeof item.label === 'string' ? item.label : item.label.label;
            return !(atInstruction && label.startsWith('.'));
        }).map((item: CompletionItem) => {
            // Auto-import edits would insert `.import` lines into the C file; cc65 auto-imports anyway.
            item.additionalTextEdits = undefined;
            return item;
        });
        return new CompletionList(items, list?.isIncomplete ?? false);
    }
}
