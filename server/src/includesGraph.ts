class FileNode {
  uri: string;
  includes: Set<FileNode>;   // Files that this file includes
  includedBy: Set<FileNode>; // Files that include this file

  constructor(uri: string) {
    this.uri = uri;
    this.includedBy = new Set();
    this.includes = new Set();
  }
}

interface TranslationUnitCacheEntry {
    uris: readonly string[];
    uriSet: ReadonlySet<string>;
}

const EMPTY_URI_ARRAY: readonly string[] = Object.freeze([]);
const EMPTY_URI_SET: ReadonlySet<string> = new Set();

export class IncludesGraph {
    private nodes: Map<string, FileNode> = new Map();
    private translationUnitCache: Map<string, TranslationUnitCacheEntry> = new Map();
    private includingRootsCache: Map<string, readonly string[]> = new Map();

    private getOrCreateNode(uri: string): FileNode {
        let node = this.nodes.get(uri);
        if (!node) {
            node = new FileNode(uri);
            this.nodes.set(uri, node);
        }
        return node;
    }

    public updateIncludes(uri: string, newIncludeUris: string[]): void {
        const sourceNode = this.getOrCreateNode(uri);
        const oldIncludes = sourceNode.includes;
        const newIncludes = new Set<FileNode>();
        for (const depUri of newIncludeUris) {
            newIncludes.add(this.getOrCreateNode(depUri));
        }

        let changed = oldIncludes.size !== newIncludes.size;
        if (!changed) {
            for (const dep of newIncludes) {
                if (!oldIncludes.has(dep)) {
                    changed = true;
                    break;
                }
            }
        }
        if (!changed) return;

        for (const oldInclude of oldIncludes) {
            if (!newIncludes.has(oldInclude)) {
                oldInclude.includedBy.delete(sourceNode);
            }
        }

        for (const newInclude of newIncludes) {
            if (!oldIncludes.has(newInclude)) {
                newInclude.includedBy.add(sourceNode);
            }
        }

        sourceNode.includes = newIncludes;
        this.translationUnitCache.clear();
        this.includingRootsCache.clear();
    }

    // -----------------------------
    // Traversal helpers as generators
    // -----------------------------

    public *getTransitiveDependencies(uri: string): Generator<string> {
        yield* this.getTransitiveLinks(uri, 'includes');
    }

    public *getTransitiveDependents(uri: string): Generator<string> {
        yield* this.getTransitiveLinks(uri, 'includedBy');
    }

    public *getAllTranslationUnitRoots(): Generator<string> {
        for (const [uri, node] of this.nodes) {
            if (node.includedBy.size === 0) yield uri;
        }
    }

    public *getIncludingRoots(uri: string): Generator<string> {
        yield* this.getIncludingRootsArray(uri);
    }

    /**
     * Returns all root files (in-degree 0) that transitively include `uri`, cached until graph changes.
     */
    public getIncludingRootsArray(uri: string): readonly string[] {
        const cached = this.includingRootsCache.get(uri);
        if (cached) return cached;

        const startNode = this.nodes.get(uri);
        if (!startNode) return EMPTY_URI_ARRAY;

        const roots: string[] = [];
        const visited = new Set<FileNode>();
        const stack: FileNode[] = [startNode];

        while (stack.length > 0) {
            const node = stack.pop()!;
            if (visited.has(node)) continue;
            visited.add(node);

            if (node.includedBy.size === 0) {
                roots.push(node.uri);
            } else {
                for (const parent of node.includedBy) {
                    if (!visited.has(parent)) {
                        stack.push(parent);
                    }
                }
            }
        }

        const result = roots.length === 0 ? EMPTY_URI_ARRAY : roots;
        this.includingRootsCache.set(uri, result);
        return result;
    }

    private getTranslationUnitEntry(uri: string): TranslationUnitCacheEntry {
        const cached = this.translationUnitCache.get(uri);
        if (cached) return cached;

        const startNode = this.nodes.get(uri);
        if (!startNode) {
            return { uris: EMPTY_URI_ARRAY, uriSet: EMPTY_URI_SET };
        }

        const visitedNodes = new Set<FileNode>();
        const uriSet = new Set<string>();
        const uris: string[] = [];

        const pushSubtree = (rootNode: FileNode) => {
            const stack: FileNode[] = [rootNode];
            while (stack.length > 0) {
                const node = stack.pop()!;
                if (visitedNodes.has(node)) continue;
                visitedNodes.add(node);
                uriSet.add(node.uri);
                uris.push(node.uri);
                for (const dep of node.includes) {
                    if (!visitedNodes.has(dep)) {
                        stack.push(dep);
                    }
                }
            }
        };

        const roots = this.getIncludingRootsArray(uri);
        for (const rootUri of roots) {
            const rootNode = this.nodes.get(rootUri);
            if (rootNode) {
                pushSubtree(rootNode);
            }
        }

        // Fallback if an include cycle leaves no root with in-degree 0
        if (uris.length === 0) {
            pushSubtree(startNode);
        }

        const entry: TranslationUnitCacheEntry = { uris, uriSet };
        this.translationUnitCache.set(uri, entry);
        return entry;
    }

    public getTranslationUnit(uri: string): readonly string[] {
        return this.getTranslationUnitEntry(uri).uris;
    }

    /**
     * Returns a cached ReadonlySet of all URIs in `uri`'s translation unit(s) for O(1) membership checks.
     */
    public getTranslationUnitSet(uri: string): ReadonlySet<string> {
        return this.getTranslationUnitEntry(uri).uriSet;
    }

    public isTranslationUnitRoot(uri: string): boolean {
        const node = this.nodes.get(uri);
        if (!node) return false;
        return node.includedBy.size === 0;
    }

    private *getTransitiveLinks(
        uri: string,
        direction: 'includes' | 'includedBy'
    ): Generator<string> {
        const startNode = this.nodes.get(uri);
        if (!startNode) return;

        const visited = new Set<FileNode>();
        const stack = [startNode]; // Use an iterative approach to avoid deep recursion

        while (stack.length > 0) {
            const node = stack.pop()!;
            if (visited.has(node)) continue;
            yield node.uri;
            visited.add(node);

            for (const nextNode of node[direction]) {
                stack.push(nextNode);
            }
        }
    }

    public removeFile(uri: string): void {
        const nodeToRemove = this.nodes.get(uri);
        if (!nodeToRemove) return;

        for (const dependencyNode of nodeToRemove.includedBy) {
            dependencyNode.includes.delete(nodeToRemove);
        }

        for (const dependentNode of nodeToRemove.includes) {
            dependentNode.includedBy.delete(nodeToRemove);
        }

        this.nodes.delete(uri);
        this.translationUnitCache.clear();
        this.includingRootsCache.clear();
    }

    public toString(): string {
        let result = ['=== Includes Graph ==='];
        for (const [uri, fileNode] of this.nodes) {
            result.push(`\t- ${uri}`);
            result.push(`\t\t- Dependencies`);
            for (const dependency of fileNode.includes) {
                result.push(`\t\t\t- ${dependency.uri}`);
            }
            result.push(`\t\t- Dependents`);
            for (const dependent of fileNode.includedBy) {
                result.push(`\t\t\t- ${dependent.uri}`);
            }
        }
        return result.join('\n') + '\n';
    }
}
