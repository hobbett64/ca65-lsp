import {
    Position,
    SymbolKind as LSPSymbolKind,
    Location,
} from 'vscode-languageserver-types';
import { SymbolTable, Symbol, SymbolTableEntity, Macro, Scope, ScopeKind, MacroKind, SymbolKind, ReferenceInfo, Export, Import, classifyLabelSegment, resolveSegmentAddrSize, SegmentAddrSize } from './symbolTable';
import { IncludesGraph } from './includesGraph';
import { exportsMap, performanceMonitor } from './server';

const cachedLocalResolutionsPerUri: Map<string, Map<ReferenceInfo, SymbolTableEntity | null>> = new Map();
const cachedExportResolutionsPerUri: Map<string, Map<Export, Symbol | Scope | null>> = new Map();
const cachedImportResolutions: Map<string, Symbol | Scope | null> = new Map();

export function deleteCachedResolutions(uri: string) {
    cachedLocalResolutionsPerUri.delete(uri);
    cachedExportResolutionsPerUri.delete(uri);
    cachedImportResolutions.clear();
}

export function resolveMacroByName(
    uri: string,
    name: string,
    allSymbolTables: Map<string, SymbolTable>,
    includesGraph: IncludesGraph
): Macro | undefined {
    const tuUris = includesGraph.getTranslationUnit(uri);
    const searchUris = tuUris.length > 0 ? tuUris : [uri];
    for (const candidateUri of searchUris) {
        const macro = allSymbolTables.get(candidateUri)?.getMacro(name);
        if (macro) return macro;
    }
    return undefined;
}

export function resolveReferenceAtPosition(
    uri: string,
    position: Position,
    allSymbolTables: Map<string, SymbolTable>,
    includesGraph: IncludesGraph,
    implicitImports: boolean
): SymbolTableEntity | undefined {

    const symbolTable = allSymbolTables.get(uri);
    if (!symbolTable) {
        return undefined;
    }

    const ref = symbolTable.getReferenceAtPosition(position);
    if (!ref) {
        return undefined;
    }
    const resolved = resolveReference(ref, allSymbolTables, includesGraph, implicitImports);
    return resolved;
}

/**
 * Resolves a reference to its definitive SymbolTableEntity.
 * It searches locally, through includes, and across the workspace via imports/exports.
 * @param ref The reference to resolve.
 * @param allSymbolTables A map of all parsed symbol tables in the workspace.
 * @param includesGraph The dependency graph of all .include directives.
 * @returns A SymbolTableEntity or undefined if not found.
 */
export function resolveReference(
    ref: ReferenceInfo,
    allSymbolTables: Map<string, SymbolTable>,
    includesGraph: IncludesGraph,
    implicitImports: boolean
): SymbolTableEntity | undefined {
    return performanceMonitor.time('resolveReference', () => {
        const localReference = resolveLocalReference(ref, allSymbolTables, includesGraph);

        // We found an import. Now check all of the exported symbols in the workspace.
        // If there is no exported symbol, treat the import itself as the definition since we may
        // be looking at a library header.
        if (localReference instanceof Import) {
            const resolvedImport = resolveImport(localReference.name, allSymbolTables, includesGraph);
            return resolvedImport ? resolvedImport : localReference;
        }

        // If we didn't find a local reference, and implicit imports are enabled,
        // and this is a symbol reference in the global scope, try to resolve it as an implicit import.
        if (
            !localReference
            && implicitImports
            && ref.context === 'symbol'
            && (ref.qualifiers.length === 0 || ref.qualifiers[0].length === 0 /* Global scope */)
        ) {
            return resolveImport(ref.name, allSymbolTables, includesGraph);
        }

        return localReference;
    });
}

/**
 * Resolves a reference within a translation unit.
 */
export function resolveLocalReference(
    ref: ReferenceInfo,
    allSymbolTables: Map<string, SymbolTable>,
    includesGraph: IncludesGraph,
): SymbolTableEntity | undefined {
    let cachedResolutions = cachedLocalResolutionsPerUri.get(ref.uri);
    if (cachedResolutions && cachedResolutions.has(ref)) {
        return cachedResolutions.get(ref) ?? undefined;
    }

    return performanceMonitor.time('resolveLocalReference_uncached', () => {
        if (!cachedResolutions) {
            cachedResolutions = new Map();
            cachedLocalResolutionsPerUri.set(ref.uri, cachedResolutions);
        }

        // Macros have a flat, non-lexical namespace within a file and its includes.
        if (ref.context === 'macro') {
            for (const uri of includesGraph.getTranslationUnit(ref.uri)) {
                const symbolTable = allSymbolTables.get(uri);
                if (!symbolTable) continue;

                const macro = symbolTable.getMacro(ref.name);
                if (macro) {
                    cachedResolutions.set(ref, macro);
                    return macro;
                }
            }
            cachedResolutions.set(ref, null);
            return undefined; // No preceding macro found
        }

        // Try to find the symbol in our locally visible files
        let importEntity: Import | undefined;
        for (const uri of includesGraph.getTranslationUnit(ref.uri)) {
            const symbolTable = allSymbolTables.get(uri);
            if (!symbolTable) continue;

            const localEntity = uri === ref.uri
                ? ref.scope.findDefinitionOrImport(ref.name, ref.qualifiers, ref.context)
                : symbolTable.getRootScope().findDefinitionOrImport(ref.name, ref.qualifiers, ref.context);

            if (localEntity) {
                if (localEntity instanceof Import) {
                    importEntity = localEntity;
                    break;
                }
                cachedResolutions.set(ref, localEntity);
                return localEntity;
            }
        }

        if (importEntity) {
            cachedResolutions.set(ref, importEntity);
            return importEntity;
        }

        cachedResolutions.set(ref, null);
        return undefined;
    });
}

