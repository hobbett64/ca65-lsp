import {
    _Connection,
    TextDocuments,
    CompletionItem,
    CompletionItemKind,
    TextDocumentPositionParams,
    Range,
    TextEdit,
    SymbolKind as LSPSymbolKind,
    Position,
} from 'vscode-languageserver/node';
import { TextDocument } from 'vscode-languageserver-textdocument';
import { getDocumentSettings, includesGraph, initializationGate, performanceMonitor, symbolTables } from './server';
import { directiveData, mnemonicData, resolveDirectiveAlias } from './dataManager';
import { Export, Import, ImportKind, Macro, MacroKind, Scope, ScopeKind, Symbol, SymbolTable, SymbolTableEntity } from './symbolTable';
import { getCheapLocalLabelDefinitions } from './cheapLocalLabelUtils';
import { IncludesGraph } from './includesGraph';
import { getLSPSymbolKind, resolveExport, resolveImport } from './symbolResolver';
import { findCanonicalIncludePath, getWorkspaceRelativePath } from './pathUtils';
import { Ca65Settings } from './settings';
import { isAutoIncludable, makeImportEdit, makeIncludeEdit } from './editUtils';

const CHEAP_LOCAL_ITEM_PREFIX = 0;
const VISIBLE_ITEM_PREFIX = 1;
const MNEMONIC_ITEM_PREFIX = 2;
const DIRECTIVE_ITEM_PREFIX = 3;
const AUTO_INCLUDE_ITEM_PREFIX = 4;
const AUTO_IMPORT_ITEM_PREFIX = 5;

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
    if (
        entity instanceof Macro
        || entity instanceof Symbol
        || entity instanceof Scope
        || entity instanceof Import
        || entity instanceof Export
    ) {
        return entity.kind
    }

    return undefined
}

interface StaticCompletionTemplates {
    mnemonics: Omit<CompletionItem, 'textEdit'>[];
    controlDirectives: Omit<CompletionItem, 'textEdit'>[];
    operandDirectives: Omit<CompletionItem, 'textEdit'>[];
}

let cachedStaticTemplates: StaticCompletionTemplates | null = null;

function getStaticTemplates(): StaticCompletionTemplates {
    if (cachedStaticTemplates) {
        return cachedStaticTemplates;
    }

    const mnemonics: Omit<CompletionItem, 'textEdit'>[] = [];
    for (const key in mnemonicData) {
        const lowerCaseKey = key.toLowerCase();
        mnemonics.push({
            label: lowerCaseKey,
            kind: CompletionItemKind.Keyword,
            detail: 'Mnemonic',
            sortText: MNEMONIC_ITEM_PREFIX + lowerCaseKey
        });
    }

    const controlDirectives: Omit<CompletionItem, 'textEdit'>[] = [];
    const operandDirectives: Omit<CompletionItem, 'textEdit'>[] = [];
    for (const key in directiveData) {
        const directive = resolveDirectiveAlias(key);
        if (!directive) continue;

        const directiveName = `.${key.toLowerCase()}`;
        if (directive.type === 'Control command') {
            controlDirectives.push({
                label: directiveName,
                kind: CompletionItemKind.Keyword,
                detail: 'Control Command',
                sortText: DIRECTIVE_ITEM_PREFIX + directiveName
            });
        } else if (directive.type === 'Pseudo-function' || directive.type === 'Pseudo-variable') {
            operandDirectives.push({
                label: directiveName,
                kind: directive.type === 'Pseudo-function' ? CompletionItemKind.Function : CompletionItemKind.Variable,
                detail: directive.type,
                sortText: DIRECTIVE_ITEM_PREFIX + directiveName
            });
        }
    }

    cachedStaticTemplates = { mnemonics, controlDirectives, operandDirectives };
    return cachedStaticTemplates;
}

