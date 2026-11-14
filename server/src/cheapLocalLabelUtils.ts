import { Location, Position, Range } from 'vscode-languageserver-types';
import { TextDocument } from 'vscode-languageserver-textdocument';
import { findCommentStart } from './documentScanner';

export const CHEAP_LOCAL_BOUNDARY_REGEX = /^\s*(?:[a-zA-Z_.][a-zA-Z0-9_@.]*:(?![:=<>+-])|\.(?:proc|struct|union)\b)/i;
const CHEAP_LOCAL_DEF_LINE_REGEX = /^\s*(@[a-zA-Z0-9_@.]+):/;
const CHEAP_LOCAL_TOKEN_REGEX = /(?<![a-zA-Z0-9_@.])@[a-zA-Z0-9_@.]+(?![a-zA-Z0-9_@.])/g;

function escapeRegExp(str: string): string {
    return str.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

export const CHEAP_LOCAL_DEF_REGEX = (name: string) => new RegExp(`^\\s*${escapeRegExp(name)}:`);

function getCodeLine(document: TextDocument, line: number): string {
    const raw = document.getText(Range.create(line, 0, line + 1, 0)).replace(/\r?\n$/, '');
    const commentIdx = findCommentStart(raw);
    return commentIdx >= 0 ? raw.slice(0, commentIdx) : raw;
}

/**
 * Finds the previous boundary for a cheap local label.
 * @param document The document to scan.
 * @param startLine The line to start scanning backwards from.
 * @returns The line number of the parent boundary, or -1 if none.
 */
export function findPreviousCheapLocalBoundary(document: TextDocument, startLine: number): number {
    for (let i = startLine; i >= 0; i--) {
        if (CHEAP_LOCAL_BOUNDARY_REGEX.test(getCodeLine(document, i))) {
            return i;
        }
    }
    return -1; // No boundary found, implies global scope from the top of the file
}

function getCheapLocalScopeBounds(document: TextDocument, line: number): { startLine: number; endLine: number } {
    const boundaryLine = findPreviousCheapLocalBoundary(document, line);
    const startLine = boundaryLine === -1 ? 0 : boundaryLine;
    let endLine = document.lineCount - 1;
    for (let i = startLine + 1; i < document.lineCount; i++) {
        if (CHEAP_LOCAL_BOUNDARY_REGEX.test(getCodeLine(document, i))) {
            endLine = i - 1;
            break;
        }
    }
    return { startLine, endLine };
}

/**
 * Returns the cheap local label name under the cursor, or null if none.
 */
export function findCheapLocalLabelAtPosition(document: TextDocument, position: Position): string | null {
    const codeLine = getCodeLine(document, position.line);
    CHEAP_LOCAL_TOKEN_REGEX.lastIndex = 0;
    let match: RegExpExecArray | null;
    while ((match = CHEAP_LOCAL_TOKEN_REGEX.exec(codeLine)) !== null) {
        const start = match.index;
        const end = start + match[0].length;
        if (position.character >= start && position.character <= end) {
            return match[0];
        }
    }
    return null;
}

/**
 * Lists all cheap local label definitions visible in the cheap local scope at `position`.
 */
export function getCheapLocalLabelDefinitions(document: TextDocument, position: Position): string[] {
    const { startLine, endLine } = getCheapLocalScopeBounds(document, position.line);
    const labels: string[] = [];
    for (let i = startLine; i <= endLine; i++) {
        const match = getCodeLine(document, i).match(CHEAP_LOCAL_DEF_LINE_REGEX);
        if (match) {
            labels.push(match[1]);
        }
    }
    return labels;
}

/**
 * Finds the definition of a cheap local label by scanning within its enclosing cheap local scope.
 */
export function findCheapLocalLabelDefinition(document: TextDocument, position: Position, name: string): Location | null {
    const { startLine, endLine } = getCheapLocalScopeBounds(document, position.line);
    const defRegex = CHEAP_LOCAL_DEF_REGEX(name);

    for (let i = startLine; i <= endLine; i++) {
        const codeLine = getCodeLine(document, i);
        if (defRegex.test(codeLine)) {
            const startChar = codeLine.indexOf(name);
            const endChar = startChar + name.length;
            return Location.create(document.uri, Range.create(i, startChar, i, endChar));
        }
    }

    return null;
}

/**
 * Finds all references to the cheap local label at `position`.
 */
export function findAllCheapLocalLabelReferences(
    document: TextDocument,
    position: Position
): Location[] {
    const name = findCheapLocalLabelAtPosition(document, position);
    if (!name) {
        return [];
    }

    const { startLine, endLine } = getCheapLocalScopeBounds(document, position.line);
    const defRegex = CHEAP_LOCAL_DEF_REGEX(name);
    const referenceRegex = new RegExp(`(?<![a-zA-Z0-9_@.])${escapeRegExp(name)}(?![a-zA-Z0-9_@.])`, 'g');

    let hasDefinition = false;
    const locations: Location[] = [];

    for (let i = startLine; i <= endLine; i++) {
        const codeLine = getCodeLine(document, i);
        if (defRegex.test(codeLine)) {
            hasDefinition = true;
        }
        referenceRegex.lastIndex = 0;
        let match: RegExpExecArray | null;
        while ((match = referenceRegex.exec(codeLine)) !== null) {
            locations.push(Location.create(document.uri, Range.create(i, match.index, i, match.index + name.length)));
        }
    }

    return hasDefinition ? locations : [];
}
