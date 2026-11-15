import {
    Position,
    Range,
} from 'vscode-languageserver-types';
import { performanceMonitor } from './server';

const EMPTY_SYMBOLS: readonly Symbol[] = [];
const EMPTY_IMPORTS: readonly Import[] = [];
const EMPTY_SCOPES: readonly Scope[] = [];
const EMPTY_STRING_ARRAY: readonly string[] = Object.freeze([]);
const EMPTY_REFS: readonly ReferenceInfo[] = Object.freeze([]);
const ZERO_PAGE_SEGMENTS = new Set(['ZEROPAGE', 'ZP', 'DIRECTPAGE', 'DP']);

/**
 * Returns true if `segment` uses a standard zero-page or direct-page segment name.
 */
export function isZeroPageSegmentName(segment: string | null | undefined): boolean {
    if (!segment) return false;
    return ZERO_PAGE_SEGMENTS.has(segment.trim().toUpperCase());
}

export interface DocumentLinkDirective {
    line: number;
    startChar: number;
    endChar: number;
    filename: string;
    isBinary: boolean;
    resolvedUri?: string | null;
}

export class SymbolTableEntity {
    range: Range;
    private cachedScopeStack?: readonly string[];
    private cachedQualifiedName?: string;
    private cachedFullyQualifiedName?: string;

    constructor(
        public uri: string,
        public name: string,
        public definition: Range,
        public scope: Scope | null,
        public segment?: string | null
    ) {
        this.name = name;
        this.definition = definition;
        this.scope = scope;
        this.range = Range.create(definition.start, definition.end);
    }

    getFullyQualifiedName(): string {
        if (this.cachedFullyQualifiedName === undefined) {
            this.cachedFullyQualifiedName = `::${this.getQualifiedName()}`;
        }
        return this.cachedFullyQualifiedName;
    }

    getQualifiedName(): string {
        if (this.cachedQualifiedName === undefined) {
            const stack = this.getScopeStack();
            this.cachedQualifiedName = stack.length === 0
                ? this.name
                : `${stack.join('::')}::${this.name}`;
        }
        return this.cachedQualifiedName;
    }

    getScopeStack(): readonly string[] {
        if (this.cachedScopeStack !== undefined) {
            return this.cachedScopeStack;
        }
        if (!this.scope || this.scope.name === '') {
            this.cachedScopeStack = EMPTY_STRING_ARRAY;
            return this.cachedScopeStack;
        }

        const scopeStack: string[] = [];
        let scope: Scope | null = this.scope;
        while (scope && scope.name !== '') {
            scopeStack.push(scope.name);
            scope = scope.scope;
        }
        scopeStack.reverse();
        this.cachedScopeStack = scopeStack;
        return scopeStack;
    }
}

export enum SymbolKind {
    Label = "label",
    ResLabel = "res label",
    DataLabel = "data label",
    StringLabel = "string label",
    Constant = "constant",
    Variable = "variable",
    StructMember = "struct member",
    EnumMember = "enum member",
}

export class Symbol extends SymbolTableEntity {
    constructor(
        uri: string,
        public kind: SymbolKind,
        name: string,
        definition: Range,
        parentScope: Scope | null,
        public segment?: string,
    ) {
        super(uri, name, definition, parentScope);
        this.segment = segment;
    }
}

export enum ImportKind {
    Import = "import",
    Global = "global import"
}

export class Import extends SymbolTableEntity {
    constructor(
        uri: string,
        public kind: ImportKind,
        name: string,
        definition: Range,
        parentScope: Scope | null,
        public isZeroPage: boolean = false,
    ) {
        super(uri, name, definition, parentScope);
    }
}

export enum ExportKind {
    Export = "export",
    Global = "global export"
}

export class Export extends SymbolTableEntity {
    constructor(
        uri: string,
        public kind: ExportKind,
        name: string,
        definition: Range,
        parentScope: Scope | null,
        public isZeroPage: boolean = false,
    ) {
        super(uri, name, definition, parentScope);
    }
}

export enum ScopeKind {
    Scope = "scope",
    Proc = "proc",
    Struct = "struct",
    Union = "union",
    Enum = "enum",
}

