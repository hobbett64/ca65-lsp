/**
 * cc65 C mode: runs clangd for the workspace's C sources and links C symbols to the global ca65
 * symbols that implement or use them (cc65 naming convention: C `foo` <-> asm `_foo`).
 *
 * Both language clients are owned by this extension, so cross-language results are merged in
 * client middleware:
 * - C -> asm: go to definition, find references and rename on a C symbol include the asm side.
 *   Hovering a C symbol implemented in asm shows the asm hovercard; hovering a file-scope C symbol
 *   shows clangd's hovercard plus the segment cc65 places it in. Everything else is plain clangd.
 * - asm -> C: the same requests on an asm `_foo` include the C side; hovering an asm symbol
 *   implemented in C shows clangd's hovercard plus its segment.
 */
import * as path from 'path';
import {
    CancellationToken,
    Disposable,
    ExtensionContext,
    Hover,
    Location,
    LocationLink,
    MarkdownString,
    OutputChannel,
    Position,
    Range,
    TextDocument,
    Uri,
    window,
    workspace,
    WorkspaceEdit,
    commands,
    Definition,
    CodeAction,
    CodeActionKind,
    languages,
    QuickPickItem,
    Selection,
    TextEditorRevealType,
    ViewColumn,
} from 'vscode';
import {
    LanguageClient,
    LanguageClientOptions,
    Middleware,
    ServerOptions,
    State,
} from 'vscode-languageclient/node';
import type * as lsp from 'vscode-languageclient/node';
import which = require('which');
import {
    buildCc65ClangFlags,
    buildCompileCommands,
    CC65_SHIM_HEADER,
    asmNameToCName,
    buildAsmStub,
    Cc65CallingConvention,
    CFunctionPrototype,
    detectCallingConvention,
    formatPrototypeMarkdown,
    replaceClangdDeclarationBlock,
    extractClangdDeclarationBlock,
    parseClangdFunctionHover,
    isExternalCUsr,
    sanitizeCc65AdditionalArgs,
    collectHeaderDirs,
    DEFAULT_CC65_TARGET,
    detectCc65VersionMacro,
    findCc65Compiler,
    findCc65Executable,
    resolveCc65IncludeDir,
    writeFileIfChanged,
} from './cc65Toolchain';
import { Cc65Diagnostics } from './cc65Diagnostics';
import {
    InlineAsmDocuments,
    mapEmbeddedDefinition,
    mapEmbeddedLocations,
    mapEmbeddedWorkspaceEdit,
} from './inlineAsmDocuments';

const C_IDENTIFIER_RE = /^[A-Za-z_][A-Za-z0-9_]*$/;
const C_WORD_RE = /[A-Za-z_][A-Za-z0-9_]*/;
const SOURCE_EXCLUDE_GLOB = '**/{node_modules,.git}/**';
const RESTART_DEBOUNCE_MS = 1500;

interface GlobalSymbolAtResult {
    name: string;
    hasAsmDefinition: boolean;
}

interface LookupGlobalResult {
    name: string;
    definitions: lsp.Location[];
    imported: boolean;
    hoverMarkdown?: string;
}

interface ClangdSymbolInfo {
    name?: string;
    usr?: string;
    declarationRange?: lsp.Location;
    definitionRange?: lsp.Location;
}

/**
 * Appends the C declaration (prototype) to an asm hovercard, below a horizontal rule, in the same
 * section as the card's last part (so exactly one divider shows before it).
 */
function withDeclaration(contents: MarkdownString[], declarationMarkdown: string): MarkdownString[] {
    if (contents.length === 0) return [new MarkdownString(declarationMarkdown)];
    const last = contents[contents.length - 1];
    const merged = new MarkdownString(`${last.value}\n\n---\n\n${declarationMarkdown}`);
    merged.isTrusted = last.isTrusted;
    merged.supportHtml = last.supportHtml;
    merged.supportThemeIcons = last.supportThemeIcons;
    merged.baseUri = last.baseUri;
    return [...contents.slice(0, -1), merged];
}

function locationKey(uri: Uri, range: Range): string {
    return `${uri.toString()}#${range.start.line}:${range.start.character}-${range.end.line}:${range.end.character}`;
}

function mergeLocations(primary: Location[] | null | undefined, extra: Location[]): Location[] {
    const result: Location[] = [];
    const seen = new Set<string>();
    for (const loc of [...(primary ?? []), ...extra]) {
        const key = locationKey(loc.uri, loc.range);
        if (seen.has(key)) continue;
        seen.add(key);
        result.push(loc);
    }
    return result;
}

function mergeWorkspaceEdits(target: WorkspaceEdit, extra: WorkspaceEdit | undefined | null): WorkspaceEdit {
    if (!extra) return target;
    const existing = new Set<string>();
    for (const [uri, edits] of target.entries()) {
        for (const e of edits) existing.add(locationKey(uri, e.range));
    }
    for (const [uri, edits] of extra.entries()) {
        for (const e of edits) {
            if (existing.has(locationKey(uri, e.range))) continue;
            existing.add(locationKey(uri, e.range));
            target.replace(uri, e.range, e.newText);
        }
    }
    return target;
}

function hoverContentsToMarkdown(hover: Hover | null | undefined): MarkdownString[] {
    if (!hover) return [];
    return hover.contents.map(c => {
        if (c instanceof MarkdownString) return c;
        if (typeof c === 'string') return new MarkdownString(c);
        return new MarkdownString().appendCodeblock(c.value, c.language);
    });
}

