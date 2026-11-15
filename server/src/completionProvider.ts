import * as path from 'path';
import * as fs from 'fs/promises';
import {
    _Connection,
    TextDocuments,
    CompletionItem,
    CompletionItemKind,
    InsertTextFormat,
    MarkupKind,
    TextDocumentPositionParams,
    Range,
    TextEdit,
    SymbolKind as LSPSymbolKind,
    Position,
} from 'vscode-languageserver/node';
import { TextDocument } from 'vscode-languageserver-textdocument';
import { ensureDocumentRefreshed, getDocumentSettings, includesGraph, initializationGate, performanceMonitor, symbolTables } from './server';
import { getLineText } from './editUtils';
import { directiveData, getMnemonicInfo, getMnemonicsForCpu, resolveDirectiveAlias } from './dataManager';
import { Export, Import, ImportKind, Macro, MacroKind, Scope, ScopeKind, Symbol, SymbolTable, SymbolTableEntity } from './symbolTable';
import { findCheapLocalLabelDefinition, getCheapLocalLabelDefinitions } from './cheapLocalLabelUtils';
import { IncludesGraph } from './includesGraph';
import { getLSPSymbolKind, resolveExport, resolveImport } from './symbolResolver';
import { findCanonicalIncludePath, getSearchDirectories, getWorkspaceRelativePath, uriToFsPath } from './pathUtils';
import { Ca65Cpu, Ca65Settings, normalizeCpu } from './settings';
import { isAutoIncludable, makeImportEdit, makeIncludeEdit } from './editUtils';
import { getCachedTextDocument } from './documentCache';
import {
    extractLeadingDocInfo,
    formatSourceLink,
    generateDirectiveHoverMarkdown,
    generateMnemonicHoverMarkdown,
    generateSymbolTableEntityMarkdown,
} from './hoverProvider';

const CHEAP_LOCAL_ITEM_PREFIX = 0;
const VISIBLE_ITEM_PREFIX = 1;
const MNEMONIC_ITEM_PREFIX = 2;
const BLOCK_SNIPPET_ITEM_PREFIX = 2;
const DIRECTIVE_ITEM_PREFIX = 3;
const AUTO_INCLUDE_ITEM_PREFIX = 4;
const AUTO_IMPORT_ITEM_PREFIX = 5;
const SNIPPET_FALLBACK_DIRECTIVE_PREFIX = 9;

const BLOCK_DIRECTIVE_SNIPPETS: Record<string, { placeholder: string; endDirective: string; detail: string }> = {
    '.proc': { placeholder: 'name', endDirective: '.endproc', detail: 'Procedure block' },
    '.macro': { placeholder: 'name', endDirective: '.endmacro', detail: 'Macro block' },
    '.scope': { placeholder: 'name', endDirective: '.endscope', detail: 'Scope block' },
    '.struct': { placeholder: 'name', endDirective: '.endstruct', detail: 'Struct block' },
    '.union': { placeholder: 'name', endDirective: '.endunion', detail: 'Union block' },
    '.enum': { placeholder: 'name', endDirective: '.endenum', detail: 'Enum block' },
    '.repeat': { placeholder: 'count', endDirective: '.endrepeat', detail: 'Repeat block' },
    '.if': { placeholder: 'condition', endDirective: '.endif', detail: 'Conditional block' },
    '.ifdef': { placeholder: 'symbol', endDirective: '.endif', detail: 'Conditional block (if defined)' },
    '.ifndef': { placeholder: 'symbol', endDirective: '.endif', detail: 'Conditional block (if not defined)' },
    '.ifblank': { placeholder: 'tokens', endDirective: '.endif', detail: 'Conditional block (if blank)' },
    '.ifnblank': { placeholder: 'tokens', endDirective: '.endif', detail: 'Conditional block (if not blank)' },
    '.ifref': { placeholder: 'symbol', endDirective: '.endif', detail: 'Conditional block (if referenced)' },
    '.ifnref': { placeholder: 'symbol', endDirective: '.endif', detail: 'Conditional block (if not referenced)' },
    '.ifconst': { placeholder: 'expression', endDirective: '.endif', detail: 'Conditional block (if constant)' },
};

const DECLARATION_HEADER_DIRECTIVES = new Set([
    '.proc', '.macro', '.mac', '.scope', '.struct', '.union', '.enum',
]);

const ZERO_ARG_DIRECTIVES = new Set([
    '.endproc', '.endmacro', '.endmac', '.endscope', '.endstruct', '.endunion',
    '.endenum', '.endrepeat', '.endrep', '.endif', '.else',
    '.code', '.data', '.bss', '.zeropage', '.rodata', '.reloc', '.pushseg', '.popseg',
]);

const NUMERIC_LITERAL_AT_CURSOR_RE = /(?:^|[^a-zA-Z0-9_.@])(?:\$[0-9a-fA-F]*|%[01]*|[0-9]+)$/;
const SINGLE_TRAILING_COLON_RE = /(?:^|[^:]):$/;

function hasUnclosedPriorBlockComment(document: TextDocument, line: number): boolean {
    const startLine = Math.max(0, line - 200);
    for (let l = line - 1; l >= startLine; l--) {
        const text = getLineText(document, l);
        const closeIdx = text.lastIndexOf('*/');
        const openIdx = text.lastIndexOf('/*');
        if (openIdx !== -1 || closeIdx !== -1) {
            return openIdx > closeIdx;
        }
    }
    return false;
}