export class Scope extends SymbolTableEntity {
    private symbols?: Map<string, Symbol>;
    private duplicateSymbols?: Symbol[];
    private imports?: Map<string, Import>;
    private duplicateImports?: Import[];
    private childScopes?: Map<string, Scope>;
    private orderedChildScopes?: Scope[];

    constructor(
        uri: string,
        public kind: ScopeKind,
        name: string,
        definition: Range,
        parentScope: Scope | null,
        public segment?: string,
        private readonly ownerTable?: SymbolTable,
    ) {
        super(uri, name, definition, parentScope, segment);
    }

    addSymbol(
        name: string,
        definition: Range,
        kind: SymbolKind,
        segment?: string
    ): Symbol {
        const symbol = new Symbol(this.uri, kind, name, definition, this, segment);
        if (!this.symbols) {
            this.symbols = new Map();
            this.symbols.set(name, symbol);
        } else if (!this.symbols.has(name)) {
            this.symbols.set(name, symbol);
        } else {
            (this.duplicateSymbols ??= []).push(symbol);
        }
        this.ownerTable?.invalidateDefinedEntities();
        return symbol;
    }

    addImport(
        name: string,
        definition: Range,
        kind: ImportKind,
        isZeroPage: boolean = false,
    ): Import {
        const importEntity = new Import(this.uri, kind, name, definition, this, isZeroPage);
        if (!this.imports) {
            this.imports = new Map();
            this.imports.set(name, importEntity);
        } else if (!this.imports.has(name)) {
            this.imports.set(name, importEntity);
        } else {
            (this.duplicateImports ??= []).push(importEntity);
        }
        return importEntity;
    }

    addChildScope(name: string, definition: Range, kind: ScopeKind, segment?: string): Scope {
        const scope = new Scope(this.uri, kind, name, definition, this, segment, this.ownerTable);
        if (!this.childScopes) {
            this.childScopes = new Map();
        }
        if (!this.childScopes.has(name)) {
            this.childScopes.set(name, scope);
        }
        (this.orderedChildScopes ??= []).push(scope);
        this.ownerTable?.invalidateDefinedEntities();
        return scope;
    }

    getSymbol(name: string): Symbol | undefined {
        return this.symbols?.get(name);
    }

    getSymbols(): Iterable<Symbol> {
        if (!this.symbols) return EMPTY_SYMBOLS;
        if (!this.duplicateSymbols) return this.symbols.values();
        return [...this.symbols.values(), ...this.duplicateSymbols];
    }

    getImport(name: string): Import | undefined {
        return this.imports?.get(name);
    }

    getImports(): Iterable<Import> {
        if (!this.imports) return EMPTY_IMPORTS;
        if (!this.duplicateImports) return this.imports.values();
        return [...this.imports.values(), ...this.duplicateImports];
    }

    getChildScope(name: string): Scope | undefined {
        return this.childScopes?.get(name);
    }

    getChildScopes(): Iterable<Scope> {
        return this.orderedChildScopes ?? EMPTY_SCOPES;
    }

    /**
     * Returns direct child scopes ordered monotonically by source start position.
     */
    getOrderedChildScopes(): readonly Scope[] {
        return this.orderedChildScopes ?? EMPTY_SCOPES;
    }

    private findName(
        name: string,
        qualifiers: readonly string[],
        context: ReferenceInfo['context'],
        allowImports: boolean
    ): SymbolTableEntity | undefined {
        let currentBaseScope: Scope | null = this;
        while (currentBaseScope) {
            if (!currentBaseScope.scope) {
                // Clip off the global scope qualifier if we're at the top.
                if (qualifiers[0]?.length === 0) {
                    qualifiers = qualifiers.slice(1);
                }
            }

            let nextScope: Scope | undefined = currentBaseScope;
            for (let i = 0; i < qualifiers.length; i++) {
                nextScope = nextScope.getChildScope(qualifiers[i]);
                if (!nextScope) break;
            }

            if (nextScope) {
                const resolvedScope = nextScope.getChildScope(name);
                if (
                    resolvedScope
                    && (
                        context === 'scope'
                        || context === 'sizeof'
                        || resolvedScope.kind === ScopeKind.Proc
                    )
                ) {
                    return resolvedScope;
                }

                const resolvedSymbol = nextScope.getSymbol(name);
                if (resolvedSymbol && (context === 'symbol' || context === 'sizeof')) {
                    return resolvedSymbol;
                }

                if (allowImports && context === 'symbol') {
                    const resolvedImport = nextScope.getImport(name);
                    if (resolvedImport) return resolvedImport;
                }
            }
            currentBaseScope = currentBaseScope.scope; // Walk up to the parent
        }
    }

