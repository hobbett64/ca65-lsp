import { Position, Range, TextEdit } from 'vscode-languageserver-types';
import { TextDocument } from 'vscode-languageserver-textdocument';
import { Ca65Settings } from './settings';

/**
 * Returns the text of a single 0-based line without trailing CR/LF characters.
 */
export function getLineText(document: TextDocument, line: number): string {
    if (line < 0 || line >= document.lineCount) {
        return '';
    }
    const endLine = line + 1 < document.lineCount ? line + 1 : line;
    const endChar = line + 1 < document.lineCount ? 0 : 0x7fffffff;
    return document.getText(Range.create(line, 0, endLine, endChar)).replace(/\r?\n$/, '');
}

/**
 * Returns true if the given file extension is eligible for `.include` auto-insertion.
 */
export function isAutoIncludable(uri: string, settings: Ca65Settings): boolean {
    if (settings.autoIncludeExtensions) {
        for (const ext of settings.autoIncludeExtensions) {
            if (uri.endsWith(ext)) return true;
        }
    }
    return false;
}

function skipCommentBlock(lines: string[]): number {
    let top = 0;
    let foundComment = false;
    while (top < lines.length && lines[top].trim().startsWith(';')) {
        foundComment = true;
        top++;
    }
    if (foundComment && top < lines.length && lines[top].trim().length === 0) {
        top++;
    }
    return top;
}

function skipDirectiveBlock(lines: string[], startLine: number, directivePrefix: string): number {
    let top = startLine;
    let found = false;
    while (top < lines.length && lines[top].trim().toLowerCase().startsWith(directivePrefix)) {
        found = true;
        top++;
    }
    if (found && top < lines.length && lines[top].trim().length === 0) {
        top++;
    }
    return top;
}

function insertIntoSortedBlock(
    lines: string[],
    startLine: number,
    directivePrefix: string,
    newLine: string,
    extractSortKey: (trimmedLine: string) => string,
    newSortKey: string,
): TextEdit {
    let insertAt = startLine;
    while (insertAt < lines.length && lines[insertAt].trim().toLowerCase().startsWith(directivePrefix)) {
        const existingKey = extractSortKey(lines[insertAt].trim());
        if (existingKey < newSortKey) {
            insertAt++;
        } else {
            break;
        }
    }

    // Add empty space if we're at the end of the block and the following line has content.
    const trimmedLine = insertAt < lines.length ? lines[insertAt].trim().toLowerCase() : '';
    if (trimmedLine && !trimmedLine.startsWith(directivePrefix)) {
        newLine += '\n';
    }

    return TextEdit.insert(Position.create(insertAt, 0), newLine);
}

/**
 * Builds a sorted `.include` edit near the top of the document.
 */
export function makeIncludeEdit(
    document: TextDocument,
    includePath: string
): TextEdit {
    const lines = document.getText().split(/\r?\n/);
    const top = skipCommentBlock(lines);
    return insertIntoSortedBlock(
        lines,
        top,
        '.include',
        `.include "${includePath}"\n`,
        line => line.slice(8).trim().replace(/^"|"$/g, ''),
        includePath
    );
}

/**
 * Builds a sorted `.import` or `.importzp` edit after leading comments and `.include` statements.
 */
export function makeImportEdit(
    document: TextDocument,
    importSymbol: string,
    directive: '.import' | '.importzp' = '.import'
): TextEdit {
    const lines = document.getText().split(/\r?\n/);
    let top = skipCommentBlock(lines);
    top = skipDirectiveBlock(lines, top, '.include');

    return insertIntoSortedBlock(
        lines,
        top,
        '.import',
        `${directive} ${importSymbol}\n`,
        line => line.replace(/^\.import(?:zp)?\s+/i, '').trim(),
        importSymbol
    );
}

/**
 * Builds a sorted `.export` or `.exportzp` edit after leading comments, `.include`, and `.import` blocks.
 */
export function makeExportEdit(
    document: TextDocument,
    exportSymbol: string,
    directive: '.export' | '.exportzp' = '.export'
): TextEdit {
    const lines = document.getText().split(/\r?\n/);
    let top = skipCommentBlock(lines);
    top = skipDirectiveBlock(lines, top, '.include');
    top = skipDirectiveBlock(lines, top, '.import');

    return insertIntoSortedBlock(
        lines,
        top,
        '.export',
        `${directive} ${exportSymbol}\n`,
        line => line.replace(/^\.export(?:zp)?\s+/i, '').trim(),
        exportSymbol
    );
}
