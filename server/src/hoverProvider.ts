import * as path from 'path';
import {
    _Connection,
    TextDocuments,
    Hover,
    MarkupKind,
    TextDocumentPositionParams,
    Range,
} from 'vscode-languageserver/node';
import { TextDocument } from 'vscode-languageserver-textdocument';
import { URI } from 'vscode-uri';

import { mnemonicData, resolveDirectiveAlias } from './dataManager';
import { Macro, MacroKind, Scope, Symbol as Ca65Symbol, SymbolKind as Ca65SymbolKind, SymbolTableEntity } from './symbolTable';
import { resolveReference } from './symbolResolver';
import { ensureDocumentRefreshed, getDocumentSettings, includesGraph, initializationGate, performanceMonitor, symbolTables } from './server';
import { getCachedTextDocument } from './documentCache';
import { evaluateConstantEntity } from './instructionAnalyzer';
import { findCheapLocalLabelAtPosition, findCheapLocalLabelDefinition } from './cheapLocalLabelUtils';
import { getAnonymousLabelDefinition } from './anonymousLabelUtils';
import { getWorkspaceRelativePath } from './pathUtils';

export function initializeHoverProvider(connection: _Connection, documents: TextDocuments<TextDocument>) {
    connection.onHover(async ({ textDocument, position }: TextDocumentPositionParams): Promise<Hover | undefined> => {
        await initializationGate.isInitialized;
        await ensureDocumentRefreshed?.(textDocument.uri);

        return performanceMonitor.timeAsync("onHover", async () => {
        const document = documents.get(textDocument.uri);
        if (!document) {
            return undefined;
        }
        const symbolTable = symbolTables.get(textDocument.uri);
        if (!symbolTable) {
            return undefined;
        }

        const settings = await getDocumentSettings(textDocument.uri);

        const ref = symbolTable.getReferenceAtPosition(position);
        if (ref) {
            const foundEntity = resolveReference(
                ref,
                symbolTables,
                includesGraph,
                settings.implicitImports
            );
            if (foundEntity) {
                const definitionDocument = await getCachedTextDocument(foundEntity.uri, documents);
                if (!definitionDocument) {
                    return undefined;
                }

                return {
                    contents: {
                        kind: MarkupKind.Markdown,
                        value: generateSymbolTableEntityMarkdown(foundEntity, definitionDocument, settings.implicitImports)
                    },
                    range: ref.location
                };
            }
        }

        const lineText = document.getText({
            start: { line: position.line, character: 0 },
            end: { line: position.line + 1, character: 0 }
        });

        // Fast short-circuit before scanning full document for cheap local / anonymous labels
        if (lineText.includes('@')) {
            const localName = findCheapLocalLabelAtPosition(document, position);
            if (localName) {
                const defLoc = findCheapLocalLabelDefinition(document, position, localName);
                if (defLoc) {
                    const enclosingSeg = symbolTable.getScopeAtPosition(defLoc.range.start)?.segment;
                    return {
                        contents: {
                            kind: MarkupKind.Markdown,
                            value: generateLocationHoverMarkdown(localName, defLoc.uri, defLoc.range.start.line, document, enclosingSeg)
                        }
                    };
                }
            }
        }

        if (lineText.includes(':')) {
            const anonLoc = getAnonymousLabelDefinition(document, position);
            if (anonLoc) {
                const enclosingSeg = symbolTable.getScopeAtPosition(anonLoc.range.start)?.segment;
                return {
                    contents: {
                        kind: MarkupKind.Markdown,
                        value: generateLocationHoverMarkdown(':', anonLoc.uri, anonLoc.range.start.line, document, enclosingSeg)
                    }
                };
            }
        }

        const wordRegex = /[.a-zA-Z_][a-zA-Z0-9_]*/g;
        let match;

        while ((match = wordRegex.exec(lineText)) !== null) {
            const start = match.index!;
            const end = start + match[0].length;

            if (position.character >= start && position.character <= end) {
                const word = match[0];
                const hoverRange = Range.create(position.line, start, position.line, end);

                if (word.startsWith('.')) {
                    const data = resolveDirectiveAlias(word.slice(1));
                    if (data) {
                        return { contents: { kind: MarkupKind.Markdown, value: generateDirectiveHoverMarkdown(word, data) }, range: hoverRange };
                    }
                } else {
                    const name = word.toUpperCase();
                    const data = mnemonicData[name];
                    if (data) {
                        return { contents: { kind: MarkupKind.Markdown, value: generateMnemonicHoverMarkdown(word, data) }, range: hoverRange };
                    }
                }
                return undefined;
            }
        }

        return undefined;
        });
    });
}