    /**
     * Finds the shortest, unambiguous name for a given entity, relative to the current scope.
     * It does this by testing progressively more qualified names until one resolves back
     * to the original entity.
     */
    public findRelativeName(entity: SymbolTableEntity): string {
        // Macro is unaffected by scopes
        if (entity instanceof Macro) {
            return entity.name;
        }

        const name = entity.name;
        const entityScopeStack = entity.getScopeStack();
        const context: ReferenceInfo['context'] = entity instanceof Scope ? 'scope' : 'symbol';

        // Fast path for external top-level entities: only check unqualified collision in this file.
        if (entityScopeStack.length === 0 && entity.uri !== this.uri) {
            const resolvedEntity = this.findDefinitionOrImport(name, EMPTY_STRING_ARRAY, context);
            if (!resolvedEntity || resolvedEntity === entity) {
                return name;
            }
            return entity.getFullyQualifiedName();
        }

        // Test names from least qualified (just the name) to most qualified.
        let foundConflict = false;
        const stackLen = entityScopeStack.length;
        for (let i = 0; i <= stackLen; i++) {
            const testQualifiers = i === 0
                ? EMPTY_STRING_ARRAY
                : (i === stackLen ? entityScopeStack : entityScopeStack.slice(stackLen - i));
            const resolvedEntity = this.findDefinitionOrImport(name, testQualifiers, context);
            if (!resolvedEntity) continue;

            if (resolvedEntity === entity) {
                if (i === 0) return name;
                if (i === stackLen) return entity.getQualifiedName();
                return `${testQualifiers.join('::')}::${name}`;
            }

            foundConflict = true;
        }

        if (!foundConflict) {
            return entity.getQualifiedName();
        }

        return entity.getFullyQualifiedName();
    }

    findDefinitionOrImport(
        name: string,
        qualifiers: readonly string[],
        context: ReferenceInfo['context']
    ): SymbolTableEntity | undefined {
        return this.findName(name, qualifiers, context, true);
    }

    findDefinition(
        name: string,
        qualifiers: readonly string[],
        context: ReferenceInfo['context']
    ): SymbolTableEntity | undefined {
        return this.findName(name, qualifiers, context, false);
    }
}

export enum MacroKind {
    Macro = "macro",
    Define = "define",
}

export class Macro extends SymbolTableEntity {
    constructor(
        uri: string,
        public kind: MacroKind,
        name: string,
        definition: Range,
        public params: string[] = [],
    ) {
        super(uri, name, definition, null);
    }
}

export class ReferenceInfo {
    constructor(
        public uri: string,
        public name: string,
        public qualifiers: readonly string[], // Partially qualified parts of the referenced name
        public context: 'symbol' | 'scope' | 'macro' | 'sizeof',
        public location: Range,
        public scope: Scope,
        // Effective calling entity for call hierarchy analysis.
        public callingEntity?: SymbolTableEntity,
    ) {}
}

function comparePosToStart(position: Position, start: Position): number {
    if (position.line !== start.line) return position.line - start.line;
    return position.character - start.character;
}

/**
 * The main container for all parsed information for a file.
 */
export class SymbolTable {
    private rootScope: Scope;
    private macros: Map<string, Macro> = new Map();
    private cachedDefinedEntities: SymbolTableEntity[] | null = null;

    public references: ReferenceInfo[] = [];
    private referencesByName: Map<string, ReferenceInfo[]> = new Map();
    private referencesByLine: Map<number, ReferenceInfo[]> = new Map();
    private referencesByCaller?: Map<SymbolTableEntity, ReferenceInfo[]>;

    public includedFiles: string[] = [];
    public unresolvedIncludes: string[] = [];
    public documentLinkDirectives: DocumentLinkDirective[] = [];