/**
 * Resolves an import to the symbol that exports it across the workspace.
 * @param importEntity The reference to resolve.
 * @param allSymbolTables A map of all parsed symbol tables in the workspace.
 * @param includesGraph The dependency graph of all .include directives.
 * @returns A SymbolTableEntity or undefined if not found.
 */
export function resolveImport(
    importName: string,
    allSymbolTables: Map<string, SymbolTable>,
    includesGraph: IncludesGraph,
): Symbol | Scope | undefined {
    if (cachedImportResolutions.has(importName)) {
        return cachedImportResolutions.get(importName) ?? undefined;
    }

    for (const exportEntity of exportsMap.get(importName)) {
        const resolved = resolveExport(exportEntity, allSymbolTables, includesGraph);
        if (resolved) {
            cachedImportResolutions.set(importName, resolved);
            return resolved;
        }
    }
    cachedImportResolutions.set(importName, null);
    return undefined;
}

/**
 * Resolves an export to the symbol's definition within it's translation unit.
 * @param importEntity The reference to resolve.
 * @param allSymbolTables A map of all parsed symbol tables in the workspace.
 * @param includesGraph The dependency graph of all .include directives.
 * @returns A SymbolTableEntity or undefined if not found.
 */
export function resolveExport(
    exportEntity: Export,
    allSymbolTables: Map<string, SymbolTable>,
    includesGraph: IncludesGraph,
): Symbol | Scope | undefined {
    let cachedResolutions = cachedExportResolutionsPerUri.get(exportEntity.uri);
    if (cachedResolutions && cachedResolutions.has(exportEntity)) {
        return cachedResolutions.get(exportEntity) ?? undefined;
    }

    return performanceMonitor.time('resolveExport_uncached', () => {
        if (!cachedResolutions) {
            cachedResolutions = new Map();
            cachedExportResolutionsPerUri.set(exportEntity.uri, cachedResolutions);
        }

        for (const translationUnitUri of includesGraph.getTranslationUnit(exportEntity.uri)) {
            const translationUnitSymbolTable = allSymbolTables.get(translationUnitUri);
            if (!translationUnitSymbolTable) continue;

            const searchScope = (translationUnitUri === exportEntity.uri && exportEntity.scope)
                ? exportEntity.scope
                : translationUnitSymbolTable.getRootScope();
            const foreignEntity = searchScope.findDefinition(
                exportEntity.name,
                exportEntity.scope?.getScopeStack() ?? [],
                'symbol'
            );
            if (!foreignEntity) continue;

            if (foreignEntity instanceof Symbol
                || (foreignEntity instanceof Scope && foreignEntity.kind === ScopeKind.Proc)) {
                cachedResolutions.set(exportEntity, foreignEntity);
                return foreignEntity;
            }
        }
        cachedResolutions.set(exportEntity, null);
        return undefined;
    });
}

export function getAllReferencesForEntity(
    entity: SymbolTableEntity,
    allSymbolTables: Map<string, SymbolTable>,
    includesGraph: IncludesGraph,
    implicitImports: boolean
): ReferenceInfo[] {
    return performanceMonitor.time('getAllReferencesForEntity', () => {
        const allRefs: ReferenceInfo[] = [];

        const isExported = exportsMap.get(entity.name).some(
            exp => resolveExport(exp, allSymbolTables, includesGraph) === entity
        );
        const tablesToSearch: SymbolTable[] = [];
        if (isExported) {
            for (const symbolTable of allSymbolTables.values()) {
                if (symbolTable.getReferencesByName(entity.name).length === 0) continue;
                if (!implicitImports && symbolTable.uri !== entity.uri) {
                    const tuSet = includesGraph.getTranslationUnitSet(symbolTable.uri);
                    if (!tuSet.has(entity.uri)) {
                        let hasImportInTu = symbolTable.hasImport(entity.name);
                        if (!hasImportInTu) {
                            for (const tuUri of tuSet) {
                                if (allSymbolTables.get(tuUri)?.hasImport(entity.name)) {
                                    hasImportInTu = true;
                                    break;
                                }
                            }
                        }
                        if (!hasImportInTu) continue;
                    }
                }
                tablesToSearch.push(symbolTable);
            }
        } else {
            const tuUris = includesGraph.getTranslationUnit(entity.uri);
            if (tuUris.length > 0) {
                for (const uri of tuUris) {
                    const st = allSymbolTables.get(uri);
                    if (st) tablesToSearch.push(st);
                }
            } else {
                const st = allSymbolTables.get(entity.uri);
                if (st) tablesToSearch.push(st);
            }
        }

        for (const symbolTable of tablesToSearch) {
            for (const ref of symbolTable.getReferencesByName(entity.name)) {
                const refResult = resolveReference(ref, allSymbolTables, includesGraph, implicitImports);
                if (refResult !== entity) continue;

                allRefs.push(ref);
            }
        }

        return allRefs;
    });
}