export class CBridge implements Disposable {
    private ca65Client: LanguageClient | undefined;
    private ca65Ready: Promise<void> | undefined;
    private clangd: LanguageClient | undefined;
    private clangdReady: Promise<void> | undefined;
    private output: OutputChannel | undefined;
    private disposables: Disposable[] = [];
    private restartTimer: NodeJS.Timeout | undefined;
    private lastSourceSignature = '';
    private starting: Promise<void> | undefined;
    /** C sources in the workspace (from the last restart). */
    private cSourceFiles: string[] = [];
    private warnedAboutMissingCc65 = false;
    /** cc65's default calling convention (`__cdecl__` with `--all-cdecl`). */
    private defaultConvention: Cc65CallingConvention = 'fastcall';

    /** Embedded ca65 documents for cc65 inline asm in C sources. */
    readonly inlineAsm: InlineAsmDocuments;

    /** cc65/ca65 diagnostics for C files (replace clangd's diagnostics). */
    readonly cc65Diagnostics: Cc65Diagnostics;

    constructor(private readonly context: ExtensionContext) {
        this.inlineAsm = new InlineAsmDocuments();
        this.cc65Diagnostics = new Cc65Diagnostics((message) => this.log(message));
    }

    /** Stops clangd and cc65 diagnostics (cc65 C mode off). */
    private async disableCMode(): Promise<void> {
        this.cc65Diagnostics.configure(undefined);
        await this.stopClangd();
    }

    /** Opens embedded documents for all C files with inline asm (before workspace-wide queries). */
    async openInlineAsmDocuments(): Promise<void> {
        if (!this.clangd) return;
        try {
            await this.inlineAsm.openAll(this.cSourceFiles);
        } catch (err) {
            this.log(`Failed to open inline asm documents: ${err}`);
        }
    }

    // ---------------------------------------------------------------------------------------------
    // Lifecycle
    // ---------------------------------------------------------------------------------------------

    attachCa65Client(client: LanguageClient, ready: Promise<void>): void {
        this.ca65Client = client;
        this.ca65Ready = ready;
    }

    activate(): void {
        this.disposables.push(
            commands.registerCommand('ca65.clangd.restart', () => this.restart(true)),
            commands.registerCommand('ca65.createAsmStub', (uri?: Uri, position?: Position) => this.createAsmStub(uri, position)),
            // Go to Declaration from asm: the C declaration (prototype/extern) of a symbol shared with C,
            // like Go to Declaration in C; Go to Definition stays on the implementation.
            languages.registerDeclarationProvider(
                [{ scheme: 'file', language: 'ca65' }],
                { provideDeclaration: (document, position, token) => this.provideAsmDeclaration(document, position, token) }
            ),
            languages.registerCodeActionsProvider(
                [{ scheme: 'file', language: 'c' }, { scheme: 'file', language: 'cpp', pattern: '**/*.h' }],
                { provideCodeActions: (document, range) => this.provideAsmStubActions(document, range) },
                { providedCodeActionKinds: [CodeActionKind.RefactorRewrite] }
            ),
            workspace.onDidChangeConfiguration((event) => {
                if (
                    event.affectsConfiguration('ca65.enableCSupport')
                    || event.affectsConfiguration('ca65.clangd')
                    || event.affectsConfiguration('ca65.cc65')
                    || event.affectsConfiguration('ca65.cpu')
                    || event.affectsConfiguration('ca65.executablePath')
                ) {
                    this.scheduleRestart(true);
                }
            }),
            workspace.onDidChangeWorkspaceFolders(() => this.scheduleRestart(false)),
        );

        const watcher = workspace.createFileSystemWatcher('**/*.{c,h}');
        this.disposables.push(
            watcher,
            watcher.onDidCreate(() => this.scheduleRestart(false)),
            watcher.onDidChange((uri) => this.inlineAsm.notifyHostChangedOnDisk(uri)),
            watcher.onDidDelete(() => this.scheduleRestart(false)),
        );

        void this.restart(false);
    }

    /** Stops clangd; used on extension deactivation. */
    async stop(): Promise<void> {
        await this.stopClangd();
    }

    dispose(): void {
        if (this.restartTimer) clearTimeout(this.restartTimer);
        for (const d of this.disposables) d.dispose();
        this.disposables = [];
        this.inlineAsm.dispose();
        this.cc65Diagnostics.dispose();
        void this.stopClangd();
        this.output?.dispose();
    }

    private log(message: string): void {
        this.getOutput().appendLine(message);
    }

    private getOutput(): OutputChannel {
        if (!this.output) {
            this.output = window.createOutputChannel('ca65 clangd');
        }
        return this.output;
    }

    /** `ca65.enableCSupport` (off by default). */
    private isEnabled(): boolean {
        return workspace.getConfiguration('ca65').get<boolean>('enableCSupport', false) === true;
    }

    /**
     * Debounced restart. When `force` is false the server is only restarted if the set of C sources
     * or header directories (which feed the compile database) changed.
     */
    private scheduleRestart(force: boolean): void {
        if (this.restartTimer) clearTimeout(this.restartTimer);
        this.restartTimer = setTimeout(() => {
            this.restartTimer = undefined;
            void this.restart(force);
        }, RESTART_DEBOUNCE_MS);
    }

    private async restart(force: boolean): Promise<void> {
        // Serialize restarts.
        while (this.starting) {
            await this.starting.catch(() => undefined);
        }
        this.starting = this.restartInner(force).finally(() => {
            this.starting = undefined;
        });
        return this.starting;
    }

