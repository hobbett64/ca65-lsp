/**
 * Custom requests used by the client to link linker-visible (global) ca65 symbols to C symbols
 * served by clangd. The C <-> asm name mapping (`foo` <-> `_foo`) lives in the client; this module
 * only answers questions about asm symbols by their exact (linker) name.
 */
import {
    _Connection,
    Location,
    Position,
    TextDocuments,
    TextEdit,
    WorkspaceEdit,
} from 'vscode-languageserver/node';
import { TextDocument } from 'vscode-languageserver-textdocument';
import { ensureDocumentRefreshed, exportsMap, getDocumentSettings, includesGraph, initializationGate, symbolTables } from './server';
import {
    findCommentReferenceLocationsForEntity,
    getAllReferenceLocationsForEntity,
    mergeUniqueLocations,
    resolveExport,
    resolveImport,
    resolveReference,
} from './symbolResolver';
import { Import, SymbolTableEntity } from './symbolTable';
import { getCachedTextDocument } from './documentCache';
import { isEmbeddedUri } from './embeddedDocs';
import { generateSymbolTableEntityMarkdown } from './hoverProvider';
import { formatListingAddressLabel, normalizeListingBytesText, parseLstContent } from './lstParser';

export interface GlobalSymbolAtResult {
    /** Linker-visible name of the symbol (e.g. `_foo`). */
    name: string;
    /** True when the symbol is defined (and exported) by an assembly source in the workspace. */
    hasAsmDefinition: boolean;
}

export interface LookupGlobalResult {
    name: string;
    /** Resolved asm definition(s) of the exported symbol. Empty when the symbol is only imported. */
    definitions: Location[];
    /** Whether any asm source imports the symbol. */
    imported: boolean;
    /** Hover markdown for the asm definition, if any. */
    hoverMarkdown?: string;
}

/** Root-scope imports with the given name across the workspace (one per translation unit). */
function findRootImports(name: string): Import[] {
    const result: Import[] = [];
    for (const table of symbolTables.values()) {
        for (const imp of table.imports) {
            if (imp.name === name && (!imp.scope || imp.scope.name === '')) {
                result.push(imp);
            }
        }
    }
    return result;
}

function isExportedEntity(entity: SymbolTableEntity): boolean {
    return exportsMap.get(entity.name).some(
        exp => resolveExport(exp, symbolTables, includesGraph) === entity
    );
}

/**
 * Returns the global symbol at a position in an asm document: either an import, or a symbol that is
 * exported to the linker.
 */
async function getGlobalSymbolAt(uri: string, position: Position): Promise<GlobalSymbolAtResult | null> {
    const table = symbolTables.get(uri);
    if (!table) return null;
    const settings = await getDocumentSettings(uri);

    const ref = table.getReferenceAtPosition(position);
    if (!ref) {
        // On the definition itself (e.g. `.proc _foo` or `_foo:`), which is not a reference.
        const defined = table.getAllDefinedEntities().find(e => table.isPositionInRange(position, e.definition));
        return defined && isExportedEntity(defined)
            ? { name: defined.name, hasAsmDefinition: true }
            : null;
    }
    // `.proc _foo` names are recorded with 'scope' context; exported procs are linker-visible too.
    if (ref.context !== 'symbol' && ref.context !== 'scope') return null;
    const entity = resolveReference(ref, symbolTables, includesGraph, settings.implicitImports);

    if (entity instanceof Import) {
        return { name: entity.name, hasAsmDefinition: false };
    }
    if (!entity && ref.context === 'symbol' && (settings.implicitImports || isEmbeddedUri(uri)) && (ref.qualifiers.length === 0 || ref.qualifiers[0] === '')) {
        // Implicitly imported symbol that no asm file exports.
        return { name: ref.name, hasAsmDefinition: false };
    }
    if (entity && isExportedEntity(entity)) {
        return { name: entity.name, hasAsmDefinition: true };
    }
    return null;
}

/** All asm entities that stand for the global symbol `name`: its definition, or else every import. */
function getGlobalEntities(name: string): SymbolTableEntity[] {
    const definition = resolveImport(name, symbolTables, includesGraph);
    return definition ? [definition] : findRootImports(name);
}

/**
 * Uses of global symbol `name` in embedded inline-asm documents that no asm file defines (i.e. symbols
 * implemented in C). cc65 auto-imports these, so there is no `.import` entity to collect them from.
 */