function isInCommentOrString(document: TextDocument, position: Position, lineToCursor: string): boolean {
    let inBlockComment = hasUnclosedPriorBlockComment(document, position.line);
    let quote = 0;

    for (let i = 0; i < lineToCursor.length; i++) {
        const ch = lineToCursor.charCodeAt(i);
        if (inBlockComment) {
            if (ch === 42 /* * */ && i + 1 < lineToCursor.length && lineToCursor.charCodeAt(i + 1) === 47 /* / */) {
                inBlockComment = false;
                i++;
            }
            continue;
        }
        if (quote !== 0) {
            if (ch === 92 /* \ */) {
                i++;
            } else if (ch === quote) {
                quote = 0;
            }
            continue;
        }
        if (ch === 59 /* ; */) {
            return true;
        }
        if (ch === 47 /* / */ && i + 1 < lineToCursor.length && lineToCursor.charCodeAt(i + 1) === 42 /* * */) {
            inBlockComment = true;
            i++;
            continue;
        }
        if (ch === 34 /* " */ || ch === 39 /* ' */) {
            quote = ch;
        }
    }

    return inBlockComment || quote !== 0;
}

function isInsideDefineHeader(afterDefine: string): boolean {
    const rest = afterDefine.trimStart();
    if (!rest) return true;

    let parenDepth = 0;
    for (let i = 0; i < rest.length; i++) {
        const ch = rest.charCodeAt(i);
        if (ch === 40 /* ( */) {
            parenDepth++;
        } else if (ch === 41 /* ) */ && parenDepth > 0) {
            parenDepth--;
        } else if ((ch === 32 || ch === 9) && parenDepth === 0) {
            return false;
        }
    }
    return true;
}

function isImpliedOnlyMnemonic(cmdToken: string, cpu?: Ca65Cpu): boolean {
    const info = getMnemonicInfo(cmdToken, cpu);
    if (!info || !info.modes) return false;
    const modes = Object.keys(info.modes);
    return modes.length === 1 && (modes[0] === 'Implied' || modes[0] === 'Accumulator');
}

function getCompletionItemKind(kind: LSPSymbolKind): CompletionItemKind {
    switch (kind) {
        case LSPSymbolKind.File:
            return CompletionItemKind.File;
        case LSPSymbolKind.Module:
            return CompletionItemKind.Module;
        case LSPSymbolKind.Namespace:
        case LSPSymbolKind.Package:
        case LSPSymbolKind.Class:
            return CompletionItemKind.Class;
        case LSPSymbolKind.Method:
            return CompletionItemKind.Method;
        case LSPSymbolKind.Property:
            return CompletionItemKind.Property;
        case LSPSymbolKind.Field:
            return CompletionItemKind.Field;
        case LSPSymbolKind.Constructor:
            return CompletionItemKind.Constructor;
        case LSPSymbolKind.Enum:
            return CompletionItemKind.Enum;
        case LSPSymbolKind.Interface:
            return CompletionItemKind.Interface;
        case LSPSymbolKind.Function:
            return CompletionItemKind.Function;
        case LSPSymbolKind.Variable:
            return CompletionItemKind.Variable;
        case LSPSymbolKind.Constant:
            return CompletionItemKind.Constant;
        case LSPSymbolKind.String:
            return CompletionItemKind.Text;  // no direct mapping, fallback to Text
        case LSPSymbolKind.Number:
        case LSPSymbolKind.Boolean:
            return CompletionItemKind.Value; // no direct mapping, fallback
        case LSPSymbolKind.Array:
        case LSPSymbolKind.Object:
            return CompletionItemKind.Field;
        case LSPSymbolKind.Key:
            return CompletionItemKind.Text;
        case LSPSymbolKind.Null:
            return CompletionItemKind.Value;
        case LSPSymbolKind.EnumMember:
            return CompletionItemKind.EnumMember;
        case LSPSymbolKind.Struct:
            return CompletionItemKind.Struct;
        case LSPSymbolKind.Event:
            return CompletionItemKind.Event;
        case LSPSymbolKind.Operator:
            return CompletionItemKind.Operator;
        case LSPSymbolKind.TypeParameter:
            return CompletionItemKind.TypeParameter;
        default:
            return CompletionItemKind.Text; // fallback for unknown kinds
    }
}

function getCompletionItemDetail(entity: SymbolTableEntity): string | undefined {
    if (entity instanceof Macro) {
        if (entity.kind === MacroKind.Define) {
            return entity.params.length > 0 ? `.define (${entity.params.join(', ')})` : entity.kind;
        }
        return entity.params.length > 0 ? `.macro ${entity.params.join(', ')}` : entity.kind;
    }
    if (
        entity instanceof Symbol
        || entity instanceof Scope
        || entity instanceof Import
        || entity instanceof Export
    ) {
        if (entity.segment && entity.segment !== 'CODE') {
            return `${entity.kind} · ${entity.segment}`;
        }
        return entity.kind;
    }

    return undefined;
}

interface StaticCompletionTemplates {
    mnemonics: Omit<CompletionItem, 'textEdit'>[];
    controlDirectives: Omit<CompletionItem, 'textEdit'>[];
    operandDirectives: Omit<CompletionItem, 'textEdit'>[];
}