    public anonymousLabelLines: number[] = [];
    public anonymousLabelReferences: Map<number, Range[]> = new Map();

    public imports: Import[] = [];
    public exports: Export[] = [];
    private cachedImportNames?: Set<string>;
    private cachedImportCount = -1;
    private cachedExportNames?: Set<string>;
    private cachedExportCount = -1;

    constructor(public uri: string) {
        this.rootScope = new Scope(
            uri,
            ScopeKind.Scope,
            '',
            {
                start: { line: 0, character: 0 },
                end: { line: 0, character: 0 },
            },
            null,
            undefined,
            this,
        );
    }

    public hasImport(name: string): boolean {
        if (this.imports.length === 0) return false;
        if (!this.cachedImportNames || this.cachedImportCount !== this.imports.length) {
            const set = new Set<string>();
            for (const imp of this.imports) set.add(imp.name);
            this.cachedImportNames = set;
            this.cachedImportCount = this.imports.length;
        }
        return this.cachedImportNames.has(name);
    }

    public hasExport(name: string): boolean {
        if (this.exports.length === 0) return false;
        if (!this.cachedExportNames || this.cachedExportCount !== this.exports.length) {
            const set = new Set<string>();
            for (const exp of this.exports) set.add(exp.name);
            this.cachedExportNames = set;
            this.cachedExportCount = this.exports.length;
        }
        return this.cachedExportNames.has(name);
    }

    public invalidateDefinedEntities(): void {
        if (this.cachedDefinedEntities !== null) {
            this.cachedDefinedEntities = null;
        }
    }

    getUri(): string {
        return this.uri;
    }

    getRootScope(): Scope {
        return this.rootScope;
    }

    addMacro(
        name: string,
        definition: Range,
        kind: MacroKind,
        params: string[] = [],
    ): Macro {
        const macro = new Macro(this.uri, kind, name, definition, params);
        this.macros.set(name, macro);
        this.invalidateDefinedEntities();
        return macro;
    }

    getMacro(name: string): Macro | undefined {
        return this.macros.get(name);
    }

    getAllMacros(): Macro[] {
        return Array.from(this.macros.values());
    }

    /**
     * Adds a record of a symbol/scope/macro usage found during parsing.
     */
    public addReference(info: ReferenceInfo): void {
        this.references.push(info);

        let byName = this.referencesByName.get(info.name);
        if (!byName) {
            byName = [];
            this.referencesByName.set(info.name, byName);
        }
        byName.push(info);

        const line = info.location.start.line;
        let byLine = this.referencesByLine.get(line);
        if (!byLine) {
            byLine = [];
            this.referencesByLine.set(line, byLine);
        }
        byLine.push(info);

        if (info.callingEntity) {
            this.referencesByCaller ??= new Map();
            let byCaller = this.referencesByCaller.get(info.callingEntity);
            if (!byCaller) {
                byCaller = [];
                this.referencesByCaller.set(info.callingEntity, byCaller);
            }
            byCaller.push(info);
        }
    }

    public getReferencesByName(name: string): ReferenceInfo[] {
        return this.referencesByName.get(name) || [];
    }

    public getReferencesOnLine(line: number): ReferenceInfo[] {
        return this.referencesByLine.get(line) || [];
    }

    public getReferencesByCaller(caller: SymbolTableEntity): readonly ReferenceInfo[] {
        return this.referencesByCaller?.get(caller) ?? EMPTY_REFS;
    }

    /**
     * Traverses the scope tree once to collect all defined items (cached until mutated).
     * @returns Flat list of all symbols, scopes, and macros (excluding imports and exports).
     */
    getAllDefinedEntities(): SymbolTableEntity[] {
        if (this.cachedDefinedEntities) {
            return this.cachedDefinedEntities;
        }

        const out: SymbolTableEntity[] = [];

        function traverse(scope: Scope) {
            if (scope.name !== '') {
                out.push(scope);
            }
            for (const sym of scope.getSymbols()) {
                out.push(sym);
            }
            for (const child of scope.getOrderedChildScopes()) {
                traverse(child);
            }
        }

        traverse(this.rootScope);
        for (const macro of this.macros.values()) {
            out.push(macro);
        }

        this.cachedDefinedEntities = out;
        return out;
    }