    private async restartInner(force: boolean): Promise<void> {
        try {
            // Opt-in (work in progress): C support stays off unless the user enables it, so it never
            // competes with other C extensions by default.
            if (!this.isEnabled()) {
                await this.disableCMode();
                return;
            }

            const sources = await this.findSources();
            if (sources.cFiles.length === 0) {
                this.log('cc65 C mode idle: no .c files in the workspace.');
                await this.disableCMode();
                return;
            }

            const clangdPath = await this.resolveClangdPath();
            if (!clangdPath) {
                const msg = 'cc65 C mode: clangd was not found. Install clangd or set "ca65.clangd.path".';
                this.log(msg);
                void window.showErrorMessage(`ca65: ${msg}`);
                await this.disableCMode();
                return;
            }

            const signature = [clangdPath, ...sources.cFiles, '|', ...sources.headerDirs].join('\0');
            if (!force && this.clangd && signature === this.lastSourceSignature) {
                return;
            }
            this.lastSourceSignature = signature;

            const setup = await this.prepareCompileDatabase(sources);
            await this.stopClangd();
            this.cSourceFiles = sources.cFiles;
            await this.startClangd(clangdPath, setup.compileCommandsDir, setup.fallbackFlags, sources.cFiles[0]);
        } catch (err) {
            this.log(`cc65 C mode failed to start: ${err}`);
        }
    }

    private async resolveClangdPath(): Promise<string | undefined> {
        const configured = workspace.getConfiguration('ca65').get<string>('clangd.path', '').trim();
        const candidate = configured || 'clangd';
        return (await which(candidate, { nothrow: true })) ?? undefined;
    }

    private async findSources(): Promise<{ cFiles: string[]; headerDirs: string[] }> {
        const [cUris, hUris] = await Promise.all([
            workspace.findFiles('**/*.c', SOURCE_EXCLUDE_GLOB),
            workspace.findFiles('**/*.h', SOURCE_EXCLUDE_GLOB, 2000),
        ]);
        const cFiles = cUris.filter(u => u.scheme === 'file').map(u => u.fsPath).sort();
        const headerDirs = collectHeaderDirs(hUris.filter(u => u.scheme === 'file').map(u => u.fsPath));
        return { cFiles, headerDirs };
    }

    private async workspaceHasOwnCompileDatabase(): Promise<boolean> {
        for (const folder of workspace.workspaceFolders ?? []) {
            for (const rel of ['compile_commands.json', path.join('build', 'compile_commands.json')]) {
                try {
                    await workspace.fs.stat(Uri.joinPath(folder.uri, rel));
                    return true;
                } catch {
                    // not present
                }
            }
        }
        return false;
    }

    /**
     * Writes the cc65 shim header and (unless the workspace provides its own) a compile database
     * covering every C source, into the extension's storage so the workspace is not modified.
     */
    private async prepareCompileDatabase(sources: { cFiles: string[]; headerDirs: string[] }): Promise<{
        compileCommandsDir?: string;
        fallbackFlags: string[];
    }> {
        const cfg = workspace.getConfiguration('ca65');
        const storageRoot = (this.context.storageUri ?? this.context.globalStorageUri).fsPath;
        const dbDir = path.join(storageRoot, 'clangd');

        const shimPath = path.join(dbDir, 'cc65_shim.h');
        await writeFileIfChanged(shimPath, CC65_SHIM_HEADER);

        const ca65Path = cfg.get<string>('executablePath', '').trim() || undefined;
        const cc65Path = cfg.get<string>('cc65.executablePath', '').trim() || undefined;
        const target = cfg.get<string>('cc65.target', DEFAULT_CC65_TARGET).trim() || DEFAULT_CC65_TARGET;
        const compiler = await findCc65Compiler({ cc65Path, ca65Path });
        const executable = compiler ?? await findCc65Executable({ ca65Path });
        if (!compiler) {
            const msg = cc65Path
                ? `cc65 not found at "${cc65Path}" (ca65.cc65.executablePath).`
                : 'cc65 not found in PATH; set "ca65.cc65.executablePath" if it is installed elsewhere.';
            this.log(msg);
            if (cc65Path && !this.warnedAboutMissingCc65) {
                this.warnedAboutMissingCc65 = true;
                void window.showWarningMessage(`ca65: ${msg}`);
            }
        }
        const includeDir = await resolveCc65IncludeDir({
            explicit: cfg.get<string>('clangd.cc65IncludeDir', '').trim() || undefined,
            executable,
        });
        if (!includeDir) {
            this.log('Warning: cc65 include directory not found; set "ca65.clangd.cc65IncludeDir". System headers will not resolve.');
        }
        const versionMacro = await detectCc65VersionMacro(executable);
        const extraFlags = (cfg.get<unknown[]>('clangd.compileFlags', []) ?? []).filter((f): f is string => typeof f === 'string');
        const cc65AdditionalArgs = sanitizeCc65AdditionalArgs(cfg.get<unknown[]>('cc65.additionalArgs', []) ?? []);
        const cpuSetting = cfg.get<string>('cpu', 'auto').trim();
        const explicitCpu = cpuSetting && cpuSetting.toLowerCase() !== 'auto' ? cpuSetting : undefined;
        this.defaultConvention = cc65AdditionalArgs.includes('--all-cdecl') ? 'cdecl' : 'fastcall';
        const folderDirs = (workspace.workspaceFolders ?? []).map(f => f.uri.fsPath);
        const userIncludeDirs = Array.from(new Set([...folderDirs, ...sources.headerDirs]));

        const flags = buildCc65ClangFlags({
            target,
            includeDir,
            shimHeaderPath: shimPath,
            versionMacro,
            userIncludeDirs,
            extraFlags,
        });
        this.log(`cc65: ${compiler ?? '(not found)'}; target: ${target}; include dir: ${includeDir ?? '(not found)'}; __CC65__=${versionMacro}`);

        // cc65 (and ca65, for inline asm operands) diagnostics replace clangd's for C files.
        const ca65Exe = (await which(ca65Path ?? 'ca65', { nothrow: true })) ?? undefined;
        this.cc65Diagnostics.configure(compiler ? {
            cc65Path: compiler,
            ca65Path: ca65Exe,
            target,
            cpu: explicitCpu,
            includeDirs: userIncludeDirs,
            extraFlags,
            additionalArgs: cc65AdditionalArgs,
            workDir: path.join(storageRoot, 'cc65-check'),
        } : undefined);
        if (!compiler) this.log('cc65 not found: showing clangd diagnostics for C files instead.');

        if (await this.workspaceHasOwnCompileDatabase()) {
            this.log('Using the workspace\'s own compile_commands.json.');
            return { fallbackFlags: flags };
        }

        const entries = buildCompileCommands(
            sources.cFiles.map(file => ({
                file,
                directory: workspace.getWorkspaceFolder(Uri.file(file))?.uri.fsPath ?? path.dirname(file),
            })),
            flags
        );
        await writeFileIfChanged(path.join(dbDir, 'compile_commands.json'), JSON.stringify(entries, null, 2));
        this.log(`Generated compile database for ${entries.length} C file(s) in ${dbDir}`);
        return { compileCommandsDir: dbDir, fallbackFlags: flags };
    }

