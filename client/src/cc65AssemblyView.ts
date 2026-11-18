/**
 * "Show Generated Assembly": cc65's assembly output for the current C file in a read-only editor
 * beside it, with line linking in both directions (from cc65's `.dbg line` information) and live
 * refresh while editing.
 */
import * as path from 'path';
import {
    commands,
    Disposable,
    EventEmitter,
    ExtensionContext,
    Range,
    StatusBarAlignment,
    TextDocument,
    TextEditor,
    TextEditorDecorationType,
    TextEditorRevealType,
    ThemeColor,
    Uri,
    ViewColumn,
    window,
    workspace,
} from 'vscode';
import { buildCc65AssemblyView, Cc65AssemblyView, linkDataDefinitions, linkIncludes } from './cc65Toolchain';
import { Cc65Diagnostics } from './cc65Diagnostics';


export const CC65_ASM_SCHEME = 'cc65-asm';

/** One `ca65 -l` entry for a line of cc65's output (see the server's `ca65/parseListing`). */
export interface GeneratedListingEntry {
    line: number;
    address: string;
    bytes: string;
    byteCount: number;
}

export type ListingParser = (content: string) => Promise<GeneratedListingEntry[]>;

function formatCompactBytes(bytesText: string, byteCount: number, maxInlineBytes: number): string {
    const parts = bytesText.split(/\s+/);
    if (parts.length <= maxInlineBytes) return parts.join(' ');
    return `${parts.slice(0, maxInlineBytes).join(' ')}… (${byteCount}B)`;
}

/** Prefixes each line with the address/bytes columns of the asm hex listing (`addr  bytes | code`). */
function formatWithListing(view: Cc65AssemblyView, entries: GeneratedListingEntry[]): string {
    const byLine = new Map(entries.map(e => [e.line, e]));
    const lines = view.text.split('\n');
    if (lines[lines.length - 1] === '') lines.pop();
    return lines.map((line, i) => {
        const entry = byLine.get(view.sourceLineIndex[i]);
        const addrCol = (entry ? entry.address : '').padEnd(10, ' ');
        const bytesText = entry?.bytes ? formatCompactBytes(entry.bytes, entry.byteCount, 6) : '';
        const bytesCol = bytesText.length < 20 ? bytesText.padEnd(20, ' ') : `${bytesText} `;
        return `${addrCol}${bytesCol}| ${line}`;
    }).join('\n') + '\n';
}
const REFRESH_DELAY_MS = 700;

function viewUriFor(cUri: Uri): Uri {
    return Uri.from({
        scheme: CC65_ASM_SCHEME,
        // "<name> (assembly)" selects the ca65-listing language (see package.json filenamePatterns).
        path: `/${path.basename(cUri.fsPath)} (assembly)`,
        query: encodeURIComponent(cUri.toString()),
    });
}

function cUriFor(viewUri: Uri): Uri | undefined {
    if (viewUri.scheme !== CC65_ASM_SCHEME || !viewUri.query) return undefined;
    try {
        return Uri.parse(decodeURIComponent(viewUri.query));
    } catch {
        return undefined;
    }
}

function isCSource(doc: TextDocument): boolean {
    return doc.uri.scheme === 'file' && /\.c$/i.test(doc.uri.fsPath);
}