export function getAllReferenceLocationsForEntity(
    entity: SymbolTableEntity,  
    allSymbolTables: Map<string, SymbolTable>,
    includesGraph: IncludesGraph,
    implicitImports: boolean = false
): Location[] {
    return getAllReferencesForEntity(entity, allSymbolTables, includesGraph, implicitImports)
        .map((ref) => { return { uri: ref.uri, range: ref.location }})
}

function getLabelSymbolKindBySegment(segment: string | null | undefined, addrSize?: SegmentAddrSize): LSPSymbolKind {
    switch (classifyLabelSegment(segment, addrSize)) {
        case 'code':
            return LSPSymbolKind.Function;
        case 'rodata':
        case 'data':
            return LSPSymbolKind.Array;
        case 'bss':
            return LSPSymbolKind.Variable;
        default:
            return LSPSymbolKind.String;
    }
}

export function getLSPSymbolKind(
    item: SymbolTableEntity,
    allSymbolTables?: Map<string, SymbolTable>
): LSPSymbolKind {
    if (item instanceof Macro) {
        switch (item.kind) {
            case MacroKind.Define: return LSPSymbolKind.Constant;
            default: return LSPSymbolKind.Function;
        }
    }

    if (item instanceof Symbol) {
        switch (item.kind) {
            case SymbolKind.ResLabel: return LSPSymbolKind.Variable;
            case SymbolKind.DataLabel: return LSPSymbolKind.Array;
            case SymbolKind.StringLabel: return LSPSymbolKind.String;
            case SymbolKind.Constant: return LSPSymbolKind.Constant;
            case SymbolKind.Variable: return LSPSymbolKind.Variable;
            case SymbolKind.StructMember: return LSPSymbolKind.Field;
            case SymbolKind.EnumMember: return LSPSymbolKind.EnumMember;
            default: {
                const addrSize = resolveSegmentAddrSize(item.segment, allSymbolTables?.get(item.uri), allSymbolTables);
                return getLabelSymbolKindBySegment(item.segment, addrSize);
            }
        }
    }

    if (item instanceof Scope) {
        switch (item.kind) {
            case ScopeKind.Proc: return LSPSymbolKind.Function;
            case ScopeKind.Struct:
            case ScopeKind.Union: return LSPSymbolKind.Struct;
            case ScopeKind.Enum: return LSPSymbolKind.Enum;
            default: return LSPSymbolKind.Namespace;
        }
    }

    // Fallback if unknown
    return LSPSymbolKind.Function;
}

/**
 * Resolves references once per file across the given URIs and returns per-file entity hit counts.
 */
export function countReferencesByFile(
    uris: Iterable<string>,
    allSymbolTables: Map<string, SymbolTable>,
    includesGraph: IncludesGraph,
): Map<string, Map<SymbolTableEntity, number>> {
    return performanceMonitor.time('countReferencesByFile', () => {
        const countsByFile = new Map<string, Map<SymbolTableEntity, number>>();
        for (const uri of uris) {
            const symbolTable = allSymbolTables.get(uri);
            if (!symbolTable) continue;

            const fileCounts = new Map<SymbolTableEntity, number>();
            for (const ref of symbolTable.getAllReferences()) {
                const resolved = resolveReference(ref, allSymbolTables, includesGraph, false);
                if (resolved) {
                    fileCounts.set(resolved, (fileCounts.get(resolved) ?? 0) + 1);
                }
            }
            countsByFile.set(uri, fileCounts);
        }
        return countsByFile;
    });
}

export function isEntityUsed(
    entity: SymbolTableEntity,
    allSymbolTables: Map<string, SymbolTable>,
    includesGraph: IncludesGraph,
    precomputedCounts?: Map<string, Map<SymbolTableEntity, number>>,
): boolean {
    return performanceMonitor.time('isEntityUsed', () => {
        let refCount = 0;
        for (const translationUnitUri of includesGraph.getTranslationUnit(entity.uri)) {
            if (precomputedCounts) {
                refCount += precomputedCounts.get(translationUnitUri)?.get(entity) ?? 0;
                if (refCount > 1) return true;
                continue;
            }

            const symbolTable = allSymbolTables.get(translationUnitUri);
            if (!symbolTable) continue;

            for (const ref of symbolTable.getReferencesByName(entity.name)) {
                const refResult = resolveReference(ref, allSymbolTables, includesGraph, false);
                if (refResult === entity) {
                    refCount++;
                    if (refCount > 1) {
                        return true;
                    }
                }
            }
        }
        return false;
    });
}