    private async startClangd(
        clangdPath: string,
        compileCommandsDir: string | undefined,
        fallbackFlags: string[],
        warmupFile: string | undefined
    ): Promise<void> {
        const userArgs = (workspace.getConfiguration('ca65').get<unknown[]>('clangd.arguments', []) ?? [])
            .filter((a): a is string => typeof a === 'string');
        const args = ['--background-index', '--header-insertion=never'];
        if (compileCommandsDir) args.push(`--compile-commands-dir=${compileCommandsDir}`);
        args.push(...userArgs);

        const serverOptions: ServerOptions = { command: clangdPath, args };
        const clientOptions: LanguageClientOptions = {
            documentSelector: [
                { scheme: 'file', language: 'c' },
                { scheme: 'file', language: 'cpp', pattern: '**/*.h' },
            ],
            outputChannel: this.getOutput(),
            initializationOptions: { fallbackFlags },
            middleware: this.createClangdMiddleware(),
        };

        const client = new LanguageClient('ca65.clangd', 'clangd (cc65)', serverOptions, clientOptions);
        this.clangd = client;
        this.log(`Starting ${clangdPath} ${args.join(' ')}`);
        this.clangdReady = client.start();
        try {
            await this.clangdReady;
            // clangd only loads the compile database (and starts background indexing) when the first
            // C file is opened. Open one now so asm -> C lookups work without opening C files first.
            if (warmupFile) {
                workspace.openTextDocument(Uri.file(warmupFile)).then(undefined, (err) => {
                    this.log(`Failed to warm up clangd with ${warmupFile}: ${err}`);
                });
            }
            // Let the ca65 server index inline asm in all C files (for references/rename from asm).
            void this.openInlineAsmDocuments();
        } catch (err) {
            this.log(`clangd failed to start: ${err}`);
            if (this.clangd === client) {
                this.clangd = undefined;
                this.clangdReady = undefined;
            }
        }
    }

    private async stopClangd(): Promise<void> {
        const client = this.clangd;
        this.clangd = undefined;
        this.clangdReady = undefined;
        if (client && client.needsStop()) {
            try {
                await client.stop();
            } catch (err) {
                this.log(`Failed to stop clangd: ${err}`);
            }
        }
    }

    private async getRunningClangd(): Promise<LanguageClient | undefined> {
        const client = this.clangd;
        if (!client || !this.clangdReady) return undefined;
        try {
            await this.clangdReady;
        } catch {
            return undefined;
        }
        return client.state === State.Running ? client : undefined;
    }

    private async getRunningCa65(): Promise<LanguageClient | undefined> {
        if (!this.ca65Client || !this.ca65Ready) return undefined;
        await this.ca65Ready;
        return this.ca65Client;
    }

    // ---------------------------------------------------------------------------------------------
    // Symbol lookups
    // ---------------------------------------------------------------------------------------------

    private async lookupAsmGlobal(asmName: string): Promise<LookupGlobalResult | null> {
        const ca65 = await this.getRunningCa65();
        if (!ca65) return null;
        return ca65.sendRequest<LookupGlobalResult | null>('ca65/lookupGlobal', { name: asmName });
    }

    /** Makes sure clangd has the document open (clangd only answers position requests for open files). */
    private async ensureOpenInClangd(uri: Uri): Promise<void> {
        await workspace.openTextDocument(uri);
    }

    private async clangdSymbolInfo(client: LanguageClient, uri: Uri, position: Position): Promise<ClangdSymbolInfo[] | null> {
        try {
            return await client.sendRequest<ClangdSymbolInfo[] | null>('textDocument/symbolInfo', {
                textDocument: { uri: client.code2ProtocolConverter.asUri(uri) },
                position: client.code2ProtocolConverter.asPosition(position),
            });
        } catch {
            return null;
        }
    }

    /**
     * Resolves the C symbol under the cursor in a C document to its asm counterpart. Returns null
     * unless the symbol has external linkage and asm defines or imports `_name`.
     */
    private async getCGlobalAt(document: TextDocument, position: Position): Promise<{
        cName: string;
        asmName: string;
        info: LookupGlobalResult;
        range: Range;
    } | null> {
        const range = document.getWordRangeAtPosition(position, C_WORD_RE);
        if (!range) return null;
        const cName = document.getText(range);
        const asmName = `_${cName}`;
        const info = await this.lookupAsmGlobal(asmName);
        if (!info) return null;

        const client = await this.getRunningClangd();
        if (client) {
            const symbols = await this.clangdSymbolInfo(client, document.uri, position);
            // When clangd answers, require the symbol to be a C global with external linkage, so that
            // locals and statics with the same name are not linked to asm.
            if (symbols && symbols.length > 0 && !symbols.some(s => isExternalCUsr(s.usr, cName))) {
                return null;
            }
        }
        return { cName, asmName, info, range };
    }