const cachedMnemonicTemplatesByCpu = new Map<Ca65Cpu, Omit<CompletionItem, 'textEdit'>[]>();
let cachedDirectiveTemplates: {
    controlDirectives: Omit<CompletionItem, 'textEdit'>[];
    operandDirectives: Omit<CompletionItem, 'textEdit'>[];
} | null = null;

function getStaticTemplates(cpu?: Ca65Cpu): StaticCompletionTemplates {
    const normalizedCpu = normalizeCpu(cpu);
    let mnemonics = cachedMnemonicTemplatesByCpu.get(normalizedCpu);
    if (!mnemonics) {
        mnemonics = [];
        const cpuMnemonics = getMnemonicsForCpu(normalizedCpu);
        for (const key in cpuMnemonics) {
            const lowerCaseKey = key.toLowerCase();
            mnemonics.push({
                label: lowerCaseKey,
                kind: CompletionItemKind.Keyword,
                detail: 'Mnemonic',
                sortText: MNEMONIC_ITEM_PREFIX + lowerCaseKey,
                data: { staticKind: 'mnemonic', key, cpu: normalizedCpu },
            });
        }
        cachedMnemonicTemplatesByCpu.set(normalizedCpu, mnemonics);
    }

    if (!cachedDirectiveTemplates) {
        const controlDirectives: Omit<CompletionItem, 'textEdit'>[] = [];
        const operandDirectives: Omit<CompletionItem, 'textEdit'>[] = [];
        for (const key in directiveData) {
            const directive = resolveDirectiveAlias(key);
            if (!directive) continue;

            const directiveName = `.${key.toLowerCase()}`;
            if (directive.type === 'Control command') {
                const snippetDef = BLOCK_DIRECTIVE_SNIPPETS[directiveName];
                if (snippetDef) {
                    controlDirectives.push({
                        label: directiveName,
                        kind: CompletionItemKind.Snippet,
                        detail: snippetDef.detail,
                        insertTextFormat: InsertTextFormat.Snippet,
                        insertText: `${directiveName} \${1:${snippetDef.placeholder}}\n\t$0\n${snippetDef.endDirective}`,
                        sortText: BLOCK_SNIPPET_ITEM_PREFIX + directiveName,
                        data: { staticKind: 'directive', key },
                    });
                }
                controlDirectives.push({
                    label: directiveName,
                    kind: CompletionItemKind.Keyword,
                    detail: 'Control Command',
                    sortText: (snippetDef ? SNIPPET_FALLBACK_DIRECTIVE_PREFIX : DIRECTIVE_ITEM_PREFIX) + directiveName,
                    data: { staticKind: 'directive', key },
                });
            } else if (directive.type === 'Pseudo-function' || directive.type === 'Pseudo-variable') {
                operandDirectives.push({
                    label: directiveName,
                    kind: directive.type === 'Pseudo-function' ? CompletionItemKind.Function : CompletionItemKind.Variable,
                    detail: directive.type,
                    sortText: DIRECTIVE_ITEM_PREFIX + directiveName,
                    data: { staticKind: 'directive', key },
                });
            }
        }
        cachedDirectiveTemplates = { controlDirectives, operandDirectives };
    }

    return {
        mnemonics,
        controlDirectives: cachedDirectiveTemplates.controlDirectives,
        operandDirectives: cachedDirectiveTemplates.operandDirectives,
    };
}

function getCheapLocalLabelCompletions(
    document: TextDocument,
    position: Position,
    replacementRange: Range,
    currentWord: string
): CompletionItem[] {
    return getCheapLocalLabelDefinitions(document, position).map(labelName => {
        const defLoc = findCheapLocalLabelDefinition(document, position, labelName);
        const item: CompletionItem = {
            label: labelName,
            kind: CompletionItemKind.Reference,
            detail: 'cheap_local_label',
            textEdit: TextEdit.replace(replacementRange, labelName),
            sortText: CHEAP_LOCAL_ITEM_PREFIX + labelName.slice(1),
            data: defLoc ? {
                uri: document.uri,
                targetUri: defLoc.uri,
                targetLine: defLoc.range.start.line,
                targetName: labelName,
            } : undefined,
        };
        if (!currentWord.startsWith('@')) {
            item.filterText = labelName.substring(1);
        }
        return item;
    });
}

interface TargetResolveRef {
    uri: string;
    targetUri: string;
    targetLine: number;
    targetName: string;
}

interface CachedMacroCompletionMeta {
    entity: Macro;
    label: string;
    kind: CompletionItemKind;
    detail: string | undefined;
    sortText: string;
}

interface CachedValueEntityMeta {
    entity: SymbolTableEntity;
    fqn: string;
    kind: CompletionItemKind;
    detail: string | undefined;
}

interface CachedTableCompletionMeta {
    macroCommands: CachedMacroCompletionMeta[];
    valueEntities: CachedValueEntityMeta[];
}

const tableCompletionCache = new WeakMap<SymbolTable, CachedTableCompletionMeta>();

function makeTargetData(documentUri: string, entity: SymbolTableEntity): TargetResolveRef {
    return {
        uri: documentUri,
        targetUri: entity.uri,
        targetLine: entity.definition.start.line,
        targetName: entity.name,
    };
}