// --- Markdown Generation Functions ---

export function extractLeadingDocInfo(document: TextDocument, definitionLine: number): {
    docCommentBlock: string;
    hasInlineExport: boolean;
} {
    const rawCommentLines: string[] = [];
    let hasInlineExport = false;

    for (let i = definitionLine - 1; i >= 0; i--) {
        const lineText = document.getText({
            start: { line: i, character: 0 },
            end: { line: i + 1, character: 0 }
        });

        const trimmedLine = lineText.trim();
        if (trimmedLine.startsWith(';')) {
            rawCommentLines.unshift(trimmedLine);
            continue;
        }

        // Allow an .export / .exportzp between the doc comment and the symbol def
        const lowercase = trimmedLine.toLowerCase();
        if (i === definitionLine - 1 && lowercase.startsWith('.export')) {
            hasInlineExport = true;
            continue;
        } else if (hasInlineExport && i === definitionLine - 2 && !trimmedLine) {
            continue;
        }

        break;
    }

    // Trim leading/trailing empty comment markers (e.g. standalone `;` spacer lines)
    const isEmptyComment = (line: string) => /^;+\s*$/.test(line);
    while (rawCommentLines.length > 0 && isEmptyComment(rawCommentLines[0])) {
        rawCommentLines.shift();
    }
    while (rawCommentLines.length > 0 && isEmptyComment(rawCommentLines[rawCommentLines.length - 1])) {
        rawCommentLines.pop();
    }

    return {
        docCommentBlock: rawCommentLines.join('\n'),
        hasInlineExport,
    };
}

export function formatHexAndDecimal(value: number): string {
    const absVal = Math.abs(value);
    const padWidth = absVal <= 0xff ? 2 : (absVal <= 0xffff ? 4 : 0);
    const hexDigits = absVal.toString(16).toUpperCase().padStart(padWidth, '0');
    const hexStr = value < 0 ? `-$${hexDigits}` : `$${hexDigits}`;
    return `\`${hexStr}\` (${value})`;
}

export function formatSourceLink(uri: string, oneBasedLine: number): string {
    let displayPath = getWorkspaceRelativePath(uri);
    if (!displayPath) {
        displayPath = path.basename(URI.parse(uri).fsPath);
    }
    const normalizedPath = displayPath.replace(/\\/g, '/');
    return `[${normalizedPath}:${oneBasedLine}](${uri}#L${oneBasedLine})`;
}