    /** Finds the C definition (or declaration) of an external C symbol via clangd's index. */
    private async findCSymbol(cName: string): Promise<Location | undefined> {
        const client = await this.getRunningClangd();
        if (!client) return undefined;
        return this.findCSymbolInIndex(client, cName);
    }

    /** Looks up an external C symbol in clangd's background index. */
    private async findCSymbolInIndex(client: LanguageClient, cName: string): Promise<Location | undefined> {

        let raw: Array<lsp.SymbolInformation | lsp.WorkspaceSymbol> | null;
        try {
            raw = await client.sendRequest<Array<lsp.SymbolInformation | lsp.WorkspaceSymbol> | null>('workspace/symbol', { query: cName });
        } catch {
            return undefined;
        }
        if (!raw) return undefined;

        const candidates: Location[] = [];
        for (const sym of raw) {
            if (sym.name !== cName || sym.containerName) continue;
            const loc = sym.location;
            if (!('range' in loc)) continue;
            candidates.push(client.protocol2CodeConverter.asLocation(loc as lsp.Location));
        }
        // Prefer definitions in .c files over declarations in headers.
        candidates.sort((a, b) => Number(a.uri.fsPath.endsWith('.h')) - Number(b.uri.fsPath.endsWith('.h')));

        for (const candidate of candidates.slice(0, 8)) {
            try {
                await this.ensureOpenInClangd(candidate.uri);
                const symbols = await this.clangdSymbolInfo(client, candidate.uri, candidate.range.start);
                if (!symbols || symbols.length === 0 || symbols.some(s => isExternalCUsr(s.usr, cName))) {
                    return candidate;
                }
            } catch {
                // try the next candidate
            }
        }
        return undefined;
    }

    /** The global asm symbol under the cursor in an asm document, mapped to its C name. */
    private async getAsmGlobalAt(document: TextDocument, position: Position): Promise<{
        asmName: string;
        cName: string;
        hasAsmDefinition: boolean;
    } | null> {
        const ca65 = await this.getRunningCa65();
        if (!ca65 || !this.clangd) return null;
        const result = await ca65.sendRequest<GlobalSymbolAtResult | null>('ca65/globalSymbolAt', {
            uri: ca65.code2ProtocolConverter.asUri(document.uri),
            position: ca65.code2ProtocolConverter.asPosition(position),
        });
        if (!result) return null;
        const cName = asmNameToCName(result.name);
        if (!cName) return null;
        return { asmName: result.name, cName, hasAsmDefinition: result.hasAsmDefinition };
    }

    private async asmLocations(asmName: string): Promise<Location[]> {
        const ca65 = await this.getRunningCa65();
        if (!ca65) return [];
        const locs = await ca65.sendRequest<lsp.Location[]>('ca65/globalReferences', { name: asmName });
        return (locs ?? []).map(l => ca65.protocol2CodeConverter.asLocation(l));
    }

    private async asmRenameEdit(asmName: string, newAsmName: string): Promise<WorkspaceEdit | undefined> {
        const ca65 = await this.getRunningCa65();
        if (!ca65) return undefined;
        const edit = await ca65.sendRequest<lsp.WorkspaceEdit | null>('ca65/renameGlobal', { name: asmName, newName: newAsmName });
        return ca65.protocol2CodeConverter.asWorkspaceEdit(edit);
    }

    // ---------------------------------------------------------------------------------------------
    // C side (clangd client middleware): add asm results to C requests
    // ---------------------------------------------------------------------------------------------