function getTableCompletionMeta(symbolTable: SymbolTable): CachedTableCompletionMeta {
    let cached = tableCompletionCache.get(symbolTable);
    if (cached) {
        return cached;
    }

    const macroCommands: CachedMacroCompletionMeta[] = [];
    for (const macro of symbolTable.getAllMacros()) {
        if (macro.kind === MacroKind.Macro) {
            macroCommands.push({
                entity: macro,
                label: macro.name,
                kind: getCompletionItemKind(getLSPSymbolKind(macro)),
                detail: getCompletionItemDetail(macro),
                sortText: VISIBLE_ITEM_PREFIX + macro.name,
            });
        }
    }

    const valueEntities: CachedValueEntityMeta[] = [];
    for (const entity of symbolTable.getAllDefinedEntities()) {
        if (isValueCompletionEntity(entity)) {
            valueEntities.push({
                entity,
                fqn: entity.getFullyQualifiedName(),
                kind: getCompletionItemKind(getLSPSymbolKind(entity)),
                detail: getCompletionItemDetail(entity),
            });
        }
    }

    cached = { macroCommands, valueEntities };
    tableCompletionCache.set(symbolTable, cached);
    return cached;
}

function appendStaticTemplates(
    target: CompletionItem[],
    templates: readonly Omit<CompletionItem, 'textEdit'>[],
    replacementRange: Range
): void {
    for (let i = 0; i < templates.length; i++) {
        const t = templates[i];
        target.push({
            label: t.label,
            kind: t.kind,
            detail: t.detail,
            insertTextFormat: t.insertTextFormat,
            sortText: t.sortText,
            data: t.data,
            textEdit: TextEdit.replace(replacementRange, t.insertText ?? t.label),
        });
    }
}

