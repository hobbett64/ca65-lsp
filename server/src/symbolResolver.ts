import {
    Position,
    Range,
    SymbolKind as LSPSymbolKind,
    Location,
} from 'vscode-languageserver-types';
import { TextDocument } from 'vscode-languageserver-textdocument';
import { SymbolTable, Symbol, SymbolTableEntity, Macro, Scope, ScopeKind, MacroKind, SymbolKind, ReferenceInfo, Export, Import, classifyLabelSegment, resolveSegmentAddrSize, SegmentAddrSize } from './symbolTable';
import { IncludesGraph } from './includesGraph';
import { exportsMap, performanceMonitor } from './server';
import { maskCommentsAtDocumentLine } from './documentScanner';
import { getCachedTextDocument } from './documentCache';
import { TextDocuments } from 'vscode-languageserver/node';

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

export interface CommentSymbolHit {
    rawName: string;
    range: Range;
    hitStartChar: number;
    hitEndChar: number;
}

const BRACED_COMMENT_SYMBOL_RE = /\{(?:@link\s+)?((?:::)?[a-zA-Z_][a-zA-Z0-9_]*(?:::[a-zA-Z_][a-zA-Z0-9_]*)*)\}/g;
const SINGLE_IDENT_TAG_RE = /(?<!\S)@(?:param|arg|argument|input|in|output|out)\b(?:[ \t]+\{[^}]+\})?[ \t]+(\{?((?:::)?[a-zA-Z_][a-zA-Z0-9_]*(?:::[a-zA-Z_][a-zA-Z0-9_]*)*)\}?)/gi;
const COMMA_LIST_TAG_RE = /(?<!\S)(@(?:see|modifies|uses))\b([ \t]+\{?(?:::)?[a-zA-Z_][a-zA-Z0-9_]*(?:::[a-zA-Z_][a-zA-Z0-9_]*)*\}?(?:[ \t]*,[ \t]*\{?(?:::)?[a-zA-Z_][a-zA-Z0-9_]*(?:::[a-zA-Z_][a-zA-Z0-9_]*)*\}?)*)/gi;
const REG_LIST_TAG_RE = /(?<!\S)(@(?:clobbers?|preserves?))\b([ \t]+[^\r\n*]*)/gi;
const IDENT_TARGET_TOKEN_RE = /\{?((?:::)?[a-zA-Z_][a-zA-Z0-9_]*(?:::[a-zA-Z_][a-zA-Z0-9_]*)*)\}?/g;