    private createClangdMiddleware(): Middleware {
        return {
            // C diagnostics come from cc65 itself (see Cc65Diagnostics); clangd's are only shown when
            // cc65 is unavailable.
            handleDiagnostics: (uri, diagnostics, next) => {
                next(uri, this.cc65Diagnostics.active ? [] : diagnostics);
            },

            provideDefinition: async (document, position, token, next) => {
                if (this.inlineAsm.isInInlineAsm(document, position)) {
                    return this.inlineAsm.definition(document, position);
                }
                const base = await next(document, position, token);
                try {
                    const g = await this.getCGlobalAt(document, position);
                    if (!g || g.info.definitions.length === 0 || token.isCancellationRequested) return base;
                    // asm defines the symbol, so everything clangd found is only a declaration:
                    // jump straight to the implementation.
                    const ca65 = await this.getRunningCa65();
                    if (!ca65) return base;
                    return g.info.definitions.map((l): LocationLink => ({
                        originSelectionRange: g.range,
                        targetUri: ca65.protocol2CodeConverter.asUri(l.uri),
                        targetRange: ca65.protocol2CodeConverter.asRange(l.range),
                        targetSelectionRange: ca65.protocol2CodeConverter.asRange(l.range),
                    }));
                } catch (err) {
                    this.log(`C definition bridge failed: ${err}`);
                    return base;
                }
            },

            provideHover: async (document, position, token, next) => {
                if (this.inlineAsm.isInInlineAsm(document, position)) {
                    return this.inlineAsm.hover(document, position);
                }
                // C hovers are clangd's own.
                return next(document, position, token);
            },

            provideReferences: async (document, position, options, token, next) => {
                await this.openInlineAsmDocuments();
                if (this.inlineAsm.isInInlineAsm(document, position)) {
                    return this.inlineAsm.references(document, position);
                }
                const base = await next(document, position, options, token);
                try {
                    const g = await this.getCGlobalAt(document, position);
                    if (!g || token.isCancellationRequested) return base;
                    return mergeLocations(base, mapEmbeddedLocations(await this.asmLocations(g.asmName)) ?? []);
                } catch (err) {
                    this.log(`C references bridge failed: ${err}`);
                    return base;
                }
            },

            provideRenameEdits: async (document, position, newName, token, next) => {
                await this.openInlineAsmDocuments();
                if (this.inlineAsm.isInInlineAsm(document, position)) {
                    return this.inlineAsm.rename(document, position, newName);
                }
                const g = await this.getCGlobalAt(document, position).catch(() => null);
                const base = await next(document, position, newName, token);
                if (!g || !base || token.isCancellationRequested) return base;
                if (!C_IDENTIFIER_RE.test(newName)) return base;
                const asmEdit = await this.asmRenameEdit(g.asmName, `_${newName}`);
                return mergeWorkspaceEdits(base, mapEmbeddedWorkspaceEdit(asmEdit));
            },

            prepareRename: async (document, position, token, next) => {
                if (this.inlineAsm.isInInlineAsm(document, position)) {
                    return this.inlineAsm.prepareRename(document, position);
                }
                return next(document, position, token);
            },

            provideCompletionItem: async (document, position, context, token, next) => {
                if (this.inlineAsm.isInInlineAsm(document, position)) {
                    return this.inlineAsm.completion(document, position, context.triggerCharacter);
                }
                return next(document, position, context, token);
            },

            provideDocumentHighlights: async (document, position, token, next) => {
                if (this.inlineAsm.isInInlineAsm(document, position)) {
                    return this.inlineAsm.documentHighlights(document, position);
                }
                return next(document, position, token);
            },
        };
    }

    // ---------------------------------------------------------------------------------------------
    // asm side (hooks called from the ca65 client middleware): add C results to asm requests
    // ---------------------------------------------------------------------------------------------

    async augmentAsmDefinition(
        document: TextDocument,
        position: Position,
        token: CancellationToken,
        base: Definition | LocationLink[] | null | undefined
    ): Promise<Definition | LocationLink[] | null | undefined> {
        try {
            const g = await this.getAsmGlobalAt(document, position);
            // Only redirect when no asm file defines the symbol (i.e. it is implemented in C).
            if (!g || g.hasAsmDefinition || token.isCancellationRequested) return base;
            const cLoc = await this.findCSymbol(g.cName);
            return cLoc ? [cLoc] : base;
        } catch (err) {
            this.log(`asm definition bridge failed: ${err}`);
            return base;
        }
    }

    async augmentAsmHover(
        document: TextDocument,
        position: Position,
        token: CancellationToken,
        base: Hover | null | undefined
    ): Promise<Hover | null | undefined> {
        try {
            const g = await this.getAsmGlobalAt(document, position);
            if (!g || token.isCancellationRequested) return base;
            const client = await this.getRunningClangd();
            const cLoc = await this.findCSymbol(g.cName);
            if (!client || !cLoc || token.isCancellationRequested) return base;
            const raw = await client.sendRequest<lsp.Hover | null>('textDocument/hover', {
                textDocument: { uri: client.code2ProtocolConverter.asUri(cLoc.uri) },
                position: client.code2ProtocolConverter.asPosition(cLoc.range.start),
            });
            if (token.isCancellationRequested) return base;
            const proto = await this.prototypeFromHover(raw, cLoc.uri, cLoc.range.start.line);
            const cHover = client.protocol2CodeConverter.asHover(raw);
            const cMarkdown = cHover ? hoverContentsToMarkdown(cHover).map(m => m.value).join('\n\n') : '';
            if (g.hasAsmDefinition) {
                // Implemented in asm, declared in C: the asm card plus the C declaration line (the
                // prototype with __fastcall__/__cdecl__, which clangd cannot see, or the extern line).
                const declaration = proto ? formatPrototypeMarkdown(proto) : extractClangdDeclarationBlock(cMarkdown);
                return declaration ? new Hover(withDeclaration(hoverContentsToMarkdown(base), declaration), base?.range) : base;
            }
            // Implemented in C: clangd's card, its declaration showing the calling convention.
            if (!cHover) return base;
            let card = cMarkdown.replace(/^provided by [^\n]*\n/m, '');
            if (proto) card = replaceClangdDeclarationBlock(card, formatPrototypeMarkdown(proto));
            const md = new MarkdownString(card);
            md.isTrusted = { enabledCommands: ['ca65.showReference'] };
            return new Hover([md], base?.range);
        } catch (err) {
            this.log(`asm hover bridge failed: ${err}`);
            return base;
        }
    }