export function setupCc65AssemblyView(
    context: ExtensionContext,
    diagnostics: Cc65Diagnostics,
    parseListing?: ListingParser
): void {

    const changeEmitter = new EventEmitter<Uri>();
    const views = new Map<string, Cc65AssemblyView | undefined>();
    const refreshTimers = new Map<string, NodeJS.Timeout>();
    const highlight: TextEditorDecorationType = window.createTextEditorDecorationType({
        isWholeLine: true,
        backgroundColor: new ThemeColor('editor.rangeHighlightBackground'),
    });

    const findEditor = (uri: Uri): TextEditor | undefined =>
        window.visibleTextEditors.find(e => e.document.uri.toString() === uri.toString());

    const clearHighlights = (viewUri: Uri) => {
        const cUri = cUriFor(viewUri);
        findEditor(viewUri)?.setDecorations(highlight, []);
        if (cUri) findEditor(cUri)?.setDecorations(highlight, []);
    };

    /** Highlights (and reveals) the assembly generated for a C line. */
    const showAsmForCLine = (viewUri: Uri, cLine: number, highlightC: boolean) => {
        const view = views.get(viewUri.toString());
        const viewEditor = findEditor(viewUri);
        const cUri = cUriFor(viewUri);
        const cEditor = cUri ? findEditor(cUri) : undefined;
        if (!view || !viewEditor) return;
        const maxLine = viewEditor.document.lineCount - 1;
        const ranges = (view.cToAsm.get(cLine) ?? [])
            .filter(([start]) => start <= maxLine)
            .map(([start, end]) => new Range(start, 0, Math.min(end, maxLine), 0));
        viewEditor.setDecorations(highlight, ranges);
        if (ranges.length > 0) {
            viewEditor.revealRange(ranges[0], TextEditorRevealType.InCenterIfOutsideViewport);
        }
        cEditor?.setDecorations(highlight, highlightC && ranges.length > 0 ? [new Range(cLine, 0, cLine, 0)] : []);
    };

    const syncFromCEditor = (cEditor: TextEditor) => {
        const viewUri = viewUriFor(cEditor.document.uri);
        if (!findEditor(viewUri)) return;
        showAsmForCLine(viewUri, cEditor.selection.active.line, false);
    };

    const scheduleRefresh = (cUri: Uri, delay: number) => {
        const viewUri = viewUriFor(cUri);
        const key = viewUri.toString();
        if (!workspace.textDocuments.some(d => d.uri.toString() === key)) return;
        const existing = refreshTimers.get(key);
        if (existing) clearTimeout(existing);
        refreshTimers.set(key, setTimeout(() => {
            refreshTimers.delete(key);
            changeEmitter.fire(viewUri);
        }, delay));
    };

    // "Show Assembly" in the status bar for C files (where asm files show their byte count).
    const statusItem = window.createStatusBarItem(StatusBarAlignment.Right, 99);
    statusItem.text = '$(file-code) Show Assembly';
    statusItem.tooltip = 'Show the assembly cc65 generates for this file, beside it';
    statusItem.command = 'ca65.showCAssembly';
    const updateStatusItem = () => {
        const doc = window.activeTextEditor?.document;
        if (doc && isCSource(doc) && diagnostics.active) statusItem.show();
        else statusItem.hide();
    };
    updateStatusItem();

    context.subscriptions.push(
        statusItem,
        window.onDidChangeActiveTextEditor(updateStatusItem),
        diagnostics.onDidChangeActive(updateStatusItem),
        changeEmitter,
        highlight,
        { dispose: () => refreshTimers.forEach(t => clearTimeout(t)) },
        workspace.registerTextDocumentContentProvider(CC65_ASM_SCHEME, {
            onDidChange: changeEmitter.event,
            async provideTextDocumentContent(viewUri: Uri): Promise<string> {
                const cUri = cUriFor(viewUri);
                if (!cUri) return '; Invalid generated assembly URI.\n';
                const cDoc = await workspace.openTextDocument(cUri);
                const result = await diagnostics.generateAssembly(cDoc);
                if (!result.ok) {
                    views.set(viewUri.toString(), undefined);
                    const lines = ['; cc65 could not compile this file. Fix the errors to update the view.', ';'];
                    for (const message of result.messages.split(/\r?\n/)) {
                        if (message.trim()) lines.push(`; ${message.replace(/^.*?([^/\\]+\(\d+\):)/, '$1')}`);
                    }
                    return lines.join('\n') + '\n';
                }
                const view = buildCc65AssemblyView(result.asm, path.basename(cUri.fsPath));
                linkDataDefinitions(view, cDoc.getText());
                linkIncludes(view, cDoc.getText(), result.headers);
                views.set(viewUri.toString(), view);
                if (result.listing && parseListing) {
                    try {
                        return formatWithListing(view, await parseListing(result.listing));
                    } catch {
                        // fall back to the plain assembly
                    }
                }
                return view.text;
            },
        }),
        // Re-apply highlights after the view content changed.
        workspace.onDidChangeTextDocument((event) => {
            const doc = event.document;
            if (doc.uri.scheme === CC65_ASM_SCHEME) {
                const cUri = cUriFor(doc.uri);
                const cEditor = cUri ? findEditor(cUri) : undefined;
                if (cEditor) syncFromCEditor(cEditor);
                else clearHighlights(doc.uri);
            } else if (isCSource(doc) && event.contentChanges.length > 0) {
                scheduleRefresh(doc.uri, REFRESH_DELAY_MS);
            }
        }),
        workspace.onDidSaveTextDocument((doc) => {
            if (isCSource(doc)) scheduleRefresh(doc.uri, 0);
        }),
        workspace.onDidCloseTextDocument((doc) => {
            if (doc.uri.scheme === CC65_ASM_SCHEME) views.delete(doc.uri.toString());
        }),
        window.onDidChangeTextEditorSelection((event) => {
            const doc = event.textEditor.document;
            if (isCSource(doc)) {
                syncFromCEditor(event.textEditor);
            } else if (doc.uri.scheme === CC65_ASM_SCHEME) {
                // Clicking in the assembly highlights the C line it was generated from.
                const view = views.get(doc.uri.toString());
                const cLine = view?.asmToC[event.selections[0].active.line];
                const cUri = cUriFor(doc.uri);
                const cEditor = cUri ? findEditor(cUri) : undefined;
                if (cLine === undefined || !cEditor) {
                    clearHighlights(doc.uri);
                    return;
                }
                showAsmForCLine(doc.uri, cLine, true);
                cEditor.revealRange(new Range(cLine, 0, cLine, 0), TextEditorRevealType.InCenterIfOutsideViewport);
            }
        }),
        commands.registerCommand('ca65.showCAssembly', async () => {
            const active = window.activeTextEditor;
            if (active?.document.uri.scheme === CC65_ASM_SCHEME) {
                changeEmitter.fire(active.document.uri);
                return;
            }
            if (!active || !isCSource(active.document)) {
                void window.showInformationMessage('Open a C source file to view the assembly cc65 generates for it.');
                return;
            }
            if (!diagnostics.active) {
                void window.showInformationMessage('ca65: cc65 C mode is not running. Enable "ca65.enableCSupport" (and make sure clangd and cc65 are installed).');
                return;
            }
            const cEditor = active;
            const viewUri = viewUriFor(cEditor.document.uri);
            const viewDoc = await workspace.openTextDocument(viewUri);
            await window.showTextDocument(viewDoc, {
                viewColumn: ViewColumn.Beside,
                preserveFocus: true,
                preview: true,
            });
            syncFromCEditor(cEditor);
        }),
    );
}
