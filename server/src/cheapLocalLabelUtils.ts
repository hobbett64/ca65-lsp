import { TextDocument, Location, Position, Range } from 'vscode-languageserver-types';

export const CHEAP_LOCAL_BOUNDARY_REGEX = /^\s*([a-zA-Z_.][a-zA-Z0-9_@.]*:|\.(proc|struct|union))/;

function escapeRegExp(str: string): string {
    return str.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

export const CHEAP_LOCAL_DEF_REGEX = (name: string) => new RegExp(`^\\s*${escapeRegExp(name)}:`);

/**
 * Finds the previous boundary for a cheap local label.
 * @param document The document to scan.
 * @param startLine The line to start scanning backwards from.
 * @returns The line number of the parent boundary.
 */
export function findPreviousCheapLocalBoundary(document: TextDocument, startLine: number): number {
    for (let i = startLine; i >= 0; i--) {
        const line = document.getText(Range.create(i, 0, i + 1, 0)).replace(/\r?\n$/, '');
        if (CHEAP_LOCAL_BOUNDARY_REGEX.test(line)) {
            return i;
        }
    }
    return -1; // No boundary found, implies global scope from the top of the file
}

/**
 * Finds the definition of a cheap local label by scanning from a reference.
 * @param document The document to scan.
 * @param position The position of the reference.
 * @param name The name of the cheap local label (e.g., "@loop").
 * @returns The Location of the definition, or null if not found.
 */
export function findCheapLocalLabelDefinition(document: TextDocument, position: Position, name: string): Location | null {
    const boundaryLine = findPreviousCheapLocalBoundary(document, position.line);
    const startLine = boundaryLine === -1 ? 0 : boundaryLine;
    const defRegex = CHEAP_LOCAL_DEF_REGEX(name);

    // Scan forward from the boundary to find the definition
    for (let i = startLine; i < document.lineCount; i++) {
        const line = document.getText(Range.create(i, 0, i + 1, 0)).replace(/\r?\n$/, '');
        
        // Stop if we hit another parent boundary before finding the definition
        if (i > startLine && CHEAP_LOCAL_BOUNDARY_REGEX.test(line)) {
            return null;
        }
        
        if (defRegex.test(line)) {
            const startChar = line.indexOf(name);
            const endChar = startChar + name.length;
            return Location.create(document.uri, Range.create(i, startChar, i, endChar));
        }
    }

    return null;
}

/**
 * Finds all references to a specific cheap local label.
 * @param document The document to scan.
 * @param position The position of the cheap local label to find references for.
 * @returns An array of Locations for all references.
 */
export function findAllCheapLocalLabelReferences(
    document: TextDocument,
    position: Position
): Location[] {
    const lineText = document.getText(Range.create(position.line, 0, position.line + 1, 0));
    const cheapLocalLabelRegex = /@[a-zA-Z0-9_@.]+/g;
    let match;
    let name: string | null = null;

    // First, find the name of the symbol at the cursor
    while ((match = cheapLocalLabelRegex.exec(lineText)) !== null) {
        const start = match.index!;
        const end = start + match[0].length;
        if (position.character >= start && position.character <= end) {
            name = match[0];
            break;
        }
    }

    if (!name) {
        return [];
    }

    const definition = findCheapLocalLabelDefinition(document, position, name);
    if (!definition) {
        return [];
    }

    const locations: Location[] = [];
    const referenceRegex = new RegExp(`${escapeRegExp(name)}\\b`, 'g');
    const boundaryLine = findPreviousCheapLocalBoundary(document, definition.range.start.line);
    const startLine = boundaryLine === -1 ? 0 : boundaryLine;

    let endLine = document.lineCount - 1;
    for (let i = startLine + 1; i < document.lineCount; i++) {
        const line = document.getText(Range.create(i, 0, i + 1, 0));
        if (CHEAP_LOCAL_BOUNDARY_REGEX.test(line)) {
            endLine = i - 1;
            break;
        }
    }

    // Scan within the determined range for all references
    for (let i = startLine; i <= endLine; i++) {
        const line = document.getText(Range.create(i, 0, i + 1, 0));
        while ((match = referenceRegex.exec(line)) !== null) {
            locations.push(Location.create(document.uri, Range.create(i, match.index, i, match.index + name.length)));
        }
    }

    return locations;
}