export function initializeCompletionProvider(connection: _Connection, documents: TextDocuments<TextDocument>) {
    connection.onCompletion(async (params: TextDocumentPositionParams): Promise<CompletionItem[]> => {
        await initializationGate.isInitialized;
        await ensureDocumentRefreshed?.(params.textDocument.uri);

        return performanceMonitor.timeAsync("onCompletion", async () => {
            const document = documents.get(params.textDocument.uri);
            if (!document) {
                return [];
            }
            const settings = await getDocumentSettings(document.uri);
            const position = params.position;

            const lineToCursor = document.getText({ start: { line: params.position.line, character: 0 }, end: params.position });

            // --- INCLUDE / INCBIN FILE PATH CONTEXT ---
            const includePathMatch = lineToCursor.match(/^\s*\.(include|incbin)\s+"([^"]*)$/i);
            if (includePathMatch) {
                const isIncbin = includePathMatch[1].toLowerCase() === 'incbin';
                const partialPath = includePathMatch[2];
                return getIncludePathCompletions(document.uri, position, partialPath, isIncbin, settings);
            }

            if (isInCommentOrString(document, position, lineToCursor)) {
                return [];
            }

            const anonLabelRefRegex = /:[-+<>]+$/;
            if (anonLabelRefRegex.test(lineToCursor)) {
                // Suppress nuisance completion while typing anonymous label references
                return [];
            }

            if (NUMERIC_LITERAL_AT_CURSOR_RE.test(lineToCursor) || SINGLE_TRAILING_COLON_RE.test(lineToCursor)) {
                return [];
            }

            const wordMatch = lineToCursor.match(/[a-zA-Z0-9_.:@]*$/);
            const currentWord = wordMatch ? wordMatch[0] : '';

            // --- SCOPE-QUALIFIED CONTEXT (`Scope::...` or `::...`) ---
            const lastDoubleColonIdx = currentWord.lastIndexOf('::');
            if (lastDoubleColonIdx >= 0) {
                const afterColon = currentWord.slice(lastDoubleColonIdx + 2);
                const memberRange = Range.create(
                    params.position.line,
                    params.position.character - afterColon.length,
                    params.position.line,
                    params.position.character
                );
                return getScopeQualifiedCompletions(
                    document,
                    position,
                    currentWord.slice(0, lastDoubleColonIdx),
                    memberRange,
                    symbolTables,
                    includesGraph
                );
            }

            const replacementRange = Range.create(
                params.position.line,
                params.position.character - currentWord.length,
                params.position.line,
                params.position.character
            );

            // --- CONTEXT DETERMINATION ---
            const prefixMatch = lineToCursor.match(/^\s*(?:(?:[a-zA-Z_@.][a-zA-Z0-9_@.]*)?:(?![:=<>+-])\s*)?/);
            const prefixLen = prefixMatch ? prefixMatch[0].length : 0;
            const afterPrefix = lineToCursor.slice(prefixLen);
            const firstWsIdx = afterPrefix.search(/\s/);
            const isCommandContext = firstWsIdx === -1;

            const templates = getStaticTemplates(settings.cpu);

            if (isCommandContext) {
                // --- COMMAND CONTEXT: Suggest mnemonics, control commands, and macros ---
                const completionItems: CompletionItem[] = [];
                appendStaticTemplates(completionItems, templates.mnemonics, replacementRange);
                appendStaticTemplates(completionItems, templates.controlDirectives, replacementRange);
                const macroItems = await getCompletionMacros(document, symbolTables, settings);
                for (let i = 0; i < macroItems.length; i++) {
                    completionItems.push(macroItems[i]);
                }
                return completionItems;
            } else {
                const cmdToken = afterPrefix.slice(0, firstWsIdx);
                const cmdLower = cmdToken.toLowerCase();
                if (
                    DECLARATION_HEADER_DIRECTIVES.has(cmdLower)
                    || ZERO_ARG_DIRECTIVES.has(cmdLower)
                    || (cmdLower === '.define' && isInsideDefineHeader(afterPrefix.slice(firstWsIdx)))
                    || isImpliedOnlyMnemonic(cmdToken, settings.cpu)
                ) {
                    return [];
                }

                // --- OPERAND CONTEXT: Suggest labels, constants, variables, and pseudo-functions/variables ---
                const isSymbolDirective =
                    cmdLower === '.import'
                    || cmdLower === '.importzp'
                    || cmdLower === '.export'
                    || cmdLower === '.exportzp'
                    || cmdLower === '.global'
                    || cmdLower === '.globalzp';
                const completionItems: CompletionItem[] = await getCompletionSymbols(
                    document,
                    position,
                    symbolTables,
                    includesGraph,
                    settings,
                    cmdLower
                );
                if (!isSymbolDirective) {
                    const cheapLocalItems = getCheapLocalLabelCompletions(document, params.position, replacementRange, currentWord);
                    for (let i = 0; i < cheapLocalItems.length; i++) {
                        completionItems.push(cheapLocalItems[i]);
                    }
                    appendStaticTemplates(completionItems, templates.operandDirectives, replacementRange);
                }
                return completionItems;
            }
        });
    });

    connection.onCompletionResolve(
        async (item: CompletionItem): Promise<CompletionItem> => {
            const data = item.data;
            if (!data) {
                return item;
            }

            if (data.staticKind === 'mnemonic' && data.key) {
                const cpu = normalizeCpu(data.cpu);
                const info = getMnemonicInfo(data.key, cpu);
                if (info) {
                    item.documentation = {
                        kind: MarkupKind.Markdown,
                        value: generateMnemonicHoverMarkdown(data.key, info, cpu),
                    };
                }
                return item;
            }

            if (data.staticKind === 'directive' && data.key) {
                const info = resolveDirectiveAlias(data.key);
                if (info) {
                    item.documentation = {
                        kind: MarkupKind.Markdown,
                        value: generateDirectiveHoverMarkdown(`.${data.key}`, info),
                    };
                }
                return item;
            }

            const sourceDoc = data.uri ? documents.get(data.uri) : undefined;
            if (sourceDoc) {
                if (data.editAction === 'include' && data.includePath) {
                    item.additionalTextEdits = [makeIncludeEdit(sourceDoc, data.includePath)];
                } else if (data.editAction === 'import' && data.importSymbol) {
                    item.additionalTextEdits = [makeImportEdit(sourceDoc, data.importSymbol)];
                }
            }

            if (data.targetUri && typeof data.targetLine === 'number') {
                const targetDoc = await getCachedTextDocument(data.targetUri, documents);
                if (targetDoc) {
                    const settingsUri = data.uri || data.targetUri;
                    const settings = await getDocumentSettings(settingsUri);
                    const targetTable = symbolTables.get(data.targetUri);
                    const targetEntity = findResolvedEntity(targetTable, data.targetLine, data.targetName);
                    if (targetEntity) {
                        item.documentation = {
                            kind: MarkupKind.Markdown,
                            value: generateSymbolTableEntityMarkdown(targetEntity, targetDoc, settings.implicitImports),
                        };
                    } else {
                        const { docCommentBlock } = extractLeadingDocInfo(targetDoc, data.targetLine);
                        const parts = [`\`\`\`ca65\n${data.targetName || ''}\n\`\`\``];
                        if (docCommentBlock) {
                            parts.push(`\`\`\`ca65\n${docCommentBlock}\n\`\`\``);
                        }
                        parts.push(`Defined in ${formatSourceLink(data.targetUri, data.targetLine + 1)}`);
                        item.documentation = {
                            kind: MarkupKind.Markdown,
                            value: parts.join('\n\n'),
                        };
                    }
                }
            }

            return item;
        }
    );
}

function findResolvedEntity(
    symbolTable: SymbolTable | undefined,
    targetLine: number,
    targetName?: string
): SymbolTableEntity | undefined {
    if (!symbolTable) return undefined;
    for (const entity of symbolTable.getAllDefinedEntities()) {
        if (entity.definition.start.line === targetLine && (!targetName || entity.name === targetName)) {
            return entity;
        }
    }
    return undefined;
}

