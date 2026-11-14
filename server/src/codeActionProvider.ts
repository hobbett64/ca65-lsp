import {
    _Connection,
    CodeAction,
    CodeActionKind,
    CodeActionParams,
    Diagnostic,
    Position,
    Range,
    TextDocuments,
    TextEdit,
} from 'vscode-languageserver/node';
import { TextDocument } from 'vscode-languageserver-textdocument';
import { URI } from 'vscode-uri';
import * as fs from 'fs/promises';
import { findCommentStart } from './documentScanner';
import { getLineText, isAutoIncludable, makeExportEdit, makeImportEdit, makeIncludeEdit } from './editUtils';
import { findCanonicalIncludePath, getWorkspaceRelativePath } from './pathUtils';
import {
    exportsMap,
    getDocumentSettings,
    includesGraph,
    initializationGate,
    performanceMonitor,
    symbolTables,
} from './server';
import { Ca65Settings } from './settings';
import { resolveExport, resolveReference } from './symbolResolver';
import { Macro, Scope, ScopeKind, Symbol, SymbolTable, SymbolTableEntity } from './symbolTable';

function rangesOverlap(a: Range, b: Range): boolean {
    if (a.end.line < b.start.line || b.end.line < a.start.line) return false;
    if (a.end.line === b.start.line && a.end.character < b.start.character) return false;
    if (b.end.line === a.start.line && b.end.character < a.start.character) return false;
    return true;
}

function rangesEqual(a: Range, b: Range): boolean {
    return a.start.line === b.start.line
        && a.start.character === b.start.character
        && a.end.line === b.end.line
        && a.end.character === b.end.character;
}

function isZeroPageEntity(entity: SymbolTableEntity | undefined, explicitZp: boolean = false): boolean {
    if (explicitZp) return true;
    const seg = entity?.segment?.toUpperCase();
    return seg === 'ZEROPAGE' || seg === 'ZP';
}

function deleteLinesRange(document: TextDocument, startLine: number, endLine: number): Range {
    const safeStart = Math.max(0, startLine);
    const safeEnd = Math.min(document.lineCount - 1, endLine);
    if (safeEnd + 1 < document.lineCount) {
        return Range.create(safeStart, 0, safeEnd + 1, 0);
    }
    if (safeStart > 0) {
        const prevLineLen = getLineText(document, safeStart - 1).length;
        const lastLineLen = getLineText(document, safeEnd).length;
        return Range.create(safeStart - 1, prevLineLen, safeEnd, lastLineLen);
    }
    const lastLineLen = getLineText(document, safeEnd).length;
    return Range.create(0, 0, safeEnd, lastLineLen);
}

async function getDocumentForEdit(
    uri: string,
    documents: TextDocuments<TextDocument>,
    cache: Map<string, TextDocument | null>
): Promise<TextDocument | null> {
    if (cache.has(uri)) return cache.get(uri) ?? null;
    const openDoc = documents.get(uri);
    if (openDoc) {
        cache.set(uri, openDoc);
        return openDoc;
    }
    try {
        const content = await fs.readFile(URI.parse(uri).fsPath, 'utf-8');
        const tempDoc = TextDocument.create(uri, 'ca65', 0, content);
        cache.set(uri, tempDoc);
        return tempDoc;
    } catch {
        cache.set(uri, null);
        return null;
    }
}

