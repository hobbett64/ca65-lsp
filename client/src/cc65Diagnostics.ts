/**
 * Diagnostics for C sources from the real cc65 toolchain (used instead of clangd's diagnostics).
 *
 * Each open C file is compiled from its current (possibly unsaved) text with `cc65 -g`. When that
 * succeeds, cc65's output is assembled with ca65, which validates inline asm operands; ca65 errors
 * point back at the C line through cc65's debug info. Errors in included headers are shown on the
 * headers, and open C files are re-checked when a header they include changes.
 */
import * as crypto from 'crypto';
import * as fs from 'fs/promises';
import * as path from 'path';
import { execFile } from 'child_process';
import {
    Diagnostic,
    DiagnosticSeverity,
    Disposable,
    EventEmitter,
    languages,
    Range,
    TextDocument,
    Uri,
    workspace,
    commands,
} from 'vscode';
import {
    buildCc65CompileArgs,
    Cc65ToolDiagnostic,
    parseCc65ToolOutput,
    parseMakeDependencies,
} from './cc65Toolchain';
import { findInlineAsmRegions, mayContainInlineAsm } from './inlineAsm';

export interface Cc65DiagnosticsConfig {
    cc65Path: string;
    /** ca65 used to validate cc65's output (inline asm operands); skipped when undefined. */
    ca65Path?: string;
    target?: string;
    /** Explicit CPU (`ca65.cpu` other than auto), passed as `--cpu` to cc65 and ca65. */
    cpu?: string;
    includeDirs: string[];
    extraFlags: string[];
    /** Raw cc65 options from `ca65.cc65.additionalArgs` (e.g. `-Oirs`). */
    additionalArgs: string[];
    /** Scratch directory for temporary sources and outputs. */
    workDir: string;
}

const CHANGE_DELAY_MS = 500;
const TOOL_TIMEOUT_MS = 15000;

interface ToolResult {
    code: number;
    output: string;
}

function runTool(command: string, args: string[], cwd: string): Promise<ToolResult> {
    return new Promise((resolve) => {
        execFile(command, args, { cwd, timeout: TOOL_TIMEOUT_MS }, (error, stdout, stderr) => {
            const code = error ? (typeof (error as any).code === 'number' ? (error as any).code : 1) : 0;
            resolve({ code, output: `${stdout ?? ''}\n${stderr ?? ''}` });
        });
    });
}

function isCSource(doc: TextDocument): boolean {
    return doc.uri.scheme === 'file' && /\.c$/i.test(doc.uri.fsPath);
}

function samePath(a: string, b: string): boolean {
    return process.platform === 'win32' ? a.toLowerCase() === b.toLowerCase() : a === b;
}

export class Cc65Diagnostics implements Disposable {
    private readonly collection = languages.createDiagnosticCollection('cc65');
    private readonly activeEmitter = new EventEmitter<boolean>();
    /** Fires when cc65 becomes available or unavailable (see {@link active}). */
    readonly onDidChangeActive = this.activeEmitter.event;
    private readonly disposables: Disposable[] = [];
    private config: Cc65DiagnosticsConfig | undefined;
    private configKey = 'null';
    /** Per checked C file: diagnostics it produced, grouped by target file URI. */
    private readonly bySource = new Map<string, Map<string, Diagnostic[]>>();
    /** Per checked C file: headers it includes (absolute paths). */
    private readonly depsBySource = new Map<string, string[]>();
    private readonly timers = new Map<string, NodeJS.Timeout>();
    private readonly sequence = new Map<string, number>();

    constructor(private readonly log: (message: string) => void = () => undefined) {
        this.disposables.push(
            this.collection,
            this.activeEmitter,
            workspace.onDidOpenTextDocument((doc) => {
                if (isCSource(doc)) this.schedule(doc, 0);
            }),
            workspace.onDidChangeTextDocument((event) => {
                if (event.contentChanges.length === 0) return;
                if (isCSource(event.document)) this.schedule(event.document, CHANGE_DELAY_MS);
                else this.scheduleDependents(event.document.uri.fsPath, CHANGE_DELAY_MS);
            }),
            workspace.onDidSaveTextDocument((doc) => {
                if (isCSource(doc)) this.schedule(doc, 0);
                else this.scheduleDependents(doc.uri.fsPath, 0);
            }),
            workspace.onDidCloseTextDocument((doc) => {
                if (isCSource(doc)) this.forget(doc.uri.fsPath);
            }),
        );
    }