    /**
     * Go to Declaration in an asm document: the C declaration of a symbol shared with C (the prototype
     * in the header for functions implemented in asm or C), else the asm definition.
     */
    private async provideAsmDeclaration(
        document: TextDocument,
        position: Position,
        token: CancellationToken
    ): Promise<LocationLink[] | Location | undefined> {
        try {
            const g = await this.getAsmGlobalAt(document, position);
            const client = await this.getRunningClangd();
            const cLoc = g && client ? await this.findCSymbol(g.cName) : undefined;
            if (client && cLoc && !token.isCancellationRequested) {
                // The index may point at a C definition; clangd's declaration of it is the prototype.
                await this.ensureOpenInClangd(cLoc.uri);
                const raw = await client.sendRequest<lsp.Location | lsp.Location[] | lsp.LocationLink[] | null>('textDocument/declaration', {
                    textDocument: { uri: client.code2ProtocolConverter.asUri(cLoc.uri) },
                    position: client.code2ProtocolConverter.asPosition(cLoc.range.start),
                }).catch(() => null);
                const first = raw ? (Array.isArray(raw) ? raw[0] : raw) : undefined;
                if (first) {
                    const uri = 'targetUri' in first ? first.targetUri : first.uri;
                    const range = 'targetUri' in first ? (first.targetSelectionRange ?? first.targetRange) : first.range;
                    return new Location(client.protocol2CodeConverter.asUri(uri), client.protocol2CodeConverter.asRange(range));
                }
                return cLoc;
            }
        } catch (err) {
            this.log(`asm declaration bridge failed: ${err}`);
        }
        // Not declared in C: the asm definition.
        const defs = await commands.executeCommand<Array<Location | LocationLink>>('vscode.executeDefinitionProvider', document.uri, position);
        return (defs ?? []).map((d): LocationLink => d instanceof Location
            ? { targetUri: d.uri, targetRange: d.range, targetSelectionRange: d.range }
            : d);
    }

    /** Builds a C function prototype from clangd's hover plus the declaration's source text. */
    private async prototypeFromHover(raw: lsp.Hover | null | string, uri: Uri, declarationLine: number): Promise<CFunctionPrototype | undefined> {
        const contents = typeof raw === 'string' ? undefined : raw?.contents;
        const markdown = typeof raw === 'string'
            ? raw
            : contents && typeof contents === 'object' && 'kind' in contents ? contents.value : undefined;
        const parsed = markdown ? parseClangdFunctionHover(markdown) : undefined;
        if (!parsed) return undefined;
        let declarationText = '';
        try {
            const doc = await workspace.openTextDocument(uri);
            declarationText = doc.lineAt(declarationLine).text;
            if (declarationLine > 0) {
                const previous = doc.lineAt(declarationLine - 1).text.trim();
                if (previous && !/[;{}]$/.test(previous) && !previous.startsWith('#') && !previous.startsWith('//') && !previous.endsWith('*/')) {
                    declarationText = `${previous} ${declarationText}`;
                }
            }
        } catch {
            // keep the default convention
        }
        return { ...parsed, convention: detectCallingConvention(declarationText, this.defaultConvention) };
    }

    /** True when the text after `offset` reaches `;` before `{` (a prototype, not a definition). */
    private static isPrototypeAt(text: string, offset: number): boolean {
        const semi = text.indexOf(';', offset);
        const brace = text.indexOf('{', offset);
        return semi >= 0 && (brace < 0 || semi < brace);
    }