async function buildUnresolvedSymbolQuickFixes(
    symbolName: string,
    document: TextDocument,
    symbolTable: SymbolTable,
    settings: Ca65Settings,
    associatedDiags: Diagnostic[],
    documents: TextDocuments<TextDocument>,
    docCache: Map<string, TextDocument | null>,
    seenTitles: Set<string>,
    outActions: CodeAction[]
): Promise<void> {
    if (!symbolName || symbolName.startsWith('@') || symbolName.startsWith('<anon')) {
        return;
    }

    const tuUris = new Set(includesGraph.getTranslationUnit(document.uri));
    tuUris.add(document.uri);
    const alreadyImported = symbolTable.imports.some(imp => imp.name === symbolName);
    const importCandidates: CodeAction[] = [];

    // 1. Exported in another workspace file -> `.import` / `.importzp`
    if (!alreadyImported && !settings.implicitImports) {
        const matchingExports = exportsMap.get(symbolName);
        const seenExportUris = new Set<string>();
        for (const exp of matchingExports) {
            if (tuUris.has(exp.uri)) continue;
            const resolved = resolveExport(exp, symbolTables, includesGraph);
            const targetUri = resolved?.uri ?? exp.uri;
            if (seenExportUris.has(targetUri)) continue;
            seenExportUris.add(targetUri);

            const useZp = isZeroPageEntity(resolved, exp.isZeroPage);
            const directive = useZp ? '.importzp' : '.import';
            const relPath = getWorkspaceRelativePath(targetUri);
            const title = `Import '${symbolName}' (${directive}) from ${relPath}`;
            if (seenTitles.has(title)) continue;
            seenTitles.add(title);

            importCandidates.push({
                title,
                kind: CodeActionKind.QuickFix,
                diagnostics: associatedDiags.length > 0 ? associatedDiags : undefined,
                edit: {
                    changes: {
                        [document.uri]: [makeImportEdit(document, symbolName, directive)],
                    },
                },
            });
        }
    }

    // 2. Defined / macro-declared / imported in an auto-includable file -> `.include`
    const includeCandidates: CodeAction[] = [];
    for (const [otherUri, otherTable] of symbolTables) {
        if (tuUris.has(otherUri) || !isAutoIncludable(otherUri, settings)) {
            continue;
        }
        const hasRootSymbol = Boolean(otherTable.getRootScope().findDefinition(symbolName, [], 'symbol'));
        const hasMacro = Boolean(otherTable.getMacro(symbolName));
        const hasImport = otherTable.imports.some(imp => imp.name === symbolName);
        if (!hasRootSymbol && !hasMacro && !hasImport) {
            continue;
        }

        const canonicalPath = findCanonicalIncludePath(document.uri, otherUri, settings.includeDirs);
        const title = `Include "${canonicalPath}" for '${symbolName}'`;
        if (seenTitles.has(title)) continue;
        seenTitles.add(title);

        includeCandidates.push({
            title,
            kind: CodeActionKind.QuickFix,
            diagnostics: associatedDiags.length > 0 ? associatedDiags : undefined,
            edit: {
                changes: {
                    [document.uri]: [makeIncludeEdit(document, canonicalPath)],
                },
            },
        });
    }

    // 3. Defined at root scope in a non-auto-includable workspace file without an `.export`
    const exportAndImportCandidates: CodeAction[] = [];
    if (!alreadyImported && !settings.implicitImports && importCandidates.length === 0) {
        for (const [otherUri, otherTable] of symbolTables) {
            if (tuUris.has(otherUri) || isAutoIncludable(otherUri, settings)) {
                continue;
            }
            const defEntity = otherTable.getRootScope().findDefinition(symbolName, [], 'symbol');
            if (!defEntity || !(defEntity instanceof Symbol || (defEntity instanceof Scope && defEntity.kind === ScopeKind.Proc))) {
                continue;
            }

            const defDoc = await getDocumentForEdit(otherUri, documents, docCache);
            if (!defDoc) continue;

            const useZp = isZeroPageEntity(defEntity);
            const exportDir = useZp ? '.exportzp' : '.export';
            const importDir = useZp ? '.importzp' : '.import';
            const title = `Export '${symbolName}' in ${getWorkspaceRelativePath(otherUri)} and import here`;
            if (seenTitles.has(title)) continue;
            seenTitles.add(title);

            exportAndImportCandidates.push({
                title,
                kind: CodeActionKind.QuickFix,
                diagnostics: associatedDiags.length > 0 ? associatedDiags : undefined,
                edit: {
                    changes: {
                        [otherUri]: [makeExportEdit(defDoc, symbolName, exportDir)],
                        [document.uri]: [makeImportEdit(document, symbolName, importDir)],
                    },
                },
            });
        }
    }

    const totalUnresolvedFixes = importCandidates.length + includeCandidates.length + exportAndImportCandidates.length;
    if (totalUnresolvedFixes === 1 && associatedDiags.length > 0) {
        const only = importCandidates[0] ?? includeCandidates[0] ?? exportAndImportCandidates[0];
        only.isPreferred = true;
    }

    outActions.push(...importCandidates, ...includeCandidates, ...exportAndImportCandidates);
}