async function getIncludePathCompletions(
    currentFileUri: string,
    position: Position,
    partialPath: string,
    isIncbin: boolean,
    settings: Ca65Settings
): Promise<CompletionItem[]> {
    const slashIdx = partialPath.lastIndexOf('/');
    const subDirPrefix = slashIdx >= 0 ? partialPath.slice(0, slashIdx + 1) : '';
    const replaceRange = Range.create(
        position.line,
        position.character - (partialPath.length - (slashIdx + 1)),
        position.line,
        position.character
    );

    const currentFileFsPath = uriToFsPath(currentFileUri);
    const dirs = getSearchDirectories(
        currentFileUri,
        isIncbin ? settings.binIncludeDirs : settings.includeDirs
    );
    const items: CompletionItem[] = [];
    const seenNames = new Set<string>();
    const includeSourceExts = new Set(['.inc', '.s', '.asm', '.h', '.mac', '.ca65']);

    for (const baseDir of dirs) {
        const searchDir = subDirPrefix ? path.resolve(baseDir, subDirPrefix) : baseDir;
        let entries;
        try {
            entries = await fs.readdir(searchDir, { withFileTypes: true });
        } catch {
            continue;
        }

        for (const entry of entries) {
            if (entry.name.startsWith('.') || entry.name === 'node_modules') {
                continue;
            }
            const isDir = entry.isDirectory();
            if (!isDir && !entry.isFile()) continue;
            // Do not suggest the current file including itself
            if (!isDir && path.resolve(searchDir, entry.name) === currentFileFsPath) {
                continue;
            }

            const insertLabel = isDir ? `${entry.name}/` : entry.name;
            if (seenNames.has(insertLabel)) continue;
            seenNames.add(insertLabel);

            const ext = path.extname(entry.name).toLowerCase();
            let sortGroup = '2';
            if (isDir) {
                sortGroup = '0';
            } else if (!isIncbin && includeSourceExts.has(ext)) {
                sortGroup = '1';
            }

            items.push({
                label: insertLabel,
                kind: isDir ? CompletionItemKind.Folder : CompletionItemKind.File,
                detail: isDir ? 'Folder' : (isIncbin ? 'Binary file' : 'Include file'),
                sortText: sortGroup + insertLabel.toLowerCase(),
                textEdit: TextEdit.replace(replaceRange, insertLabel),
            });
        }
    }

    return items;
}

function resolveScopesForQualifier(
    currentScope: Scope | undefined,
    rawQualifier: string,
    visibleUriSet: ReadonlySet<string>,
    allSymbolTables: Map<string, SymbolTable>
): { scopes: Scope[]; isGlobalRoot: boolean } {
    if (rawQualifier === '') {
        // Bare `::` -> root scopes across translation unit
        const roots: Scope[] = [];
        for (const depUri of visibleUriSet) {
            const st = allSymbolTables.get(depUri);
            if (st) roots.push(st.getRootScope());
        }
        return { scopes: roots, isGlobalRoot: true };
    }

    const isGlobal = rawQualifier.startsWith('::');
    const segments = (isGlobal ? rawQualifier.slice(2) : rawQualifier).split('::').filter(Boolean);
    if (segments.length === 0) {
        return { scopes: [], isGlobalRoot: false };
    }

    const matched = new Set<Scope>();

    const descendFrom = (startScope: Scope): Scope | undefined => {
        let cur: Scope | undefined = startScope;
        for (const seg of segments) {
            cur = cur.getChildScope(seg);
            if (!cur) return undefined;
        }
        return cur;
    };

    if (!isGlobal && currentScope) {
        let walk: Scope | null = currentScope;
        while (walk) {
            const hit = descendFrom(walk);
            if (hit) {
                matched.add(hit);
            }
            walk = walk.scope;
        }
    }

    for (const depUri of visibleUriSet) {
        const st = allSymbolTables.get(depUri);
        if (!st) continue;
        const hit = descendFrom(st.getRootScope());
        if (hit) {
            matched.add(hit);
        }
    }

    return { scopes: Array.from(matched), isGlobalRoot: false };
}

function getScopeQualifiedCompletions(
    document: TextDocument,
    position: Position,
    rawQualifier: string,
    replacementRange: Range,
    allSymbolTables: Map<string, SymbolTable>,
    graph: IncludesGraph
): CompletionItem[] {
    const symbolTable = allSymbolTables.get(document.uri);
    if (!symbolTable) return [];

    const currentScope = symbolTable.getScopeAtPosition(position);
    const visibleUriSet = getVisibleTranslationUnitSet(document.uri, graph);
    const { scopes, isGlobalRoot } = resolveScopesForQualifier(
        currentScope,
        rawQualifier,
        visibleUriSet,
        allSymbolTables
    );

    const items: CompletionItem[] = [];
    const seenKeys = new Set<string>();

    const pushEntity = (entity: SymbolTableEntity, overrideKind?: CompletionItemKind, overrideDetail?: string) => {
        const key = `${entity.name}\0${entity.uri}\0${entity.definition.start.line}`;
        if (seenKeys.has(key)) return;
        seenKeys.add(key);

        items.push({
            label: entity.name,
            kind: overrideKind ?? getCompletionItemKind(getLSPSymbolKind(entity)),
            detail: overrideDetail ?? getCompletionItemDetail(entity),
            sortText: VISIBLE_ITEM_PREFIX + entity.name,
            textEdit: TextEdit.replace(replacementRange, entity.name),
            data: makeTargetData(document.uri, entity),
        });
    };

    for (const scope of scopes) {
        for (const sym of scope.getSymbols()) {
            pushEntity(sym);
        }
        for (const childScope of scope.getOrderedChildScopes()) {
            if (!childScope.name) continue;
            pushEntity(childScope);
        }
        for (const imp of scope.getImports()) {
            const resolved = resolveImport(imp.name, allSymbolTables, graph);
            if (resolved) {
                if (imp.kind === ImportKind.Global && visibleUriSet.has(resolved.uri)) {
                    continue;
                }
                pushEntity(
                    resolved,
                    getCompletionItemKind(getLSPSymbolKind(resolved)),
                    getCompletionItemDetail(resolved)
                );
            } else {
                pushEntity(imp);
            }
        }
    }

    if (isGlobalRoot) {
        for (const depUri of visibleUriSet) {
            const st = allSymbolTables.get(depUri);
            if (!st) continue;
            for (const macro of st.getAllMacros()) {
                if (macro.kind === MacroKind.Define) {
                    pushEntity(macro);
                }
            }
        }
    }

    return items;
}