function getCheapLocalLabelCompletions(
    document: TextDocument,
    position: Position,
    replacementRange: Range,
    currentWord: string
): CompletionItem[] {
    return getCheapLocalLabelDefinitions(document, position).map(labelName => {
        const item: CompletionItem = {
            label: labelName,
            kind: CompletionItemKind.Reference,
            detail: 'cheap_local_label',
            textEdit: TextEdit.replace(replacementRange, labelName),
            sortText: CHEAP_LOCAL_ITEM_PREFIX + labelName.slice(1)
        };
        if (!currentWord.startsWith('@')) {
            item.filterText = labelName.substring(1);
        }
        return item;
    });
}

export function initializeCompletionProvider(connection: _Connection, documents: TextDocuments<TextDocument>) {
    connection.onCompletion(async (params: TextDocumentPositionParams): Promise<CompletionItem[]> => {
        await initializationGate.isInitialized;

        return performanceMonitor.timeAsync("onCompletion", async () => {
            const document = documents.get(params.textDocument.uri);
            if (!document) {
                return [];
            }
            const settings = await getDocumentSettings(document.uri);
            const position = params.position;

            const lineToCursor = document.getText({ start: { line: params.position.line, character: 0 }, end: params.position });

            const anonLabelRefRegex = /:[-+<>]+$/;
            if (anonLabelRefRegex.test(lineToCursor)) {
                // Anonymous labels are considered to be words in language-configuration.json in order
                // to show them in the document highlights. However, this also results in them being
                // valid parts of autocompletion, which results in a nuissance autocompletion window
                // during typing. Suppress this autocompletion if we're in the middle of typing an
                // anonymous label refrence.
                return [];
            }

            const fullLineUntrimmed = document.getText(Range.create(params.position.line, 0, params.position.line + 1, 0));
            
            const wordMatch = lineToCursor.match(/[a-zA-Z0-9_.:@]*$/);
            const currentWord = wordMatch ? wordMatch[0] : '';
            const replacementRange = Range.create(
                params.position.line,
                params.position.character - currentWord.length,
                params.position.line,
                params.position.character
            );

            // --- CONTEXT DETERMINATION ---
            const prefixMatch = fullLineUntrimmed.match(/^\s*(?:(?:[a-zA-Z_@.][a-zA-Z0-9_@.]*)?:(?![:=<>+-])\s*)?/);
            const prefixLen = prefixMatch ? prefixMatch[0].length : 0;
            const afterPrefix = fullLineUntrimmed.slice(prefixLen);
            const cmdMatch = afterPrefix.match(/^([a-zA-Z_.]+)/);
            const isCommandContext = !cmdMatch || params.position.character <= prefixLen + cmdMatch[1].length;

            const templates = getStaticTemplates();

            if (isCommandContext) {
                // --- COMMAND CONTEXT: Suggest mnemonics, control commands, and macros ---
                const completionItems: CompletionItem[] = [
                    ...templates.mnemonics.map(item => ({
                        ...item,
                        textEdit: TextEdit.replace(replacementRange, item.label),
                    })),
                    ...templates.controlDirectives.map(item => ({
                        ...item,
                        textEdit: TextEdit.replace(replacementRange, item.label),
                    })),
                    ...await getCompletionMacros(document, symbolTables, settings),
                ];
                return completionItems;
            } else {
                // --- OPERAND CONTEXT: Suggest labels, constants, variables, and pseudo-functions/variables ---
                const completionItems: CompletionItem[] = [
                    ...await getCompletionSymbols(document, position, symbolTables, includesGraph, settings),
                    ...getCheapLocalLabelCompletions(document, params.position, replacementRange, currentWord),
                    ...templates.operandDirectives.map(item => ({
                        ...item,
                        textEdit: TextEdit.replace(replacementRange, item.label),
                    })),
                ];
                return completionItems;
            }
        });
    });

    connection.onCompletionResolve(
        async (item: CompletionItem): Promise<CompletionItem> => {
            const data = item.data;
            if (!data || !data.uri) {
                return item;
            }

            const document = documents.get(data.uri);
            if (!document) {
                return item;
            }

            if (data.editAction === 'include' && data.includePath) {
                item.additionalTextEdits = [makeIncludeEdit(document, data.includePath)];
            } else if (data.editAction === 'import' && data.importSymbol) {
                item.additionalTextEdits = [makeImportEdit(document, data.importSymbol)];
            }

            return item;
        }
    );
}