function buildRemoveUnusedEntityEdit(document: TextDocument, entity: SymbolTableEntity): TextEdit {
    if (entity instanceof Scope || entity instanceof Macro) {
        return TextEdit.del(deleteLinesRange(document, entity.range.start.line, entity.range.end.line));
    }

    const line = entity.definition.start.line;
    const lineText = getLineText(document, line);
    const commentIdx = findCommentStart(lineText);
    const codePart = commentIdx >= 0 ? lineText.slice(0, commentIdx) : lineText;

    // If a label shares its line with a following instruction/directive (e.g. `foo: lda #0`),
    // remove only `foo:` and trailing spaces before the instruction instead of deleting the whole line.
    const afterName = codePart.slice(entity.definition.end.character);
    const colonMatch = afterName.match(/^\s*:(?![:=<>+-])\s*/);
    if (colonMatch) {
        const afterColonIdx = entity.definition.end.character + colonMatch[0].length;
        const remainingCode = codePart.slice(afterColonIdx).trim();
        if (remainingCode.length > 0) {
            return TextEdit.del(Range.create(line, entity.definition.start.character, line, afterColonIdx));
        }
    }

    return TextEdit.del(deleteLinesRange(document, line, line));
}

function buildUnusedSymbolQuickFixes(
    diag: Diagnostic,
    document: TextDocument,
    symbolTable: SymbolTable,
    seenTitles: Set<string>,
    outActions: CodeAction[]
): void {
    const match = diag.message.match(/^Symbol '(.+?)' is defined but never used\.$/);
    if (!match) return;

    const symName = match[1];
    const entity = symbolTable.getAllDefinedEntities().find(
        e => e.name === symName && (rangesEqual(e.definition, diag.range) || rangesOverlap(e.definition, diag.range))
    );
    if (!entity) return;

    const removeTitle = `Remove unused ${entity instanceof Symbol || entity instanceof Scope || entity instanceof Macro ? entity.kind : 'symbol'} '${entity.name}'`;
    if (!seenTitles.has(removeTitle)) {
        seenTitles.add(removeTitle);
        outActions.push({
            title: removeTitle,
            kind: CodeActionKind.QuickFix,
            diagnostics: [diag],
            edit: {
                changes: {
                    [document.uri]: [buildRemoveUnusedEntityEdit(document, entity)],
                },
            },
        });
    }

    const isRootScope = entity.scope?.name === '';
    const isExportable = entity instanceof Symbol || (entity instanceof Scope && entity.kind === ScopeKind.Proc);
    const alreadyExported = symbolTable.exports.some(exp => exp.name === entity.name);
    if (isRootScope && isExportable && !alreadyExported) {
        const useZp = isZeroPageEntity(entity);
        const directive = useZp ? '.exportzp' : '.export';
        const exportTitle = `Export '${entity.name}' (${directive})`;
        if (!seenTitles.has(exportTitle)) {
            seenTitles.add(exportTitle);
            outActions.push({
                title: exportTitle,
                kind: CodeActionKind.QuickFix,
                diagnostics: [diag],
                edit: {
                    changes: {
                        [document.uri]: [makeExportEdit(document, entity.name, directive)],
                    },
                },
            });
        }
    }
}

interface NumberLiteralHit {
    base: 'hex' | 'bin' | 'dec';
    value: number;
    startChar: number;
    endChar: number;
}