function getVisibleTranslationUnitSet(uri: string, graph: IncludesGraph): ReadonlySet<string> {
    const tuSet = graph.getTranslationUnitSet(uri);
    if (tuSet.size > 0) return tuSet;
    return new Set([uri]);
}

function isValueCompletionEntity(entity: SymbolTableEntity): boolean {
    return (entity instanceof Macro && entity.kind === MacroKind.Define)
        || entity instanceof Symbol
        || (entity instanceof Scope && entity.kind === ScopeKind.Proc);
}

function makeAutoIncludeCompletionItem(
    documentUri: string,
    label: string,
    kind: CompletionItemKind,
    detail: string | undefined,
    includePath: string,
    targetEntity: SymbolTableEntity
): CompletionItem {
    return {
        label,
        kind,
        detail,
        labelDetails: {
            description: `include ${includePath}`
        },
        sortText: AUTO_INCLUDE_ITEM_PREFIX + label,
        data: {
            uri: documentUri,
            editAction: 'include',
            includePath,
            targetUri: targetEntity.uri,
            targetLine: targetEntity.definition.start.line,
            targetName: targetEntity.name,
        }
    };
}

async function getCompletionMacros(
    document: TextDocument,
    allSymbolTables: Map<string, SymbolTable>,
    settings: Ca65Settings
): Promise<CompletionItem[]> {
    const completionItems: CompletionItem[] = [];
    const seenUris = getVisibleTranslationUnitSet(document.uri, includesGraph);

    for (const dep of seenUris) {
        const symbolTable = allSymbolTables.get(dep);
        if (!symbolTable) continue;

        const { macroCommands } = getTableCompletionMeta(symbolTable);
        for (let i = 0; i < macroCommands.length; i++) {
            const m = macroCommands[i];
            completionItems.push({
                label: m.label,
                kind: m.kind,
                detail: m.detail,
                sortText: m.sortText,
                data: makeTargetData(document.uri, m.entity),
            });
        }
    }

    // Find macros in files we can auto-include.
    for (const [otherUri, symbolTable] of allSymbolTables) {
        if (seenUris.has(otherUri)) continue;
        if (!isAutoIncludable(otherUri, settings)) continue;

        const { macroCommands } = getTableCompletionMeta(symbolTable);
        if (macroCommands.length === 0) continue;

        const canonicalPath = findCanonicalIncludePath(document.uri, otherUri, settings.includeDirs);
        const autoSortPrefix = AUTO_INCLUDE_ITEM_PREFIX;
        for (let i = 0; i < macroCommands.length; i++) {
            const m = macroCommands[i];
            completionItems.push({
                label: m.label,
                kind: m.kind,
                detail: m.detail,
                labelDetails: {
                    description: `include ${canonicalPath}`
                },
                sortText: autoSortPrefix + m.label,
                data: {
                    uri: document.uri,
                    editAction: 'include',
                    includePath: canonicalPath,
                    targetUri: m.entity.uri,
                    targetLine: m.entity.definition.start.line,
                    targetName: m.entity.name,
                }
            });
        }
    }

    return completionItems;
}