    /** "Create assembly stub" on a C prototype that nothing implements yet. */
    private async provideAsmStubActions(document: TextDocument, range: Range): Promise<CodeAction[]> {
        try {
            const client = await this.getRunningClangd();
            if (!client) return [];
            const position = range.start;
            const wordRange = document.getWordRangeAtPosition(position, C_WORD_RE);
            if (!wordRange) return [];
            const name = document.getText(wordRange);
            const text = document.getText();
            const afterName = document.offsetAt(wordRange.end);
            if (!/^\s*\(/.test(text.slice(afterName, afterName + 64)) || !CBridge.isPrototypeAt(text, afterName)) return [];

            const symbols = await this.clangdSymbolInfo(client, document.uri, position);
            if (!symbols?.some(s => s.usr === `c:@F@${name}`)) return [];
            const asm = await this.lookupAsmGlobal(`_${name}`);
            if (asm && asm.definitions.length > 0) return [];
            // A C definition elsewhere? (the index prefers definitions)
            const indexed = await this.findCSymbolInIndex(client, name);
            if (indexed) {
                const defDoc = await workspace.openTextDocument(indexed.uri);
                if (!CBridge.isPrototypeAt(defDoc.getText(), defDoc.offsetAt(indexed.range.end))) return [];
            }

            const action = new CodeAction(`Create assembly stub for \`${name}\``, CodeActionKind.RefactorRewrite);
            action.command = { command: 'ca65.createAsmStub', title: action.title, arguments: [document.uri, position] };
            return [action];
        } catch (err) {
            this.log(`asm stub code action failed: ${err}`);
            return [];
        }
    }

    /** Appends an asm implementation stub for the C prototype at `position` to a chosen asm file. */
    private async createAsmStub(uri?: Uri, position?: Position): Promise<void> {
        const editor = window.activeTextEditor;
        uri ??= editor?.document.uri;
        position ??= editor?.selection.active;
        const client = await this.getRunningClangd();
        if (!uri || !position || !client) {
            void window.showInformationMessage('ca65: put the cursor on a C function prototype (cc65 C mode must be running).');
            return;
        }
        const raw = await client.sendRequest<lsp.Hover | null>('textDocument/hover', {
            textDocument: { uri: client.code2ProtocolConverter.asUri(uri) },
            position: client.code2ProtocolConverter.asPosition(position),
        });
        const proto = await this.prototypeFromHover(raw, uri, position.line);
        if (!proto) {
            void window.showInformationMessage('ca65: no C function prototype at the cursor.');
            return;
        }

        const asmFiles = (await workspace.findFiles('**/*.{s,asm}', SOURCE_EXCLUDE_GLOB, 500))
            .filter(u => u.scheme === 'file')
            .sort((a, b) => a.fsPath.localeCompare(b.fsPath));
        const newFileItem: QuickPickItem = { label: '$(new-file) New file…' };
        const fileItems = asmFiles.map(u => ({ label: workspace.asRelativePath(u), uri: u }));
        const picked = await window.showQuickPick<QuickPickItem & { uri?: Uri }>([newFileItem, ...fileItems], {
            placeHolder: `Add the assembly stub for ${proto.name} to…`,
        });
        if (!picked) return;

        const stub = buildAsmStub(proto);
        const edit = new WorkspaceEdit();
        let target: Uri;
        if (picked === newFileItem) {
            const chosen = await window.showSaveDialog({
                defaultUri: Uri.file(path.join(path.dirname(uri.fsPath), `${proto.name}.s`)),
                filters: { 'Assembly': ['s', 'asm'] },
            });
            if (!chosen) return;
            target = chosen;
            edit.createFile(target, { ignoreIfExists: true });
            edit.insert(target, new Position(0, 0), stub.replace(/^\n/, ''));
        } else {
            target = picked.uri!;
            const doc = await workspace.openTextDocument(target);
            const end = doc.lineAt(doc.lineCount - 1).range.end;
            edit.insert(target, end, (doc.getText().endsWith('\n') || doc.getText() === '' ? '' : '\n') + stub);
        }
        if (!(await workspace.applyEdit(edit))) {
            void window.showErrorMessage(`ca65: could not write the stub to ${target.fsPath}.`);
            return;
        }
        const doc = await workspace.openTextDocument(target);
        const shown = await window.showTextDocument(doc, { viewColumn: ViewColumn.Active });
        const procLine = doc.getText().split('\n').findIndex(l => l.trim() === `.proc _${proto.name}`);
        if (procLine >= 0) {
            const todo = new Position(procLine + 1, doc.lineAt(procLine + 1).text.length);
            shown.selection = new Selection(todo, todo);
            shown.revealRange(new Range(procLine, 0, procLine, 0), TextEditorRevealType.InCenter);
        }
    }

    async augmentAsmReferences(
        document: TextDocument,
        position: Position,
        token: CancellationToken,
        base: Location[] | null | undefined
    ): Promise<Location[] | null | undefined> {
        try {
            const g = await this.getAsmGlobalAt(document, position);
            if (!g || token.isCancellationRequested) return base;
            const client = await this.getRunningClangd();
            const cLoc = await this.findCSymbol(g.cName);
            if (!client || !cLoc || token.isCancellationRequested) return base;
            // The asm server only reports references within the current translation unit for symbols
            // it cannot resolve to an asm definition; add every asm file that uses the global symbol.
            base = mergeLocations(base, mapEmbeddedLocations(await this.asmLocations(g.asmName)) ?? []);
            const raw = await client.sendRequest<lsp.Location[] | null>('textDocument/references', {
                textDocument: { uri: client.code2ProtocolConverter.asUri(cLoc.uri) },
                position: client.code2ProtocolConverter.asPosition(cLoc.range.start),
                context: { includeDeclaration: true },
            });
            const cRefs = (await client.protocol2CodeConverter.asReferences(raw)) ?? [];
            return mergeLocations(base, cRefs);
        } catch (err) {
            this.log(`asm references bridge failed: ${err}`);
            return base;
        }
    }

    /**
     * Rename started in asm. Validates the new name against the cc65 convention before the asm rename
     * runs, then adds clangd's C edits.
     */
    async renameFromAsm(
        document: TextDocument,
        position: Position,
        newName: string,
        token: CancellationToken,
        next: () => Promise<WorkspaceEdit | null | undefined>
    ): Promise<WorkspaceEdit | null | undefined> {
        let g: Awaited<ReturnType<CBridge['getAsmGlobalAt']>> = null;
        let cLoc: Location | undefined;
        try {
            g = await this.getAsmGlobalAt(document, position);
            cLoc = g ? await this.findCSymbol(g.cName) : undefined;
        } catch (err) {
            this.log(`asm rename bridge lookup failed: ${err}`);
        }
        if (!g || !cLoc) {
            return next();
        }

        const newCName = asmNameToCName(newName);
        if (!newCName) {
            throw new Error(
                `'${g.asmName}' is shared with C as '${g.cName}'. The new name must start with '_' followed by a valid C identifier (e.g. '_${g.cName}2').`
            );
        }

        const base = await next();
        if (!base || token.isCancellationRequested) return base;

        const client = await this.getRunningClangd();
        if (!client) return base;
        const raw = await client.sendRequest<lsp.WorkspaceEdit | null>('textDocument/rename', {
            textDocument: { uri: client.code2ProtocolConverter.asUri(cLoc.uri) },
            position: client.code2ProtocolConverter.asPosition(cLoc.range.start),
            newName: newCName,
        });
        const cEdit = await client.protocol2CodeConverter.asWorkspaceEdit(raw);
        return mergeWorkspaceEdits(base, cEdit);
    }
}

/** Middleware entries for the ca65 client that route through the bridge. */
export function createCa65BridgeMiddleware(bridge: CBridge): Middleware {
    // Results may point into embedded inline-asm documents; map those back onto their C files.
    return {
        provideDefinition: async (document, position, token, next) => {
            const base = await next(document, position, token);
            return mapEmbeddedDefinition(await bridge.augmentAsmDefinition(document, position, token, base));
        },
        provideHover: async (document, position, token, next) => {
            const base = await next(document, position, token);
            return bridge.augmentAsmHover(document, position, token, base);
        },
        provideReferences: async (document, position, options, token, next) => {
            await bridge.openInlineAsmDocuments();
            const base = await next(document, position, options, token);
            return mapEmbeddedLocations(await bridge.augmentAsmReferences(document, position, token, base));
        },
        provideRenameEdits: async (document, position, newName, token, next) => {
            await bridge.openInlineAsmDocuments();
            return mapEmbeddedWorkspaceEdit(await bridge.renameFromAsm(
                document,
                position,
                newName,
                token,
                async () => (await next(document, position, newName, token)) ?? undefined
            ));
        },
    };
}
