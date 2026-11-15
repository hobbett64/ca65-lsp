/**
 * This module handles running the ca65 compiler in the background to provide
 * live error, warning, and hint diagnostics.
 */

import {
    _Connection,
    TextDocuments,
    Diagnostic,
    DiagnosticSeverity,
    Range,
    DiagnosticTag,
} from 'vscode-languageserver/node';
import { TextDocument } from 'vscode-languageserver-textdocument';
import * as path from 'path';
import { execFile } from 'child_process';
import { ensureDocumentRefreshed, exportsMap, getDocumentSettings, includesGraph, performanceMonitor, symbolTables } from './server';
import * as fs from 'fs/promises';
import * as os from "os";
import { promisify } from 'util';
import { Ca65Settings, normalizeCpu } from './settings';
import which from "which";
import { fsPathToUri, getWorkspaceFolderOfFile, resolveWorkspaceRelativeDirs, uriToFsPath } from './pathUtils';
import { countReferencesByFile, isEntityUsed, resolveImport } from './symbolResolver';
import { ImportKind, isZeroPageSegmentName, Scope, ScopeKind, Symbol as Ca65Symbol, SymbolKind as Ca65SymbolKind, SymbolTableEntity } from './symbolTable';
import { findCommentStart } from './documentScanner';
import { getCachedTextDocument, isOpenDocumentPotentiallyDirty } from './documentCache';

const execFileAsync = promisify(execFile);

const validationTimers: Map<string, NodeJS.Timeout> = new Map();
const pendingFilesToUpdate: Map<string, Set<string>> = new Map();
const activeValidationControllers: Set<AbortController> = new Set();
const cachedExecutablePaths: Map<string, string | null> = new Map();
const w65c02UnsupportedPaths: Set<string> = new Set();
const VALIDATION_ROOT_CONCURRENCY = 4;
const SHADOW_IO_CONCURRENCY = 16;
let connection: _Connection;
let documents: TextDocuments<TextDocument>;
let hasShownCa65NotFoundMessage = false;

export function clearExecutablePathCache(): void {
    cachedExecutablePaths.clear();
    w65c02UnsupportedPaths.clear();
}

export function initializeDiagnostics(conn: _Connection, docs: TextDocuments<TextDocument>) {
    connection = conn;
    documents = docs;
}

/**
 * Finds unused symbols in a given file.
 * @param uri The URI of the document to check.
 * @param checkedUnusedSymbols A set to track symbols that have already been checked to avoid duplicate work.
 * @param existingDiags A list of existing diagnostics on the file to avoid creating conflicting hints.
 * @param signal AbortSignal for cancelling the operation.
 * @param precomputedCounts Optional precomputed per-file reference hit counts.
 * @returns An array of diagnostics for unused symbols.
 */
async function findUnusedSymbolDiagnostics(
    uri: string,
    checkedUnusedSymbols: Set<string>,
    existingDiags: readonly Diagnostic[],
    signal: AbortSignal,
    precomputedCounts?: Map<string, Map<SymbolTableEntity, number>>,
): Promise<Diagnostic[]> {
    return performanceMonitor.timeAsync("findUnusedSymbolDiagnostics", async () => {
        const lspDiagnostics: Diagnostic[] = [];
        const symbolTable = symbolTables.get(uri);
        if (!symbolTable) {
            return [];
        }

        const definedEntities = symbolTable.getAllDefinedEntities();
        const diagLines = new Set<number>();
        for (const diag of existingDiags) {
            diagLines.add(diag.range.start.line);
        }

        let i = 0;
        for (const entity of definedEntities) {
            // Yield periodically so incoming edits can abort long checks.
            if (i % 100 === 0) {
                await Promise.resolve();
                if (signal.aborted) return [];
            }
            i++;

            if (entity.name.startsWith('<anon')) {
                continue;
            }
            const fqn = entity.getFullyQualifiedName();
            if (checkedUnusedSymbols.has(fqn)) {
                continue;
            }

            // Do not mark a symbol as unused if its definition line already has a diagnostic.
            if (diagLines.has(entity.definition.start.line)) {
                continue;
            }

            if (!isEntityUsed(entity, symbolTables, includesGraph, precomputedCounts)) {
                lspDiagnostics.push({
                    severity: DiagnosticSeverity.Hint,
                    range: entity.definition,
                    message: `Symbol '${entity.name}' is defined but never used.`,
                    source: 'ca65-lsp',
                    tags: [DiagnosticTag.Unnecessary]
                });
            }
            checkedUnusedSymbols.add(fqn);
        }
        return lspDiagnostics;
    });
}