    /**
     * Compiles a C document's current text to assembly (`cc65 -g --add-source`) for the generated
     * assembly view. Returns the assembly, or cc65's messages when compilation fails.
     */
    async generateAssembly(doc: TextDocument): Promise<{
        ok: boolean;
        asm: string;
        messages: string;
        listing?: string;
        /** Every header the file includes (directly or not), with its text. */
        headers?: Array<{ path: string; text: string }>;
    }> {
        const config = this.config;
        if (!config) return { ok: false, asm: '', messages: 'cc65 is not available (see ca65.cc65.executablePath).' };
        const source = doc.uri.fsPath;
        const sourceDir = path.dirname(source);
        const hash = crypto.createHash('sha1').update(`view:${source}`).digest('hex').slice(0, 16);
        const tempDir = path.join(config.workDir, hash);
        const tempSource = path.join(tempDir, path.basename(source));
        const asmOut = path.join(tempDir, 'view.s');
        const lstOut = path.join(tempDir, 'view.lst');
        const objOut = path.join(tempDir, 'view.o');
        const depOut = path.join(tempDir, 'view.d');
        try {
            await fs.mkdir(tempDir, { recursive: true });
            await Promise.all([asmOut, lstOut, objOut, depOut].map(f => fs.rm(f, { force: true })));
            await fs.writeFile(tempSource, doc.getText(), 'utf8');
            const args = ['-g', '--add-source', '--create-full-dep', path.basename(depOut), ...buildCc65CompileArgs({
                target: config.target,
                cpu: config.cpu,
                includeDirs: [sourceDir, ...config.includeDirs],
                extraFlags: config.extraFlags,
                additionalArgs: config.additionalArgs,
                outFile: path.basename(asmOut),
                file: path.basename(tempSource),
            })];
            const result = await runTool(config.cc65Path, args, tempDir);
            if (result.code !== 0) return { ok: false, asm: '', messages: result.output.trim() };
            const asm = await fs.readFile(asmOut, 'utf8');

            // Assemble with a listing for the address/bytes columns (best effort: inline asm errors
            // leave the view without them).
            let listing: string | undefined;
            if (config.ca65Path) {
                const ca65Args = config.target ? ['-t', config.target] : [];
                if (config.cpu) ca65Args.push('--cpu', config.cpu);
                ca65Args.push('-l', path.basename(lstOut), '-o', path.basename(objOut), path.basename(asmOut));
                const assembled = await runTool(config.ca65Path, ca65Args, tempDir);
                if (assembled.code === 0) {
                    listing = await fs.readFile(lstOut, 'utf8').catch(() => undefined);
                }
            }
            // Included headers (system ones too), for linking `#include` lines to what they produce.
            const headers: Array<{ path: string; text: string }> = [];
            try {
                const deps = parseMakeDependencies(await fs.readFile(depOut, 'utf8'), tempDir)
                    .filter(d => !samePath(d, tempSource));
                for (const dep of deps.slice(0, 200)) {
                    const text = await fs.readFile(dep, 'utf8').catch(() => undefined);
                    if (text !== undefined) headers.push({ path: dep, text });
                }
            } catch {
                // no dependency information
            }
            return { ok: true, asm, messages: result.output.trim(), listing, headers };
        } finally {
            await Promise.all([asmOut, lstOut, objOut, depOut].map(f => fs.rm(f, { force: true }).catch(() => undefined)));
        }
    }

    /** True while cc65 diagnostics replace clangd's. */
    get active(): boolean {
        return this.config !== undefined;
    }

