
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

export class IncludesGraph {
    private nodes: Map<string, FileNode> = new Map();
    private translationUnitCache: Map<string, readonly string[]> = new Map();

    private getOrCreateNode(uri: string): FileNode {
        if (!this.nodes.has(uri)) {
            this.nodes.set(uri, new FileNode(uri));
        }
        return this.nodes.get(uri)!;
    }

    public updateIncludes(uri: string, newIncludeUris: string[]) {
        const sourceNode = this.getOrCreateNode(uri);
        const oldIncludes = sourceNode.includes;
        const newIncludes = new Set(
            newIncludeUris.map(depUri => this.getOrCreateNode(depUri))
        );

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
        // The loop will check every file that depends on the given uri,
        // including the file itself.
        for (const dependentUri of this.getTransitiveDependents(uri)) {
            const node = this.nodes.get(dependentUri);
            // A node is a root if nothing includes it.
            if (node && node.includedBy.size === 0) {
                yield node.uri;
            }
        }
    }

    public getTranslationUnit(uri: string): readonly string[] {
        const cached = this.translationUnitCache.get(uri);
        if (cached) {
            return cached;
        }

        const visitedUris = new Set<string>();
        const result: string[] = [];
        for (const root of this.getIncludingRoots(uri)) {
            for (const dependencyUri of this.getTransitiveDependencies(root)) {
                if (!visitedUris.has(dependencyUri)) {
                    visitedUris.add(dependencyUri);
                    result.push(dependencyUri);
                }
            }
        }
        // Fallback if an include cycle leaves no root with in-degree 0
        if (result.length === 0 && this.nodes.has(uri)) {
            for (const dependencyUri of this.getTransitiveDependencies(uri)) {
                if (!visitedUris.has(dependencyUri)) {
                    visitedUris.add(dependencyUri);
                    result.push(dependencyUri);
                }
            }
        }

        this.translationUnitCache.set(uri, result);
        return result;
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