function findNumberLiteralAtPosition(document: TextDocument, pos: Position): NumberLiteralHit | null {
    if (pos.line < 0 || pos.line >= document.lineCount) return null;
    const lineText = getLineText(document, pos.line);
    const commentIdx = findCommentStart(lineText);
    const code = commentIdx >= 0 ? lineText.slice(0, commentIdx) : lineText;
    if (pos.character > code.length) return null;

    let i = 0;
    let quote: '"' | "'" | null = null;
    while (i < code.length) {
        const ch = code[i];
        if (quote) {
            if (ch === quote) quote = null;
            i++;
            continue;
        }
        if (ch === '"' || ch === "'") {
            quote = ch;
            i++;
            continue;
        }

        const prevCh = i > 0 ? code[i - 1] : '';
        const boundaryBefore = !/[a-zA-Z0-9_.$%]/.test(prevCh);

        if (boundaryBefore && ch === '$') {
            const m = code.slice(i + 1).match(/^[0-9a-fA-F_]+/);
            if (m) {
                const end = i + 1 + m[0].length;
                const nextCh = end < code.length ? code[end] : '';
                if (!/[a-zA-Z0-9_]/.test(nextCh) && pos.character >= i && pos.character <= end) {
                    const val = parseInt(m[0].replace(/_/g, ''), 16);
                    if (Number.isSafeInteger(val) && val >= 0 && val <= 0xFFFFFFFF) {
                        return { base: 'hex', value: val, startChar: i, endChar: end };
                    }
                }
                i = end;
                continue;
            }
        } else if (boundaryBefore && ch === '%') {
            const m = code.slice(i + 1).match(/^[01_]+/);
            if (m) {
                const end = i + 1 + m[0].length;
                const nextCh = end < code.length ? code[end] : '';
                if (!/[a-zA-Z0-9_]/.test(nextCh) && pos.character >= i && pos.character <= end) {
                    const val = parseInt(m[0].replace(/_/g, ''), 2);
                    if (Number.isSafeInteger(val) && val >= 0 && val <= 0xFFFFFFFF) {
                        return { base: 'bin', value: val, startChar: i, endChar: end };
                    }
                }
                i = end;
                continue;
            }
        } else if (boundaryBefore && /[0-9]/.test(ch)) {
            const m = code.slice(i).match(/^[0-9]+/);
            if (m) {
                const end = i + m[0].length;
                const nextCh = end < code.length ? code[end] : '';
                if (!/[a-zA-Z0-9_xX]/.test(nextCh) && pos.character >= i && pos.character <= end) {
                    const val = parseInt(m[0], 10);
                    if (Number.isSafeInteger(val) && val >= 0 && val <= 0xFFFFFFFF) {
                        return { base: 'dec', value: val, startChar: i, endChar: end };
                    }
                }
                i = end;
                continue;
            }
        }

        i++;
    }

    return null;
}

function buildNumberConversionActions(
    document: TextDocument,
    paramsRange: Range,
    outActions: CodeAction[]
): void {
    if (paramsRange.start.line !== paramsRange.end.line) return;
    const hit = findNumberLiteralAtPosition(document, paramsRange.start);
    if (!hit) return;

    const line = paramsRange.start.line;
    const tokenRange = Range.create(line, hit.startChar, line, hit.endChar);
    const hexWidth = hit.value <= 0xFF ? 2 : hit.value <= 0xFFFF ? 4 : 8;
    const hexStr = '$' + hit.value.toString(16).toUpperCase().padStart(hexWidth, '0');
    const decStr = hit.value.toString(10);

    if (hit.base !== 'hex') {
        outActions.push({
            title: `Convert to hex (${hexStr})`,
            kind: CodeActionKind.RefactorRewrite,
            edit: { changes: { [document.uri]: [TextEdit.replace(tokenRange, hexStr)] } },
        });
    }
    if (hit.base !== 'dec') {
        outActions.push({
            title: `Convert to decimal (${decStr})`,
            kind: CodeActionKind.RefactorRewrite,
            edit: { changes: { [document.uri]: [TextEdit.replace(tokenRange, decStr)] } },
        });
    }
    if (hit.base !== 'bin' && hit.value <= 0xFFFF) {
        const binWidth = hit.value <= 0xFF ? 8 : 16;
        const binStr = '%' + hit.value.toString(2).padStart(binWidth, '0');
        outActions.push({
            title: `Convert to binary (${binStr})`,
            kind: CodeActionKind.RefactorRewrite,
            edit: { changes: { [document.uri]: [TextEdit.replace(tokenRange, binStr)] } },
        });
    }
}