    configure(config: Cc65DiagnosticsConfig | undefined): void {
        const key = JSON.stringify(config ?? null);
        if (key === this.configKey) return;
        this.config = config;
        this.configKey = key;
        void commands.executeCommand('setContext', 'ca65.cc65Available', config !== undefined);
        this.activeEmitter.fire(config !== undefined);
        if (!config) {
            for (const timer of this.timers.values()) clearTimeout(timer);
            this.timers.clear();
            this.bySource.clear();
            this.depsBySource.clear();
            this.collection.clear();
            return;
        }
        for (const doc of workspace.textDocuments) {
            if (isCSource(doc)) this.schedule(doc, 0);
        }
    }

    dispose(): void {
        for (const timer of this.timers.values()) clearTimeout(timer);
        for (const d of this.disposables) d.dispose();
    }

    private schedule(doc: TextDocument, delay: number): void {
        if (!this.config) return;
        const key = doc.uri.fsPath;
        const existing = this.timers.get(key);
        if (existing) clearTimeout(existing);
        this.timers.set(key, setTimeout(() => {
            this.timers.delete(key);
            void this.check(doc).catch((err) => this.log(`cc65 diagnostics failed for ${key}: ${err}`));
        }, delay));
    }

    /**
     * Re-checks open C files that include `headerPath`. A header no checked file is known to include
     * (e.g. dependencies were unknown because compilation failed) re-checks every open C file.
     */
    private scheduleDependents(headerPath: string, delay: number): void {
        if (!/\.(h|inc)$/i.test(headerPath)) return;
        const dependents = Array.from(this.depsBySource)
            .filter(([, deps]) => deps.some(d => samePath(d, headerPath)))
            .map(([source]) => source);
        for (const doc of workspace.textDocuments) {
            if (!isCSource(doc)) continue;
            if (dependents.length === 0 || dependents.some(source => samePath(source, doc.uri.fsPath))) {
                this.schedule(doc, delay);
            }
        }
    }

    private forget(source: string): void {
        const previous = this.bySource.get(source);
        this.bySource.delete(source);
        this.depsBySource.delete(source);
        this.publish(new Set([Uri.file(source).toString(), ...(previous?.keys() ?? [])]));
    }