function entityCarriesSegmentAddress(entity: SymbolTableEntity): boolean {
    if (entity instanceof Ca65Symbol) {
        return entity.kind === Ca65SymbolKind.Label
            || entity.kind === Ca65SymbolKind.ResLabel
            || entity.kind === Ca65SymbolKind.DataLabel
            || entity.kind === Ca65SymbolKind.StringLabel;
    }
    return entity instanceof Scope && entity.kind === ScopeKind.Proc;
}

/**
 * Checks `.import`/`.importzp` and `.global`/`.globalzp` declarations against the resolved
 * target symbol's segment and `.exportzp` declarations to warn on zero-page width mismatches.
 */
export function findImportMismatchDiagnostics(uri: string): Diagnostic[] {
    const symbolTable = symbolTables.get(uri);
    if (!symbolTable || symbolTable.imports.length === 0) {
        return [];
    }

    const diagnostics: Diagnostic[] = [];
    for (const imp of symbolTable.imports) {
        const resolved = resolveImport(imp.name, symbolTables, includesGraph);
        if (!resolved) continue;

        // `.global` inside the defining file acts as an export rather than an external import
        if (imp.kind === ImportKind.Global && resolved.uri === imp.uri) {
            continue;
        }

        const matchingExport = exportsMap?.get(imp.name)?.find(exp => exp.uri === resolved.uri);
        const resolvedSeg = resolved.segment;
        const segmentBased = entityCarriesSegmentAddress(resolved) && Boolean(resolvedSeg);

        const definitelyZp = Boolean(matchingExport?.isZeroPage) || (segmentBased && isZeroPageSegmentName(resolvedSeg));
        const definitelyNonZp = !matchingExport?.isZeroPage && segmentBased && !isZeroPageSegmentName(resolvedSeg);

        if (!imp.isZeroPage && definitelyZp) {
            const reason = matchingExport?.isZeroPage
                ? `exported with '.exportzp'`
                : `defined in zero-page segment '${resolvedSeg}'`;
            diagnostics.push({
                severity: DiagnosticSeverity.Warning,
                range: imp.definition,
                message: `Symbol '${imp.name}' is ${reason}, but imported without '.importzp'.`,
                source: 'ca65-lsp',
                code: 'import-zp-expected',
            });
        } else if (imp.isZeroPage && definitelyNonZp) {
            diagnostics.push({
                severity: DiagnosticSeverity.Warning,
                range: imp.definition,
                message: `Symbol '${imp.name}' is defined in segment '${resolvedSeg}' (non-ZEROPAGE), but imported as zero-page.`,
                source: 'ca65-lsp',
                code: 'import-abs-expected',
            });
        }
    }

    return diagnostics;
}

/**
 * Checks if a file exists and is executable.
 */
async function isExecutable(filePath: string): Promise<boolean> {
    try {
        await fs.access(filePath, fs.constants.X_OK);
        return true;
    } catch {
        return false;
    }
}

/**
 * Finds the ca65 executable by searching in order of priority (cached by configured path).
 * @returns The full path to the executable, or null if not found.
 */
export async function findCa65Executable(settings: Ca65Settings): Promise<string | null> {
    const cacheKey = settings.executablePath || '';
    if (cachedExecutablePaths.has(cacheKey)) {
        return cachedExecutablePaths.get(cacheKey) ?? null;
    }

    let resolvedPath: string | null = null;
    if (settings.executablePath) {
        const expandedPath = path.resolve(settings.executablePath.replace(/^~/, os.homedir()));
        if (await isExecutable(expandedPath)) {
            resolvedPath = expandedPath;
        }
    }
    if (!resolvedPath) {
        try {
            const pathInSystem = await which('ca65');
            if (pathInSystem) resolvedPath = pathInSystem;
        } catch {}
    }

    cachedExecutablePaths.set(cacheKey, resolvedPath);
    return resolvedPath;
}