    getAllReferences(): ReferenceInfo[] {
        return this.references;
    }

    getReferenceAtPosition(position: Position): ReferenceInfo | null {
        return performanceMonitor.time('getReferenceAtPosition', () => {
            const lineRefs = this.referencesByLine.get(position.line);
            if (lineRefs) {
                for (const reference of lineRefs) {
                    if (this.isPositionInRange(position, reference.location)) {
                        return reference;
                    }
                }
            }
            return null;
        });
    }

    isPositionInRange(position: Position, range: Range): boolean {
        if (position.line < range.start.line || position.line > range.end.line) {
            return false;
        }
        if (position.line === range.start.line && position.character < range.start.character) {
            return false;
        }
        if (position.line === range.end.line && position.character > range.end.character) {
            return false;
        }
        return true;
    }

    /**
     * Finds the innermost scope containing a given position using binary search across sibling scopes.
     */
    getScopeAtPosition(position: Position, scope: Scope = this.rootScope): Scope | undefined {
        if (!this.isPositionInRange(position, scope.range)) return undefined;

        let current: Scope = scope;
        while (true) {
            const children = current.getOrderedChildScopes();
            if (children.length === 0) {
                return current;
            }

            // Find the rightmost child whose start <= position.
            let lo = 0;
            let hi = children.length - 1;
            let candidateIdx = -1;
            while (lo <= hi) {
                const mid = (lo + hi) >>> 1;
                if (comparePosToStart(position, children[mid].range.start) >= 0) {
                    candidateIdx = mid;
                    lo = mid + 1;
                } else {
                    hi = mid - 1;
                }
            }

            if (candidateIdx >= 0 && this.isPositionInRange(position, children[candidateIdx].range)) {
                current = children[candidateIdx];
            } else {
                return current;
            }
        }
    }

    /**
     * Format the entire symbol table: scopes, symbols, macros, and references.
     */
    toString(): string {
        const lines: string[] = [`=== Symbol Table Dump for ${this.uri} ===`];

        const traverseScope = (scope: Scope, indent = 0) => {
            const pad = '  '.repeat(indent);
            const name = scope.name || '<root>';
            lines.push(`${pad} - Scope: ${name} [${scope.kind}] (${scope.range.start.line}:${scope.range.start.character} - ${scope.range.end.line}:${scope.range.end.character})`);

            for (const sym of scope.getSymbols()) {
                lines.push(`${pad}  * Symbol: ${sym.name} [${sym.kind}] (${sym.range.start.line}:${sym.range.start.character} - ${sym.range.end.line}:${sym.range.end.character})${sym.segment ? ' Segment: ' + sym.segment : ''}`);
            }

            for (const child of scope.getOrderedChildScopes()) {
                traverseScope(child, indent + 1);
            }
        };

        traverseScope(this.getRootScope());

        if (this.includedFiles.length > 0) {
            lines.push('\n --- Included Files ---');
            for (const file of this.includedFiles) {
                lines.push(`  * ${file}`);
            }
        }

        if (this.macros.size > 0) {
            lines.push('\n --- Macros ---');
            for (const macro of this.macros.values()) {
                lines.push(`  * Macro: ${macro.name} [${macro.kind}] (${macro.range.start.line}:${macro.range.start.character} - ${macro.range.end.line}:${macro.range.end.character})`);
            }
        }

        if (this.references.length > 0) {
            lines.push('\n --- References ---');
            for (const ref of this.references) {
                const qualifiers = [...ref.qualifiers, ref.name].join('::');
                const scopeStr = ref.scope ? `${ref.scope.getFullyQualifiedName()}` : 'null';
                lines.push(`  * Context: ${ref.context}, Qualified Name: ${qualifiers}, Scope: ${scopeStr}, Location: (${ref.location.start.line}:${ref.location.start.character} - ${ref.location.end.line}:${ref.location.end.character}), Calling Entity: (${ref.callingEntity ? ref.callingEntity.getFullyQualifiedName() : 'undefined'})`);
            }
        }

        lines.push('=== End of Symbol Table Dump ===');
        return lines.join('\n') + '\n';
    }
}