    private async check(doc: TextDocument): Promise<void> {
        const config = this.config;
        const configKey = this.configKey;
        if (!config || doc.isClosed) return;
        const source = doc.uri.fsPath;
        const seq = (this.sequence.get(source) ?? 0) + 1;
        this.sequence.set(source, seq);

        const sourceDir = path.dirname(source);
        const hash = crypto.createHash('sha1').update(source).digest('hex').slice(0, 16);
        const tempDir = path.join(config.workDir, hash);
        const tempSource = path.join(tempDir, path.basename(source));
        const asmOut = path.join(tempDir, 'out.s');
        const objOut = path.join(tempDir, 'out.o');
        const depOut = path.join(tempDir, 'out.d');
        const text = doc.getText();

        let toolDiagnostics: Cc65ToolDiagnostic[] = [];
        let deps: string[] | undefined;
        try {
            await fs.mkdir(tempDir, { recursive: true });
            await Promise.all([asmOut, objOut, depOut].map(f => fs.rm(f, { force: true })));
            await fs.writeFile(tempSource, text, 'utf8');

            // Run inside the temp directory with short relative names: `cc65 -g` writes the source path
            // into a fixed-size buffer and aborts on long paths. The source's own directory comes first in
            // the include path so its quoted includes resolve as in the real build.
            const cc65Args = ['-g', '--create-dep', path.basename(depOut), ...buildCc65CompileArgs({
                target: config.target,
                cpu: config.cpu,
                includeDirs: [sourceDir, ...config.includeDirs],
                extraFlags: config.extraFlags,
                additionalArgs: config.additionalArgs,
                outFile: path.basename(asmOut),
                file: path.basename(tempSource),
            })];
            const cc65 = await runTool(config.cc65Path, cc65Args, tempDir);
            toolDiagnostics = parseCc65ToolOutput(cc65.output, tempDir);
            if (cc65.code !== 0 && toolDiagnostics.length === 0) {
                this.log(`cc65 failed without diagnostics for ${source}:${cc65.output.trimEnd()}`);
            }
            try {
                deps = parseMakeDependencies(await fs.readFile(depOut, 'utf8'), tempDir);
            } catch {
                deps = undefined; // not written when compilation fails
            }

            if (cc65.code === 0 && config.ca65Path) {
                const ca65Args = config.target ? ['-t', config.target] : [];
                if (config.cpu) ca65Args.push('--cpu', config.cpu);
                ca65Args.push('-o', path.basename(objOut), path.basename(asmOut));
                const ca65 = await runTool(config.ca65Path, ca65Args, tempDir);
                toolDiagnostics.push(...parseCc65ToolOutput(ca65.output, tempDir));
            }
        } finally {
            await Promise.all([asmOut, objOut, depOut].map(f => fs.rm(f, { force: true }).catch(() => undefined)));
        }

        if (this.sequence.get(source) !== seq || this.configKey !== configKey || doc.isClosed) return;
        this.log(`cc65 diagnostics for ${path.basename(source)}: ${toolDiagnostics.length} message(s)`);

        const grouped = new Map<string, Diagnostic[]>();
        for (const d of toolDiagnostics) {
            let file = d.file && samePath(d.file, tempSource) ? source : d.file;
            if (!file || samePath(file, asmOut)) file = source; // tool-level or unmapped ca65 message
            const range = await this.rangeFor(file, d.line, file === source ? text : undefined);
            const diagnostic = new Diagnostic(
                range,
                d.message,
                d.severity === 'error' ? DiagnosticSeverity.Error
                    : d.severity === 'warning' ? DiagnosticSeverity.Warning
                        : DiagnosticSeverity.Information
            );
            diagnostic.source = 'cc65';
            const uri = Uri.file(file).toString();
            const list = grouped.get(uri) ?? [];
            list.push(diagnostic);
            grouped.set(uri, list);
        }
        // cc65 only writes the dependency file on success; also count headers that produced messages.
        const knownDeps = new Set((deps ?? this.depsBySource.get(source) ?? []).filter(d => !samePath(d, tempSource)));
        for (const d of toolDiagnostics) {
            if (d.file && !samePath(d.file, tempSource) && !samePath(d.file, asmOut)) knownDeps.add(d.file);
        }
        this.depsBySource.set(source, Array.from(knownDeps));

        const previous = this.bySource.get(source);
        this.bySource.set(source, grouped);
        this.publish(new Set([doc.uri.toString(), ...grouped.keys(), ...(previous?.keys() ?? [])]));
    }

    /**
     * Range for a 1-based line: the inline asm string on that line if there is one (inline asm
     * errors), otherwise the line's text without leading whitespace.
     */
    private async rangeFor(file: string, line: number | undefined, knownText?: string): Promise<Range> {
        const lineIndex = Math.max(0, (line ?? 1) - 1);
        let text = knownText;
        if (text === undefined) {
            const open = workspace.textDocuments.find(d => samePath(d.uri.fsPath, file));
            text = open?.getText();
        }
        if (text === undefined) {
            try {
                text = await fs.readFile(file, 'utf8');
            } catch {
                return new Range(lineIndex, 0, lineIndex, 0);
            }
        }
        const lines = text.split('\n');
        const lineText = (lines[lineIndex] ?? '').replace(/\r$/, '');

        if (mayContainInlineAsm(lineText)) {
            let lineStart = 0;
            for (let i = 0; i < lineIndex; i++) lineStart += lines[i].length + 1;
            const lineEnd = lineStart + lineText.length;
            const onLine = findInlineAsmRegions(text).filter(r => r.start >= lineStart && r.end <= lineEnd);
            if (onLine.length > 0) {
                return new Range(lineIndex, onLine[0].start - lineStart, lineIndex, onLine[onLine.length - 1].end - lineStart);
            }
        }
        const firstNonSpace = lineText.search(/\S/);
        return new Range(lineIndex, firstNonSpace < 0 ? 0 : firstNonSpace, lineIndex, lineText.length);
    }

    private publish(uris: Set<string>): void {
        for (const uri of uris) {
            const combined: Diagnostic[] = [];
            for (const grouped of this.bySource.values()) {
                combined.push(...(grouped.get(uri) ?? []));
            }
            this.collection.set(Uri.parse(uri), combined);
        }
    }
}
