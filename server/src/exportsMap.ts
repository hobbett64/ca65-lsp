import { Export } from "./symbolTable";

const EMPTY_EXPORTS: Export[] = [];

function exportsEquivalent(a: Export, b: Export): boolean {
    return a.name === b.name
        && a.kind === b.kind
        && a.isZeroPage === b.isZeroPage
        && a.definition.start.line === b.definition.start.line
        && a.definition.start.character === b.definition.start.character;
}

export class ExportsMap {
    /** Per-URI export maps */
    private perUri: Map<string, Map<string, Export>> = new Map();

    /** Global view: baseName -> stack of exports */
    private global: Map<string, Export[]> = new Map();

    /**
     * Update the exports for a given URI.
     * Replaces the old exports from that URI with the new set, returning true if the export signatures changed.
     */
    updateExports(uri: string, newExports: Export[]): boolean {
        const oldMap = this.perUri.get(uri);

        if (!oldMap && newExports.length === 0) {
            return false;
        }

        if (newExports.length === 0 && oldMap) {
            for (const [baseName, exp] of oldMap) {
                this.removeFromGlobal(baseName, exp);
            }
            this.perUri.delete(uri);
            return true;
        }

        // Fast equality check: if names, kinds, zero-page flags, and lines all match, swap refs in-place if needed.
        if (oldMap && oldMap.size === newExports.length) {
            let allMatch = true;
            for (const exp of newExports) {
                const prev = oldMap.get(exp.name);
                if (!prev || !exportsEquivalent(prev, exp)) {
                    allMatch = false;
                    break;
                }
            }
            if (allMatch) {
                for (const exp of newExports) {
                    const prev = oldMap.get(exp.name)!;
                    if (prev !== exp) {
                        oldMap.set(exp.name, exp);
                        this.replaceInGlobal(exp.name, prev, exp);
                    }
                }
                return false;
            }
        }

        const newMap = new Map<string, Export>();
        for (const exp of newExports) {
            newMap.set(exp.name, exp);
        }

        // Remove exports no longer present and update retained names in place.
        if (oldMap) {
            for (const [baseName, prev] of oldMap) {
                const next = newMap.get(baseName);
                if (!next) {
                    this.removeFromGlobal(baseName, prev);
                } else {
                    this.replaceInGlobal(baseName, prev, next);
                }
            }
        }

        // Add newly introduced exports
        for (const [baseName, next] of newMap) {
            if (!oldMap || !oldMap.has(baseName)) {
                this.addToGlobal(baseName, next);
            }
        }

        this.perUri.set(uri, newMap);
        return true;
    }

    /**
     * Remove all exports for a given URI.
     */
    removeUri(uri: string): void {
        const oldMap = this.perUri.get(uri);
        if (!oldMap) return;

        for (const [baseName, exp] of oldMap) {
            this.removeFromGlobal(baseName, exp);
        }
        this.perUri.delete(uri);
    }

    /**
     * Get the "active" list of exports by base name.
     */
    get(baseName: string): Export[] {
        return this.global.get(baseName) ?? EMPTY_EXPORTS;
    }

    // --- Internals ---

    private addToGlobal(baseName: string, exp: Export) {
        let stack = this.global.get(baseName);
        if (!stack) {
            stack = [];
            this.global.set(baseName, stack);
        }
        stack.push(exp);
    }

    private replaceInGlobal(baseName: string, prev: Export, next: Export) {
        const stack = this.global.get(baseName);
        if (!stack) {
            this.addToGlobal(baseName, next);
            return;
        }
        const idx = stack.lastIndexOf(prev);
        if (idx >= 0) {
            stack[idx] = next;
        } else {
            stack.push(next);
        }
    }

    private removeFromGlobal(baseName: string, exp: Export) {
        const stack = this.global.get(baseName);
        if (!stack) return;
        const idx = stack.lastIndexOf(exp);
        if (idx >= 0) stack.splice(idx, 1);
        if (stack.length === 0) {
            this.global.delete(baseName);
        }
    }

    toString(): string {
        const lines: string[] = ['--- Exports Map Dump ---'];
        for (const [baseName, stack] of this.global) {
            if (stack.length === 0) continue;
            lines.push(`* ${baseName}:`);
            for (let i = stack.length - 1; i >= 0; i--) {
                const exp = stack[i];
                lines.push(`    - ${exp.name} (URI: ${exp.uri}, line ${exp.definition.start.line})`);
            }
        }
        return lines.join('\n') + '\n';
    }
}