function getVisibleTranslationUnitUris(uri: string, graph: IncludesGraph): readonly string[] {
    const tuUris = graph.getTranslationUnit(uri);
    return tuUris.length > 0 ? tuUris : [uri];
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
    includePath: string
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
            includePath
        }
    };
}

async function getCompletionMacros(
    document: TextDocument,
    allSymbolTables: Map<string, SymbolTable>,
    settings: Ca65Settings
): Promise<CompletionItem[]> {
    const completionItems: CompletionItem[] = [];

    const seenUris: Set<string> = new Set();

    for (const dep of getVisibleTranslationUnitUris(document.uri, includesGraph)) {
        if (seenUris.has(dep)) continue;
        seenUris.add(dep);

        const symbolTable = allSymbolTables.get(dep);
        if (!symbolTable) continue;

        for (const macro of symbolTable.getAllMacros()) {
            if (macro.kind === MacroKind.Macro) {
                let label = macro.name;
                let kind = getCompletionItemKind(getLSPSymbolKind(macro));
                let detail = `${getCompletionItemDetail(macro)}`;

                completionItems.push({
                    label,
                    kind,
                    detail,
                    sortText: VISIBLE_ITEM_PREFIX + label
                });
            }
        }
    }

    // Find macros in files we can auto-include.
    for (const [otherUri, symbolTable] of allSymbolTables) {
        if (seenUris.has(otherUri)) continue;
        if (!isAutoIncludable(otherUri, settings)) continue;
        let canonicalPath;
        for (const macro of symbolTable.getAllMacros()) {
            if (macro.kind !== MacroKind.Macro) continue;
            if (!canonicalPath) {
                canonicalPath =
                    findCanonicalIncludePath(document.uri, otherUri, settings.includeDirs);
            }

            let label = macro.name;
            let kind = getCompletionItemKind(getLSPSymbolKind(macro));
            let detail = `${getCompletionItemDetail(macro)}`;

            completionItems.push({
                label,
                kind,
                detail,
                labelDetails: {
                    description: `include ${canonicalPath}`
                },
                sortText: AUTO_INCLUDE_ITEM_PREFIX + label,
                data: {
                    uri: document.uri,
                    editAction: 'include',
                    includePath: canonicalPath
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
    settings: Ca65Settings
): Promise<CompletionItem[]> {
    const symbolTable = allSymbolTables.get(document.uri);
    if (!symbolTable) return [];

    const currentScope = symbolTable.getScopeAtPosition(position);
    if (!currentScope) return [];

    const completionItems: CompletionItem[] = [];

    // Gather all locally visible symbols across the current translation unit
    const visibleUris = getVisibleTranslationUnitUris(document.uri, includesGraph);
    const visibleUriSet = new Set(visibleUris);
    const includedUris: Set<string> = new Set();
    const seenImports: Set<string> = new Set();
    const visibleFqns: Set<string> = new Set();
    for (const depUri of visibleUris) {
        if (includedUris.has(depUri)) continue;
        includedUris.add(depUri);
        const depSymbolTable = allSymbolTables.get(depUri);
        if (!depSymbolTable) continue;

        for (const entity of depSymbolTable.getAllDefinedEntities()) {
            if (isValueCompletionEntity(entity)) {
                visibleFqns.add(entity.getFullyQualifiedName());
                const label = currentScope.findRelativeName(entity);
                const kind = getCompletionItemKind(getLSPSymbolKind(entity));
                const detail = `${getCompletionItemDetail(entity)}`;

                completionItems.push({
                    label,
                    kind,
                    detail,
                    sortText: VISIBLE_ITEM_PREFIX + label
                });
            }
        }

        for (const importEntity of depSymbolTable.imports) {
            seenImports.add(importEntity.name);
            visibleFqns.add(importEntity.getFullyQualifiedName());

            const label = currentScope.findRelativeName(importEntity);
            let kind = getCompletionItemKind(getLSPSymbolKind(importEntity));
            let detail = `${getCompletionItemDetail(importEntity)}`;

            // Try to resolve it to a definition we can use for the details. Otherwise, treat
            // it as an opaque import, which may be the case if it is a header for a library
            // file.
            const resolvedImport =
                resolveImport(importEntity.name, allSymbolTables, includesGraph);
            if (resolvedImport) {
                // This may be a global that is acting as an export, which we should ignore.
                if (
                    importEntity.kind === ImportKind.Global
                    && includesGraph.getTranslationUnit(importEntity.uri).includes(resolvedImport.uri)
                ) {
                    continue;
                }

                if (visibleUriSet.has(resolvedImport.uri)) continue;
                kind = getCompletionItemKind(getLSPSymbolKind(resolvedImport));
                detail = `${getCompletionItemDetail(resolvedImport)}`;
            }

            completionItems.push({
                label,
                kind,
                detail,
                sortText: VISIBLE_ITEM_PREFIX + label
            });
        }
    }

    // Search the workspace for symbols that we can auto-include or import
    for (const [uri, otherSymbolTable] of allSymbolTables) {
        if (includedUris.has(uri)) continue;

        if (isAutoIncludable(uri, settings)) {
            let canonicalPath: string | undefined;
            const getCanonicalPath = () => {
                if (!canonicalPath) {
                    canonicalPath = findCanonicalIncludePath(document.uri, uri, settings.includeDirs);
                }
                return canonicalPath;
            };

            // Suggest including .inc files that define a symbol
            for (const entity of otherSymbolTable.getAllDefinedEntities()) {
                if (isValueCompletionEntity(entity)) {
                    if (visibleFqns.has(entity.getFullyQualifiedName())) continue;
                    completionItems.push(makeAutoIncludeCompletionItem(
                        document.uri,
                        currentScope.findRelativeName(entity),
                        getCompletionItemKind(getLSPSymbolKind(entity)),
                        `${getCompletionItemDetail(entity)}`,
                        getCanonicalPath()
                    ));
                }
            }

            // Suggest including files that import symbols (i.e. headers)
            for (const importEntity of otherSymbolTable.imports) {
                if (visibleFqns.has(importEntity.getFullyQualifiedName())) continue;

                const label = currentScope.findRelativeName(importEntity);
                let kind = getCompletionItemKind(getLSPSymbolKind(importEntity));
                let detail = `${getCompletionItemDetail(importEntity)}`;

                // Try to resolve it to a definition we can use for the details. Otherwise, treat
                // it as an opaque import, which may be the case if it is a header for a library
                // file.
                const resolvedExport =
                    resolveImport(importEntity.name, allSymbolTables, includesGraph);
                if (resolvedExport) {
                    kind = getCompletionItemKind(getLSPSymbolKind(resolvedExport));
                    detail = `${getCompletionItemDetail(resolvedExport)}`;
                }

                completionItems.push(makeAutoIncludeCompletionItem(
                    document.uri,
                    label,
                    kind,
                    detail,
                    getCanonicalPath()
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
            const detail = `${getCompletionItemDetail(resolvedExport)}`;
            let labelDetails;
            let data;
            if (!settings.implicitImports) {
                const relativeUri = getWorkspaceRelativePath(resolvedExport.uri);
                labelDetails = {
                    description: `import from ${relativeUri}`
                };

                data = {
                    uri: document.uri,
                    editAction: 'import',
                    importSymbol: resolvedExport.name
                };
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