function findEmbeddedUses(name: string): Location[] {
    const definition = resolveImport(name, symbolTables, includesGraph);
    const result: Location[] = [];
    for (const [uri, table] of symbolTables) {
        if (!isEmbeddedUri(uri)) continue;
        for (const ref of table.getReferencesByName(name)) {
            if (ref.context !== 'symbol') continue;
            if (ref.qualifiers.length > 0 && ref.qualifiers[0] !== '') continue;
            const resolved = resolveReference(ref, symbolTables, includesGraph, true);
            if (!resolved || resolved === definition) {
                result.push(Location.create(uri, ref.location));
            }
        }
    }
    return result;
}

async function collectGlobalLocations(name: string, documents: TextDocuments<TextDocument>): Promise<Location[]> {
    let locations: Location[] = findEmbeddedUses(name);
    for (const entity of getGlobalEntities(name)) {
        const settings = await getDocumentSettings(entity.uri);
        const code = getAllReferenceLocationsForEntity(entity, symbolTables, includesGraph, settings.implicitImports);
        const comments = await findCommentReferenceLocationsForEntity(
            entity, documents, symbolTables, includesGraph, settings.implicitImports, settings.cComments
        );
        locations = mergeUniqueLocations(locations, mergeUniqueLocations(code, comments));
        // Imports are declarations rather than references; make sure the `.import` itself is included.
        if (entity instanceof Import) {
            locations = mergeUniqueLocations(locations, [Location.create(entity.uri, entity.definition)]);
        }
    }
    return locations;
}

export function initializeCrossLanguageBridge(connection: _Connection, documents: TextDocuments<TextDocument>) {
    connection.onRequest('ca65/globalSymbolAt', async (params: { uri?: string; position?: Position }) => {
        await initializationGate.isInitialized;
        if (!params?.uri || !params.position) return null;
        await ensureDocumentRefreshed(params.uri);
        return getGlobalSymbolAt(params.uri, params.position);
    });

    connection.onRequest('ca65/lookupGlobal', async (params: { name?: string }): Promise<LookupGlobalResult | null> => {
        await initializationGate.isInitialized;
        const name = params?.name;
        if (!name) return null;
        await ensureDocumentRefreshed();

        const definition = resolveImport(name, symbolTables, includesGraph);
        const imported = findRootImports(name).length > 0 || findEmbeddedUses(name).length > 0;
        if (!definition && !imported) return null;

        let hoverMarkdown: string | undefined;
        if (definition) {
            const defDoc = await getCachedTextDocument(definition.uri, documents);
            if (defDoc) {
                const settings = await getDocumentSettings(definition.uri);
                hoverMarkdown = generateSymbolTableEntityMarkdown(
                    definition, defDoc, settings.implicitImports, settings.binIncludeDirs, settings
                );
            }
        }
        return {
            name,
            definitions: definition ? [Location.create(definition.uri, definition.definition)] : [],
            imported,
            hoverMarkdown,
        };
    });

    connection.onRequest('ca65/globalReferences', async (params: { name?: string }): Promise<Location[]> => {
        await initializationGate.isInitialized;
        if (!params?.name) return [];
        await ensureDocumentRefreshed();
        return collectGlobalLocations(params.name, documents);
    });

    // Parses a `ca65 -l` listing of a single generated file (cc65 output for the C assembly view) into
    // per-line address/bytes, reusing the listing parser of the hex listing view.
    connection.onRequest('ca65/parseListing', (params: { content?: string }) => {
        if (!params?.content) return [];
        const rootUri = 'listing:/generated.s';
        const lines = parseLstContent(params.content, rootUri, []).get(rootUri);
        if (!lines) return [];
        return Array.from(lines.values()).map(entry => ({
            line: entry.line,
            address: formatListingAddressLabel(entry),
            bytes: normalizeListingBytesText(entry.bytesText, entry.byteCount) ?? '',
            byteCount: entry.byteCount,
        }));
    });

    connection.onRequest('ca65/renameGlobal', async (params: { name?: string; newName?: string }): Promise<WorkspaceEdit | null> => {
        await initializationGate.isInitialized;
        if (!params?.name || !params.newName) return null;
        await ensureDocumentRefreshed();
        const locations = await collectGlobalLocations(params.name, documents);
        if (locations.length === 0) return null;
        const changes: { [uri: string]: TextEdit[] } = {};
        for (const loc of locations) {
            (changes[loc.uri] ??= []).push(TextEdit.replace(loc.range, params.newName));
        }
        return { changes };
    });
}