export function initializeCodeActionProvider(connection: _Connection, documents: TextDocuments<TextDocument>): void {
    connection.onCodeAction(async (params: CodeActionParams): Promise<CodeAction[]> => {
        await initializationGate.isInitialized;

        return performanceMonitor.timeAsync('onCodeAction', async () => {
            const document = documents.get(params.textDocument.uri);
            if (!document) return [];

            const symbolTable = symbolTables.get(document.uri);
            if (!symbolTable) return [];

            const settings = await getDocumentSettings(document.uri);
            const actions: CodeAction[] = [];
            const seenTitles = new Set<string>();
            const docCache = new Map<string, TextDocument | null>();

            const requestedKinds = params.context.only;
            const wantsQuickFix = !requestedKinds || requestedKinds.some(k =>
                k === CodeActionKind.QuickFix || k.startsWith(CodeActionKind.QuickFix + '.')
            );
            const wantsRefactor = !requestedKinds || requestedKinds.some(k =>
                k === CodeActionKind.Refactor || k === CodeActionKind.RefactorRewrite || k.startsWith(CodeActionKind.Refactor + '.')
            );

            if (wantsQuickFix) {
                const unresolvedByName = new Map<string, Diagnostic[]>();

                for (const diag of params.context.diagnostics) {
                    if (diag.source === 'ca65-lsp') {
                        buildUnusedSymbolQuickFixes(diag, document, symbolTable, seenTitles, actions);
                        continue;
                    }

                    if (diag.source === 'ca65') {
                        const symMatch = diag.message.match(/Symbol\s+[‘']([^’']+)[’']/);
                        let symName = symMatch?.[1];
                        if (!symName) {
                            const overlappingRef = symbolTable.getReferencesOnLine(diag.range.start.line).find(
                                ref => rangesOverlap(ref.location, diag.range)
                            );
                            if (overlappingRef && !resolveReference(overlappingRef, symbolTables, includesGraph, settings.implicitImports)) {
                                symName = overlappingRef.name;
                            }
                        }
                        if (symName) {
                            const existing = unresolvedByName.get(symName) ?? [];
                            existing.push(diag);
                            unresolvedByName.set(symName, existing);
                        }
                    }
                }

                // Also offer import/include quick fixes if cursor rests on an unresolved reference
                // before ca65 diagnostics have surfaced.
                const refsOnRange = symbolTable.getReferencesOnLine(params.range.start.line);
                for (const ref of refsOnRange) {
                    if (!rangesOverlap(ref.location, params.range)) continue;
                    if (ref.qualifiers.length > 0) continue;
                    if (!resolveReference(ref, symbolTables, includesGraph, settings.implicitImports)) {
                        if (!unresolvedByName.has(ref.name)) {
                            unresolvedByName.set(ref.name, []);
                        }
                    }
                }

                for (const [symName, diags] of unresolvedByName) {
                    await buildUnresolvedSymbolQuickFixes(
                        symName,
                        document,
                        symbolTable,
                        settings,
                        diags,
                        documents,
                        docCache,
                        seenTitles,
                        actions
                    );
                }
            }

            if (wantsRefactor) {
                buildNumberConversionActions(document, params.range, actions);
            }

            return actions;
        });
    });
}