async function getDocumentCached(
    uri: string,
    docCache: Map<string, TextDocument | null>
): Promise<TextDocument | null> {
    return getCachedTextDocument(uri, documents, docCache);
}

function sanitizeAdditionalCa65Args(rawArgs: unknown): string[] {
    if (!Array.isArray(rawArgs)) return [];
    const safeArgs: string[] = [];
    for (let i = 0; i < rawArgs.length; i++) {
        const arg = typeof rawArgs[i] === 'string' ? rawArgs[i].trim() : '';
        if (!arg) continue;
        // Skip output/listing flags (and their path value) so temporary LSP outputs stay intact.
        if (arg === '-o' || arg === '-l' || arg === '--listing') {
            i++;
            continue;
        }
        if (arg.startsWith('--listing=') || (arg.startsWith('-o') && !arg.startsWith('--')) || (arg.startsWith('-l') && !arg.startsWith('--'))) {
            continue;
        }
        safeArgs.push(arg);
    }
    return safeArgs;
}

export interface Ca65AssembleOptions {
    generateListing?: boolean;
    /** When true, runs even if `ca65.enableCa65StdErrDiagnostics` is false. */
    ignoreDiagnosticSetting?: boolean;
}

export interface Ca65AssembleResult {
    stderr: string;
    hasErrors: boolean;
    effectiveCwd: string;
    workspaceRoot: string;
    shadowDir: string | null;
    listingContent?: string;
}

/**
 * Runs `ca65` on the given translation unit root (using a shadow directory if any open TU file has unsaved edits).
 */