export function extractCommentSymbolTokensInLine(
    rawLine: string,
    lineNumber: number,
    maskedLine?: string
): CommentSymbolHit[] {
    const hits: CommentSymbolHit[] = [];
    const seenStartChars = new Set<number>();

    const isCommentSpan = (start: number, end: number): boolean => {
        if (!maskedLine) return true;
        return maskedLine.slice(start, end).trim().length === 0;
    };

    const pushTokenHit = (rawName: string, tokenStart: number, tokenEnd: number, hasOpenBrace: boolean) => {
        const nameStart = hasOpenBrace ? tokenStart + 1 : tokenStart;
        const nameEnd = nameStart + rawName.length;
        if (seenStartChars.has(nameStart)) return;
        seenStartChars.add(nameStart);
        hits.push({
            rawName,
            range: Range.create(lineNumber, nameStart, lineNumber, nameEnd),
            hitStartChar: tokenStart,
            hitEndChar: tokenEnd,
        });
    };

    let m: RegExpExecArray | null;
    BRACED_COMMENT_SYMBOL_RE.lastIndex = 0;
    while ((m = BRACED_COMMENT_SYMBOL_RE.exec(rawLine)) !== null) {
        const hitStart = m.index;
        const hitEnd = hitStart + m[0].length;
        if (!isCommentSpan(hitStart, hitEnd)) continue;
        const rawName = m[1];
        const nameStart = hitEnd - 1 - rawName.length;
        const nameEnd = hitEnd - 1;
        seenStartChars.add(nameStart);
        hits.push({
            rawName,
            range: Range.create(lineNumber, nameStart, lineNumber, nameEnd),
            hitStartChar: hitStart,
            hitEndChar: hitEnd,
        });
    }

    SINGLE_IDENT_TAG_RE.lastIndex = 0;
    while ((m = SINGLE_IDENT_TAG_RE.exec(rawLine)) !== null) {
        const fullStart = m.index;
        const fullEnd = fullStart + m[0].length;
        if (!isCommentSpan(fullStart, fullEnd)) continue;
        const tokenStr = m[1];
        const rawName = m[2];
        const tokenStart = fullEnd - tokenStr.length;
        pushTokenHit(rawName, tokenStart, fullEnd, tokenStr.startsWith('{'));
    }

    COMMA_LIST_TAG_RE.lastIndex = 0;
    while ((m = COMMA_LIST_TAG_RE.exec(rawLine)) !== null) {
        const tagStart = m.index;
        const tagEnd = tagStart + m[0].length;
        if (!isCommentSpan(tagStart, tagEnd)) continue;
        const tailOffset = tagStart + m[1].length;
        const tail = m[2];
        let tm: RegExpExecArray | null;
        IDENT_TARGET_TOKEN_RE.lastIndex = 0;
        while ((tm = IDENT_TARGET_TOKEN_RE.exec(tail)) !== null) {
            const tokenStart = tailOffset + tm.index;
            const tokenEnd = tokenStart + tm[0].length;
            pushTokenHit(tm[1], tokenStart, tokenEnd, tm[0].startsWith('{'));
        }
    }

    REG_LIST_TAG_RE.lastIndex = 0;
    while ((m = REG_LIST_TAG_RE.exec(rawLine)) !== null) {
        const tagStart = m.index;
        const tagEnd = tagStart + m[0].length;
        if (!isCommentSpan(tagStart, tagEnd)) continue;
        const tailOffset = tagStart + m[1].length;
        let tail = m[2];
        const stopMatch = tail.match(/[ \t]+[-–—][ \t]|[:(]|\*\//);
        if (stopMatch && stopMatch.index !== undefined) {
            tail = tail.slice(0, stopMatch.index);
        }
        let tm: RegExpExecArray | null;
        IDENT_TARGET_TOKEN_RE.lastIndex = 0;
        while ((tm = IDENT_TARGET_TOKEN_RE.exec(tail)) !== null) {
            const tokenStart = tailOffset + tm.index;
            const tokenEnd = tokenStart + tm[0].length;
            pushTokenHit(tm[1], tokenStart, tokenEnd, tm[0].startsWith('{'));
        }
    }

    hits.sort((a, b) => a.hitStartChar - b.hitStartChar);
    return hits;
}

export function findCommentSymbolAtPosition(
    document: TextDocument,
    position: Position,
    cComments: boolean = true
): CommentSymbolHit | null {
    if (position.line < 0 || position.line >= document.lineCount) {
        return null;
    }
    const rawLine = document.getText({
        start: { line: position.line, character: 0 },
        end: { line: position.line + 1, character: 0 },
    });
    const maskedLine = maskCommentsAtDocumentLine(document, position.line, undefined, cComments);
    const hits = extractCommentSymbolTokensInLine(rawLine, position.line, maskedLine);
    for (const hit of hits) {
        if (position.character >= hit.hitStartChar && position.character <= hit.hitEndChar) {
            return hit;
        }
    }
    return null;
}

export function resolveCommentSymbol(
    uri: string,
    position: Position,
    rawName: string,
    allSymbolTables: Map<string, SymbolTable>,
    includesGraph: IncludesGraph,
    implicitImports: boolean = false
): SymbolTableEntity | undefined {
    if (!rawName) return undefined;
    const isGlobal = rawName.startsWith('::');
    const clean = isGlobal ? rawName.slice(2) : rawName;
    const parts = clean.split('::').filter(Boolean);
    if (parts.length === 0) return undefined;

    const leaf = parts[parts.length - 1];
    const qualifiers = isGlobal ? ['', ...parts.slice(0, -1)] : parts.slice(0, -1);
    const symbolTable = allSymbolTables.get(uri);
    const scope = symbolTable?.getScopeAtPosition(position) ?? symbolTable?.getRootScope();

    if (scope) {
        const loc = Range.create(position, position);
        for (const ctx of ['symbol', 'scope'] as const) {
            const resolved = resolveReference(
                new ReferenceInfo(uri, leaf, qualifiers, ctx, loc, scope),
                allSymbolTables,
                includesGraph,
                implicitImports
            );
            if (resolved) return resolved;
        }
    }

    if (!isGlobal && qualifiers.length === 0) {
        const macro = resolveMacroByName(uri, leaf, allSymbolTables, includesGraph);
        if (macro) return macro;
        const imported = resolveImport(leaf, allSymbolTables, includesGraph);
        if (imported) return imported;
    }

    const searchQualifiers = isGlobal ? qualifiers.slice(1) : qualifiers;
    for (const st of allSymbolTables.values()) {
        const root = st.getRootScope();
        const found = root.findDefinition(leaf, searchQualifiers, 'symbol')
            ?? root.findDefinition(leaf, searchQualifiers, 'scope');
        if (found) return found;
        if (!isGlobal && qualifiers.length === 0) {
            const m = st.getMacro(leaf);
            if (m) return m;
        }
    }

    return undefined;
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

export interface CommentSegmentSpan {
    name: string;
    prefixRawName: string;
    range: Range;
    isLeaf: boolean;
}

export function splitCommentTokenSegments(hit: CommentSymbolHit): CommentSegmentSpan[] {
    const raw = hit.rawName;
    const line = hit.range.start.line;
    const baseChar = hit.range.start.character;
    const isGlobal = raw.startsWith('::');
    const spans: CommentSegmentSpan[] = [];

    let offset = isGlobal ? 2 : 0;
    while (offset < raw.length) {
        const nextSep = raw.indexOf('::', offset);
        const endOffset = nextSep >= 0 ? nextSep : raw.length;
        const segName = raw.slice(offset, endOffset);
        if (segName.length > 0) {
            spans.push({
                name: segName,
                prefixRawName: raw.slice(0, endOffset),
                range: Range.create(line, baseChar + offset, line, baseChar + endOffset),
                isLeaf: nextSep < 0,
            });
        }
        if (nextSep < 0) break;
        offset = nextSep + 2;
    }
    return spans;
}

export function resolveCommentSegmentAtPosition(
    uri: string,
    position: Position,
    document: TextDocument,
    allSymbolTables: Map<string, SymbolTable>,
    includesGraph: IncludesGraph,
    implicitImports: boolean = false,
    cComments: boolean = true
): { entity: SymbolTableEntity; range: Range; placeholder: string } | null {
    const hit = findCommentSymbolAtPosition(document, position, cComments);
    if (!hit) return null;
    const segments = splitCommentTokenSegments(hit);
    if (segments.length === 0) return null;

    const targetSeg = segments.find(
        s => position.character >= s.range.start.character && position.character <= s.range.end.character
    ) ?? segments[segments.length - 1];

    const entity = resolveCommentSymbol(
        uri,
        position,
        targetSeg.prefixRawName,
        allSymbolTables,
        includesGraph,
        implicitImports
    );
    if (!entity) return null;
    return {
        entity,
        range: targetSeg.range,
        placeholder: targetSeg.name,
    };
}

export async function findCommentReferenceLocationsForEntity(
    entity: SymbolTableEntity,
    documents: TextDocuments<TextDocument>,
    allSymbolTables: Map<string, SymbolTable>,
    includesGraph: IncludesGraph,
    implicitImports: boolean = false,
    cComments: boolean = true
): Promise<Location[]> {
    const targetName = entity.name;
    if (!targetName) return [];

    const locations: Location[] = [];
    for (const uri of allSymbolTables.keys()) {
        const doc = await getCachedTextDocument(uri, documents);
        if (!doc) continue;
        const fullText = doc.getText();
        if (!fullText.includes(targetName)) continue;

        const lines = fullText.split(/\r?\n/);
        for (let ln = 0; ln < lines.length; ln++) {
            const rawLine = lines[ln];
            if (!rawLine.includes(targetName)) continue;
            const maskedLine = maskCommentsAtDocumentLine(doc, ln, undefined, cComments);
            const hits = extractCommentSymbolTokensInLine(rawLine, ln, maskedLine);
            for (const hit of hits) {
                for (const seg of splitCommentTokenSegments(hit)) {
                    if (seg.name !== targetName) continue;
                    const resolved = resolveCommentSymbol(
                        uri,
                        { line: ln, character: hit.hitStartChar },
                        seg.prefixRawName,
                        allSymbolTables,
                        includesGraph,
                        implicitImports
                    );
                    if (resolved === entity) {
                        locations.push(Location.create(uri, seg.range));
                    }
                }
            }
        }
    }

    return locations;
}

export function mergeUniqueLocations(primary: Location[], extra: Location[]): Location[] {
    if (extra.length === 0) return primary;
    const seen = new Set<string>();
    const out: Location[] = [];
    for (const loc of [...primary, ...extra]) {
        const key = `${loc.uri}:${loc.range.start.line}:${loc.range.start.character}:${loc.range.end.line}:${loc.range.end.character}`;
        if (seen.has(key)) continue;
        seen.add(key);
        out.push(loc);
    }
    return out;
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
            case SymbolKind.CodeLabel: return LSPSymbolKind.Function;
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