async function getCompletionSymbols(
    document: TextDocument,
    position: Position,
    allSymbolTables: Map<string, SymbolTable>,
    includesGraph: IncludesGraph,
    settings: Ca65Settings,
    cmdLower?: string
): Promise<CompletionItem[]> {
    const symbolTable = allSymbolTables.get(document.uri);
    if (!symbolTable) return [];

    const currentScope = symbolTable.getScopeAtPosition(position);
    if (!currentScope) return [];

    const isImportDir = cmdLower === '.import' || cmdLower === '.importzp';
    const isExportDir = cmdLower === '.export' || cmdLower === '.exportzp';
    const isGlobalDir = cmdLower === '.global' || cmdLower === '.globalzp';

    const completionItems: CompletionItem[] = [];

    // Gather all locally visible symbols across the current translation unit
    const visibleUriSet = getVisibleTranslationUnitSet(document.uri, includesGraph);
    const seenImports: Set<string> = new Set();
    const visibleFqns: Set<string> = new Set();
    if (!isImportDir) {
        for (const depUri of visibleUriSet) {
            const depSymbolTable = allSymbolTables.get(depUri);
            if (!depSymbolTable) continue;

            const { valueEntities } = getTableCompletionMeta(depSymbolTable);
            for (let i = 0; i < valueEntities.length; i++) {
                const entry = valueEntities[i];
                visibleFqns.add(entry.fqn);
                const label = currentScope.findRelativeName(entry.entity);

                completionItems.push({
                    label,
                    kind: entry.kind,
                    detail: entry.detail,
                    sortText: VISIBLE_ITEM_PREFIX + label,
                    data: makeTargetData(document.uri, entry.entity),
                });
            }

            if (isExportDir) {
                for (const importEntity of depSymbolTable.imports) {
                    seenImports.add(importEntity.name);
                }
                continue;
            }

            for (const importEntity of depSymbolTable.imports) {
                seenImports.add(importEntity.name);
                visibleFqns.add(importEntity.getFullyQualifiedName());

                const label = currentScope.findRelativeName(importEntity);
                let kind = getCompletionItemKind(getLSPSymbolKind(importEntity));
                let detail = getCompletionItemDetail(importEntity);
                let targetEntity: SymbolTableEntity = importEntity;

                // Try to resolve it to a definition we can use for the details. Otherwise, treat
                // it as an opaque import, which may be the case if it is a header for a library
                // file.
                const resolvedImport =
                    resolveImport(importEntity.name, allSymbolTables, includesGraph);
                if (resolvedImport) {
                    // This may be a global that is acting as an export, which we should ignore.
                    if (
                        importEntity.kind === ImportKind.Global
                        && includesGraph.getTranslationUnitSet(importEntity.uri).has(resolvedImport.uri)
                    ) {
                        continue;
                    }

                    if (visibleUriSet.has(resolvedImport.uri)) continue;
                    kind = getCompletionItemKind(getLSPSymbolKind(resolvedImport));
                    detail = getCompletionItemDetail(resolvedImport);
                    targetEntity = resolvedImport;
                }

                completionItems.push({
                    label,
                    kind,
                    detail,
                    sortText: VISIBLE_ITEM_PREFIX + label,
                    data: makeTargetData(document.uri, targetEntity),
                });
            }
        }
    } else {
        for (const imp of symbolTable.imports) {
            seenImports.add(imp.name);
        }
    }

    if (isExportDir) {
        return completionItems;
    }

    // Search the workspace for symbols that we can auto-include or import
    for (const [uri, otherSymbolTable] of allSymbolTables) {
        if (visibleUriSet.has(uri)) continue;

        if (!isImportDir && !isGlobalDir && isAutoIncludable(uri, settings)) {
            let canonicalPath: string | undefined;
            const getCanonicalPath = () => {
                if (!canonicalPath) {
                    canonicalPath = findCanonicalIncludePath(document.uri, uri, settings.includeDirs);
                }
                return canonicalPath;
            };

            // Suggest including .inc files that define a symbol
            const { valueEntities } = getTableCompletionMeta(otherSymbolTable);
            for (let i = 0; i < valueEntities.length; i++) {
                const entry = valueEntities[i];
                if (visibleFqns.has(entry.fqn)) continue;
                completionItems.push(makeAutoIncludeCompletionItem(
                    document.uri,
                    currentScope.findRelativeName(entry.entity),
                    entry.kind,
                    entry.detail,
                    getCanonicalPath(),
                    entry.entity
                ));
            }

            // Suggest including files that import symbols (i.e. headers)
            for (const importEntity of otherSymbolTable.imports) {
                if (visibleFqns.has(importEntity.getFullyQualifiedName())) continue;

                const label = currentScope.findRelativeName(importEntity);
                let kind = getCompletionItemKind(getLSPSymbolKind(importEntity));
                let detail = getCompletionItemDetail(importEntity);
                let targetEntity: SymbolTableEntity = importEntity;

                // Try to resolve it to a definition we can use for the details. Otherwise, treat
                // it as an opaque import, which may be the case if it is a header for a library
                // file.
                const resolvedExport =
                    resolveImport(importEntity.name, allSymbolTables, includesGraph);
                if (resolvedExport) {
                    kind = getCompletionItemKind(getLSPSymbolKind(resolvedExport));
                    detail = getCompletionItemDetail(resolvedExport);
                    targetEntity = resolvedExport;
                }

                completionItems.push(makeAutoIncludeCompletionItem(
                    document.uri,
                    label,
                    kind,
                    detail,
                    getCanonicalPath(),
                    targetEntity
                ));
            }
        }

        // Suggest importing symbols that are defined and exported
        for (const exportEntity of otherSymbolTable.exports) {
            if (seenImports.has(exportEntity.name)) continue;
            seenImports.add(exportEntity.name);
            if (visibleFqns.has(exportEntity.getFullyQualifiedName())) continue;

            const resolvedExport = resolveExport(exportEntity, allSymbolTables, includesGraph);
            if (!resolvedExport) continue;

            const label = currentScope.findRelativeName(exportEntity);
            const kind = getCompletionItemKind(getLSPSymbolKind(resolvedExport));
            const detail = getCompletionItemDetail(resolvedExport);
            let labelDetails;
            const data: Record<string, any> = {
                uri: document.uri,
                targetUri: resolvedExport.uri,
                targetLine: resolvedExport.definition.start.line,
                targetName: resolvedExport.name,
            };
            if (!settings.implicitImports && !isImportDir && !isGlobalDir) {
                const relativeUri = getWorkspaceRelativePath(resolvedExport.uri);
                labelDetails = {
                    description: `import from ${relativeUri}`
                };
                data.editAction = 'import';
                data.importSymbol = resolvedExport.name;
            }

            completionItems.push({
                label,
                kind,
                detail,
                labelDetails,
                data,
                sortText: AUTO_IMPORT_ITEM_PREFIX + label
            });
        }
    }

    return completionItems;
}