export async function assembleTranslationUnit(
    textDocument: TextDocument,
    signal: AbortSignal,
    options: Ca65AssembleOptions = {}
): Promise<Ca65AssembleResult | null> {
    return performanceMonitor.timeAsync('assembleTranslationUnit', async () => {
        const settings = await getDocumentSettings(textDocument.uri);
        if (signal.aborted) return null;
        if (!options.ignoreDiagnosticSetting && !settings.enableCa65StdErrDiagnostics) {
            return null;
        }

        const ca65Path = await findCa65Executable(settings);
        if (signal.aborted) return null;
        if (!ca65Path) {
            if (!hasShownCa65NotFoundMessage && !options.ignoreDiagnosticSetting) {
                connection.window.showErrorMessage('ca65 executable not found. Please set "ca65.executablePath" or ensure it is in your PATH.');
                hasShownCa65NotFoundMessage = true;
            }
            return null;
        }

        const workspaceFolderUri = getWorkspaceFolderOfFile(textDocument.uri);
        const filePath = uriToFsPath(textDocument.uri);
        const fileDir = path.dirname(filePath);
        const workspaceRoot = workspaceFolderUri ? uriToFsPath(workspaceFolderUri) : fileDir;

        const tuUris = new Set<string>(includesGraph.getTranslationUnitSet(textDocument.uri));
        tuUris.add(textDocument.uri);

        // Build a lightweight shadow directory only when an open TU file has unsaved edits.
        let needsShadow = false;
        const openDocsInTu = new Map<string, TextDocument>();
        for (const tuUri of tuUris) {
            const openDoc = documents.get(tuUri);
            if (!openDoc) continue;
            openDocsInTu.set(tuUri, openDoc);
            if (!needsShadow && await isOpenDocumentPotentiallyDirty(openDoc)) {
                needsShadow = true;
            }
        }
        if (signal.aborted) return null;

        let shadowDir: string | null = null;
        let listingTempDir: string | null = null;
        let effectiveCwd = workspaceRoot;
        const inputArg = path.relative(workspaceRoot, filePath);
        let stderr = '';
        let hasErrors = false;
        let listingContent: string | undefined;

        try {
            const userIncludeDirs = resolveWorkspaceRelativeDirs(textDocument.uri, settings.includeDirs);
            const userBinIncludeDirs = resolveWorkspaceRelativeDirs(textDocument.uri, settings.binIncludeDirs);
            const extraShadowIncludeDirs: string[] = [];
            const originalSourceDirs = new Set<string>([fileDir, workspaceRoot]);

            if (needsShadow) {
                shadowDir = await fs.mkdtemp(path.join(os.tmpdir(), 'ca65-lsp-'));
                effectiveCwd = shadowDir;
                const createdTargets = new Set<string>();
                const targetDirs = new Set<string>();
                const shadowTasks: Array<{ tuUri: string; tuFsPath: string; targetPath: string }> = [];

                for (const tuUri of tuUris) {
                    if (signal.aborted) return null;
                    const tuFsPath = uriToFsPath(tuUri);
                    originalSourceDirs.add(path.dirname(tuFsPath));
                    const rel = path.relative(workspaceRoot, tuFsPath);
                    if (rel.startsWith('..') || path.isAbsolute(rel)) {
                        continue;
                    }

                    const targetPath = path.join(shadowDir, rel);
                    if (createdTargets.has(targetPath)) continue;
                    createdTargets.add(targetPath);
                    targetDirs.add(path.dirname(targetPath));
                    shadowTasks.push({ tuUri, tuFsPath, targetPath });
                }

                await Promise.all(Array.from(targetDirs, dir => fs.mkdir(dir, { recursive: true })));
                if (signal.aborted) return null;

                let nextTaskIdx = 0;
                const workerCount = Math.min(SHADOW_IO_CONCURRENCY, shadowTasks.length);
                const runShadowWorker = async () => {
                    while (nextTaskIdx < shadowTasks.length && !signal.aborted) {
                        const task = shadowTasks[nextTaskIdx++];
                        const openDoc = openDocsInTu.get(task.tuUri);
                        if (openDoc) {
                            await fs.writeFile(task.targetPath, openDoc.getText(), 'utf-8');
                        } else {
                            try {
                                await fs.symlink(task.tuFsPath, task.targetPath);
                            } catch {
                                await fs.copyFile(task.tuFsPath, task.targetPath);
                            }
                        }
                    }
                };
                if (workerCount > 0) {
                    await Promise.all(Array.from({ length: workerCount }, () => runShadowWorker()));
                }

                for (const includeDir of userIncludeDirs) {
                    const relDir = path.relative(workspaceRoot, includeDir);
                    if (!relDir.startsWith('..') && !path.isAbsolute(relDir)) {
                        extraShadowIncludeDirs.push(path.join(shadowDir, relDir));
                    }
                }
            }
            if (signal.aborted) return null;

            const args = [inputArg, '-o', process.platform === 'win32' ? 'NUL' : '/dev/null'];

            let listingPath: string | undefined;
            if (options.generateListing) {
                listingTempDir = await fs.mkdtemp(path.join(os.tmpdir(), 'ca65-lst-'));
                listingPath = path.join(listingTempDir, 'output.lst');
                args.push('-l', listingPath);
            }

            if (settings.implicitImports) args.push('--auto-import');

            if (shadowDir) {
                for (const dir of extraShadowIncludeDirs) {
                    args.push('-I', dir);
                }
            }
            for (const includeDir of userIncludeDirs) {
                args.push('-I', includeDir);
            }
            if (shadowDir) {
                for (const dir of originalSourceDirs) {
                    args.push('-I', dir);
                }
                for (const dir of originalSourceDirs) {
                    args.push('--bin-include-dir', dir);
                }
            }
            for (const binIncludeDir of userBinIncludeDirs) {
                args.push('--bin-include-dir', binIncludeDir);
            }

            if (settings.lineContinuations) {
                args.push('--feature', 'line_continuations');
            }

            const cpu = normalizeCpu(settings.cpu);
            if (cpu !== '6502') {
                const effectiveCpu = (cpu === 'W65C02' && w65c02UnsupportedPaths.has(ca65Path))
                    ? '65C02'
                    : cpu;
                args.push('--cpu', effectiveCpu);
            }

            args.push(...sanitizeAdditionalCa65Args(settings.additionalArgs));

            try {
                const result = await execFileAsync(ca65Path, args, { cwd: effectiveCwd, signal });
                stderr = result.stderr;
            } catch (err: any) {
                hasErrors = true;
                if (err && err.stderr) stderr = err.stderr;
                if (cpu === 'W65C02' && stderr.includes("Invalid CPU: 'W65C02'")) {
                    w65c02UnsupportedPaths.add(ca65Path);
                    const cpuFlagIndex = args.indexOf('--cpu');
                    if (cpuFlagIndex !== -1 && args[cpuFlagIndex + 1] === 'W65C02') {
                        args[cpuFlagIndex + 1] = '65C02';
                        hasErrors = false;
                        stderr = '';
                        try {
                            const retryResult = await execFileAsync(ca65Path, args, { cwd: effectiveCwd, signal });
                            stderr = retryResult.stderr;
                        } catch (retryErr: any) {
                            hasErrors = true;
                            if (retryErr && retryErr.stderr) stderr = retryErr.stderr;
                        }
                    }
                }
            }

            if (listingPath && !hasErrors && !signal.aborted) {
                try {
                    listingContent = await fs.readFile(listingPath, 'utf-8');
                } catch {}
            }
        } finally {
            if (shadowDir) {
                await fs.rm(shadowDir, { recursive: true, force: true }).catch(() => {});
            }
            if (listingTempDir) {
                await fs.rm(listingTempDir, { recursive: true, force: true }).catch(() => {});
            }
        }

        return {
            stderr,
            hasErrors,
            effectiveCwd,
            workspaceRoot,
            shadowDir,
            listingContent,
        };
    });
}

