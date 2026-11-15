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

class DocumentLineReader {
    private readonly text: string;
    private readonly lineCache: string[] = [];
    private nextOffset = 0;

    constructor(document: TextDocument) {
        this.text = document.getText();
    }

    getLine(lineIndex: number): string | undefined {
        while (this.lineCache.length <= lineIndex && this.nextOffset <= this.text.length) {
            const nl = this.text.indexOf('\n', this.nextOffset);
            const rawEnd = nl === -1 ? this.text.length : nl;
            const end = (rawEnd > this.nextOffset && this.text.charCodeAt(rawEnd - 1) === 13)
                ? rawEnd - 1
                : rawEnd;
            this.lineCache.push(this.text.slice(this.nextOffset, end));
            this.nextOffset = nl === -1 ? this.text.length + 1 : nl + 1;
        }
        return this.lineCache[lineIndex];
    }
}

function skipCommentBlock(reader: DocumentLineReader): number {
    let top = 0;
    let foundComment = false;
    let line: string | undefined;
    while ((line = reader.getLine(top)) !== undefined && line.trim().startsWith(';')) {
        foundComment = true;
        top++;
    }
    if (foundComment && (line = reader.getLine(top)) !== undefined && line.trim().length === 0) {
        top++;
    }
    return top;
}

function skipDirectiveBlock(reader: DocumentLineReader, startLine: number, directivePrefix: string): number {
    let top = startLine;
    let found = false;
    let line: string | undefined;
    while ((line = reader.getLine(top)) !== undefined && line.trim().toLowerCase().startsWith(directivePrefix)) {
        found = true;
        top++;
    }
    if (found && (line = reader.getLine(top)) !== undefined && line.trim().length === 0) {
        top++;
    }
    return top;
}

function insertIntoSortedBlock(
    reader: DocumentLineReader,
    startLine: number,
    directivePrefix: string,
    newLine: string,
    extractSortKey: (trimmedLine: string) => string,
    newSortKey: string,
): TextEdit {
    let insertAt = startLine;
    let line: string | undefined;
    while ((line = reader.getLine(insertAt)) !== undefined && line.trim().toLowerCase().startsWith(directivePrefix)) {
        const existingKey = extractSortKey(line.trim());
        if (existingKey < newSortKey) {
            insertAt++;
        } else {
            break;
        }
    }

    // Add empty space if we're at the end of the block and the following line has content.
    const nextLine = reader.getLine(insertAt);
    const trimmedLine = nextLine !== undefined ? nextLine.trim().toLowerCase() : '';
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
    const reader = new DocumentLineReader(document);
    const top = skipCommentBlock(reader);
    return insertIntoSortedBlock(
        reader,
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
    const reader = new DocumentLineReader(document);
    let top = skipCommentBlock(reader);
    top = skipDirectiveBlock(reader, top, '.include');

    return insertIntoSortedBlock(
        reader,
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
    const reader = new DocumentLineReader(document);
    let top = skipCommentBlock(reader);
    top = skipDirectiveBlock(reader, top, '.include');
    top = skipDirectiveBlock(reader, top, '.import');

    return insertIntoSortedBlock(
        reader,
        top,
        '.export',
        `${directive} ${exportSymbol}\n`,
        line => line.replace(/^\.export(?:zp)?\s+/i, '').trim(),
        exportSymbol
    );
}