function escapeInlineMarkdown(text: string): string {
    return text.replace(/([\\`*_{}[\]()#+\-!])/g, '\\$1');
}

function formatEntityHeaderParts(entity: SymbolTableEntity): {
    badge?: string;
    signature: string;
} {
    if (entity instanceof Macro) {
        if (entity.kind === MacroKind.Define) {
            return {
                badge: 'DEFINE',
                signature: entity.params.length > 0
                    ? `${entity.name}(${entity.params.join(', ')})`
                    : entity.name,
            };
        }
        return {
            badge: 'MACRO',
            signature: entity.params.length > 0
                ? `${entity.name} ${entity.params.join(', ')}`
                : entity.name,
        };
    }
    if (entity instanceof Scope) {
        return {
            badge: entity.segment || undefined,
            signature: `.${entity.kind} ${entity.name}`,
        };
    }
    if (entity instanceof Ca65Symbol) {
        const badgeByKind: Partial<Record<Ca65SymbolKind, string>> = {
            [Ca65SymbolKind.Constant]: 'CONST',
            [Ca65SymbolKind.EnumMember]: 'ENUM',
            [Ca65SymbolKind.Variable]: 'VAR',
        };
        const symbolBadge = badgeByKind[entity.kind];
        if (symbolBadge) {
            return {
                badge: symbolBadge,
                signature: entity.name,
            };
        }
    }
    return {
        badge: entity.segment || undefined,
        signature: entity.name,
    };
}

function generateLocationHoverMarkdown(
    label: string,
    uri: string,
    defLine: number,
    document: TextDocument,
    segment?: string | null
): string {
    const sections: string[] = [];
    const header = segment
        ? `\`${segment}\` ${escapeInlineMarkdown(label)}`
        : escapeInlineMarkdown(label);
    sections.push(header);

    const { docCommentBlock } = extractLeadingDocInfo(document, defLine);
    if (docCommentBlock) {
        sections.push('```ca65\n' + docCommentBlock + '\n```');
    }

    sections.push(`Defined in ${formatSourceLink(uri, defLine + 1)}`);
    return sections.join('\n\n');
}

export function generateSymbolTableEntityMarkdown(
    entity: SymbolTableEntity,
    document: TextDocument,
    implicitImports: boolean = false
): string {
    const definitionStart = entity.definition.start.line;
    const { docCommentBlock } = extractLeadingDocInfo(document, definitionStart);

    const { badge, signature } = formatEntityHeaderParts(entity);
    const headerParts: string[] = [];
    if (badge) {
        headerParts.push(`\`${badge}\``);
    }
    headerParts.push(escapeInlineMarkdown(signature));

    const entitySymTable = symbolTables.get(entity.uri);
    if (
        entity instanceof Ca65Symbol
        && entitySymTable
        && (
            entity.kind === Ca65SymbolKind.Constant
            || entity.kind === Ca65SymbolKind.Variable
            || entity.kind === Ca65SymbolKind.EnumMember
        )
    ) {
        const evaluated = evaluateConstantEntity(
            entity,
            document,
            entitySymTable,
            symbolTables,
            includesGraph,
            implicitImports
        );
        if (evaluated !== null && Number.isFinite(evaluated)) {
            headerParts.push(`= ${formatHexAndDecimal(evaluated)}`);
        }
    }

    const sections: string[] = [];
    sections.push(headerParts.join(' '));

    if (docCommentBlock) {
        sections.push('```ca65\n' + docCommentBlock + '\n```');
    }

    sections.push(`Defined in ${formatSourceLink(entity.uri, definitionStart + 1)}`);
    return sections.join('\n\n');
}

export function generateDirectiveHoverMarkdown(directiveName: string, data: any): string {
    const typeLabel = data.type ? ` · *${String(data.type).toLowerCase().replace(/_/g, ' ')}*` : '';
    let markdown = `### \`${directiveName.toUpperCase()}\`${typeLabel}\n\n`;
    markdown += `${data.shortDescription}\n\n`;
    if (data.documentationUrl) {
        markdown += `[View cc65 documentation](${data.documentationUrl})\n`;
    }
    return markdown;
}

export function generateMnemonicHoverMarkdown(mnemonic: string, data: any): string {
    let markdown = `### \`${mnemonic.toUpperCase()}\` — ${data.fullName}\n\n`;
    if (data.description) markdown += `${data.description}\n\n`;
    if (data.warning) markdown += `⚠️ **Warning**: ${data.warning}\n\n`;
    if (data.note) markdown += `*Note: ${data.note}*\n\n`;
    if (data.flagChanges && Object.keys(data.flagChanges).length > 0) {
        markdown += `**Flags affected:** `;
        markdown += Object.keys(data.flagChanges)
            .map(flag => `\`${flag}\`: ${data.flagChanges[flag]}`)
            .join(' · ');
        markdown += `\n\n`;
    }
    if (data.modes && Object.keys(data.modes).length > 0) {
        markdown += `| Mode | Opcode | Bytes | Cycles |\n`;
        markdown += `| :--- | :---: | :---: | :---: |\n`;
        for (const [modeName, info] of Object.entries<any>(data.modes)) {
            const notes: string[] = [];
            if (info.branchPenalty) notes.push('+1 branch');
            if (info.pagePenalty) notes.push('+1 page');
            const cycleStr = notes.length > 0 ? `${info.cycles} (${notes.join(', ')})` : `${info.cycles}`;
            markdown += `| ${modeName} | \`${info.opcode}\` | ${info.bytes} | ${cycleStr} |\n`;
        }
        markdown += `\n`;
    }
    if (Array.isArray(data.seeAlso) && data.seeAlso.length > 0) {
        markdown += `**See also:** ${data.seeAlso.map((s: string) => `\`${s}\``).join(', ')}\n`;
    }
    return markdown;
}