/**
 * Gathers only the ca65 compiler diagnostics for a single translation unit.
 * @param textDocument The root document of the translation unit to validate.
 * @param signal AbortSignal for cancelling the operation.
 * @param docCache Per-validation cache of unopened documents.
 * @returns A Map of URIs to their collected compiler diagnostics.
 */
async function getCompilerDiagnosticsForUnit(
    textDocument: TextDocument,
    signal: AbortSignal,
    docCache: Map<string, TextDocument | null>
): Promise<Map<string, Diagnostic[]>> {
    return performanceMonitor.timeAsync("getCompilerDiagnosticsForUnit", async () => {
        const diagnosticsByUri = new Map<string, Diagnostic[]>();
        const assembled = await assembleTranslationUnit(textDocument, signal);
        if (!assembled || signal.aborted) return diagnosticsByUri;

        const { stderr, effectiveCwd, workspaceRoot, shadowDir } = assembled;

        if (stderr) {
            const lines = stderr.split(/\r?\n/);
            // ca65 emits `file(line): Error: ...` by default and `file:line: Error: ...` in gcc format
            const errorRegex = /^(.*?)(?:\((\d+)\)|:(\d+)):\s(Warning|Error):\s(.*)$/;
            const noteRegex = /^(.*?)(?:\((\d+)\)|:(\d+)):\sNote:\s(.*)$/;
            const resolveErrorUri = (fileName: string): string => {
                const resolved = path.resolve(effectiveCwd, fileName);
                if (shadowDir && (resolved === shadowDir || resolved.startsWith(shadowDir + path.sep))) {
                    const rel = path.relative(shadowDir, resolved);
                    return fsPathToUri(path.resolve(workspaceRoot, rel));
                }
                return fsPathToUri(resolved);
            };
            
            for (let i = 0; i < lines.length; i++) {
                if (signal.aborted) return new Map();
                const line = lines[i];
                const errorMatch = line.match(errorRegex);
                if (errorMatch) {
                    const [, fileName, parenLine, colonLine, severityStr, message] = errorMatch;
                    const lineNumStr = parenLine || colonLine;
                    const errorFileUri = resolveErrorUri(fileName);
                    const lineNumber = Math.max(0, parseInt(lineNumStr, 10) - 1);

                    if (!diagnosticsByUri.has(errorFileUri)) {
                        diagnosticsByUri.set(errorFileUri, []);
                    }

                    const diagnostic: Diagnostic = {
                        severity: severityStr === 'Error' ? DiagnosticSeverity.Error : DiagnosticSeverity.Warning,
                        range: Range.create(lineNumber, 0, lineNumber + 1, 0), // Default to full line
                        message,
                        source: 'ca65',
                        relatedInformation: []
                    };

                    const errorDocument = await getDocumentCached(errorFileUri, docCache);
                    if (errorDocument && lineNumber < errorDocument.lineCount) {
                        const lineText = errorDocument.getText(Range.create(lineNumber, 0, lineNumber + 1, 0));
                        const commentIdx = findCommentStart(lineText);
                        const lineWithoutComment = commentIdx >= 0 ? lineText.substring(0, commentIdx) : lineText;
                        const trimmedLine = lineWithoutComment.trim();
                        const startChar = trimmedLine ? lineWithoutComment.indexOf(trimmedLine) : 0;
                        const endChar = startChar + trimmedLine.length;
                        diagnostic.range = Range.create(lineNumber, startChar, lineNumber, endChar);

                        const symbolMatch = message.match(/Symbol\s+[‘'](.*?)[’']/);
                        const foundTokenMatch = message.match(/found\s+[‘'](.*?)[’']/);

                        if (symbolMatch) {
                            const symbolName = symbolMatch[1];
                            const symbolIndex = lineWithoutComment.indexOf(symbolName);
                            if (symbolIndex !== -1) {
                                diagnostic.range = Range.create(lineNumber, symbolIndex, lineNumber, symbolIndex + symbolName.length);
                            }
                        } else if (foundTokenMatch) {
                            const token = foundTokenMatch[1];
                            const tokenIndex = lineWithoutComment.indexOf(token);
                            if (tokenIndex !== -1) {
                                diagnostic.range = Range.create(lineNumber, tokenIndex, lineNumber, tokenIndex + token.length);
                            }
                        }
                    }

                    const noteMatch = (i + 1 < lines.length) ? lines[i + 1].match(noteRegex) : null;
                    if (noteMatch) {
                        const [, noteFileName, noteParenLine, noteColonLine, noteMessage] = noteMatch;
                        const noteLineNumStr = noteParenLine || noteColonLine;
                        const noteFileUri = resolveErrorUri(noteFileName);
                        const noteLineNumber = Math.max(0, parseInt(noteLineNumStr, 10) - 1);
                        diagnostic.relatedInformation?.push({
                            location: {
                                uri: noteFileUri,
                                range: Range.create(noteLineNumber, 0, noteLineNumber + 1, 0)
                            },
                            message: noteMessage
                        });
                        i++;
                    }
                    diagnosticsByUri.get(errorFileUri)!.push(diagnostic);
                }
            }
        }
        return diagnosticsByUri;
    });
}

export function hasPendingValidation(uri: string): boolean {
    return validationTimers.has(uri);
}

export function addPendingValidationFiles(uri: string, files: Iterable<string>): void {
    let pendingSet = pendingFilesToUpdate.get(uri);
    if (!pendingSet) {
        pendingSet = new Set<string>();
        pendingFilesToUpdate.set(uri, pendingSet);
    }
    for (const f of files) {
        pendingSet.add(f);
    }
}

export function abortValidation() {
    for (const controller of activeValidationControllers) {
        controller.abort();
    }
    activeValidationControllers.clear();
}

/**
 * Triggers a debounced validation.
 * @param uri The URI of the file that triggered the validation.
 * @param debounce Whether to debounce the validation call.
 * @param allFilesToUpdate A pre-calculated set of all files that need their diagnostics refreshed.
 */
export function triggerValidation(uri: string, debounce: boolean = true, allFilesToUpdate?: Set<string>) {
    abortValidation();

    if (allFilesToUpdate && allFilesToUpdate.size > 0) {
        let pendingSet = pendingFilesToUpdate.get(uri);
        if (!pendingSet) {
            pendingSet = new Set<string>();
            pendingFilesToUpdate.set(uri, pendingSet);
        }
        for (const f of allFilesToUpdate) {
            pendingSet.add(f);
        }
    }

    if (validationTimers.has(uri)) {
        clearTimeout(validationTimers.get(uri)!);
    }

    validationTimers.set(uri, setTimeout(async () => {
        validationTimers.delete(uri);
        const controller = new AbortController();
        activeValidationControllers.add(controller);
        const signal = controller.signal;

        try {
            await ensureDocumentRefreshed?.(uri);
            if (signal.aborted) return;

            const fullDiagnosticsByUri = new Map<string, Diagnostic[]>();

            // Combine any pre-edit affected files accumulated across debounced edits with the latest TU.
            const filesToUpdate = new Set<string>(pendingFilesToUpdate.get(uri));
            for (const tuUri of includesGraph.getTranslationUnitSet(uri)) {
                filesToUpdate.add(tuUri);
            }

            const existingRoots = includesGraph.getIncludingRootsArray(uri);
            const allRoots = (existingRoots.length === 0 && includesGraph.isTranslationUnitRoot(uri))
                ? [uri]
                : existingRoots;
            const settings = await getDocumentSettings(uri);
            if (signal.aborted) return;

            // 1. Initialize full diagnostic list for all potentially affected files to ensure old ones are cleared.
            for (const fileUri of filesToUpdate) {
                fullDiagnosticsByUri.set(fileUri, []);
            }

            // 2. Gather context-dependent compiler diagnostics from each root with bounded concurrency.
            const docCache = new Map<string, TextDocument | null>();
            const rootResults: Array<Map<string, Diagnostic[]> | null> = new Array(allRoots.length).fill(null);
            let nextRootIdx = 0;
            const workerCount = Math.min(VALIDATION_ROOT_CONCURRENCY, allRoots.length);
            const runRootWorker = async () => {
                while (nextRootIdx < allRoots.length && !signal.aborted) {
                    const idx = nextRootIdx++;
                    const doc = await getDocumentCached(allRoots[idx], docCache);
                    if (!doc || signal.aborted) continue;
                    rootResults[idx] = await getCompilerDiagnosticsForUnit(doc, signal, docCache);
                }
            };
            if (workerCount > 0) {
                await Promise.all(Array.from({ length: workerCount }, () => runRootWorker()));
            }
            if (signal.aborted) return;

            const seenCompilerDiags = new Set<string>();
            for (let idx = 0; idx < rootResults.length; idx++) {
                const compilerDiagnostics = rootResults[idx];
                if (!compilerDiagnostics) continue;
                for (const [fileUri, diags] of compilerDiagnostics.entries()) {
                    const existingDiags = fullDiagnosticsByUri.get(fileUri);
                    if (existingDiags) {
                        for (const newDiag of diags) {
                            const messageWithoutContext = newDiag.message.replace(/^\[[^\]]*\]\s*/, '');
                            const signature = `${fileUri}:${newDiag.range.start.line}:${messageWithoutContext}`;
                            if (!seenCompilerDiags.has(signature)) {
                                existingDiags.push(newDiag);
                                seenCompilerDiags.add(signature);
                            }
                        }
                    }
                }
            }

            // 3. Gather context-independent "unused symbol" diagnostics ONCE.
            if (settings.enableUnusedSymbolDiagnostics) {
                const allTuUris = new Set<string>(filesToUpdate);
                for (const fileUri of filesToUpdate) {
                    for (const tuUri of includesGraph.getTranslationUnitSet(fileUri)) {
                        allTuUris.add(tuUri);
                    }
                }
                const precomputedCounts = countReferencesByFile(allTuUris, symbolTables, includesGraph);
                if (signal.aborted) return;

                const checkedUnusedSymbols = new Set<string>();
                for (const fileUri of filesToUpdate) {
                    const unusedSymbolDiags = await findUnusedSymbolDiagnostics(
                        fileUri,
                        checkedUnusedSymbols,
                        fullDiagnosticsByUri.get(fileUri) || [],
                        signal,
                        precomputedCounts
                    );
                    if (signal.aborted) return;
                    fullDiagnosticsByUri.get(fileUri)?.push(...unusedSymbolDiags);
                }
            }

            // 4. Warn on .import/.importzp vs resolved segment/exportzp mismatches.
            for (const fileUri of filesToUpdate) {
                const mismatchDiags = findImportMismatchDiagnostics(fileUri);
                if (mismatchDiags.length > 0) {
                    fullDiagnosticsByUri.get(fileUri)?.push(...mismatchDiags);
                }
            }

            if (signal.aborted) return;
            pendingFilesToUpdate.delete(uri);

            // 4. Send the final, consolidated diagnostics for every affected file.
            for (const fileUri of filesToUpdate) {
                connection.sendDiagnostics({ uri: fileUri, diagnostics: fullDiagnosticsByUri.get(fileUri) || [] });
            }
        } catch (err) {
            connection.console.error(`Validation failed for ${uri}: ${err}`);
        } finally {
            activeValidationControllers.delete(controller);
        }
    }, debounce ? 500 : 0));
}
