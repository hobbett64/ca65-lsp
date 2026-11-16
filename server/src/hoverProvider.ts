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

import { getMnemonicInfo, MnemonicInfo, MnemonicModeInfo, resolveDirectiveAlias } from './dataManager';
import { Ca65Cpu } from './settings';
import { isLabelSymbolKind, Macro, MacroKind, Scope, ScopeKind, Symbol as Ca65Symbol, SymbolKind as Ca65SymbolKind, SymbolTable, SymbolTableEntity } from './symbolTable';
import { resolveReference } from './symbolResolver';
import { ensureDocumentRefreshed, getDocumentSettings, includesGraph, initializationGate, performanceMonitor, symbolTables } from './server';
import { getCachedTextDocument } from './documentCache';
import { evaluateConstantEntity, evaluateLabelSize, evaluateLocationLabelSize, evaluateStructFieldBadge } from './instructionAnalyzer';
import { findPreviousCheapLocalBoundary, getCheapLocalScopeEndLine } from './cheapLocalLabelUtils';
import { findNumberLiteralAtPosition, NumberLiteralHit } from './codeActionProvider';
import { getWorkspaceRelativePath } from './pathUtils';
import { maskCommentsAtDocumentLine } from './documentScanner';
import {
    findSegmentDirectiveAtPosition,
    formatLinkerSegmentMarkdown,
    loadLinkerConfigForUri,
    lookupLinkerSegment,
} from './linkerConfig';

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
                const defSettings = foundEntity.uri === textDocument.uri
                    ? settings
                    : await getDocumentSettings(foundEntity.uri);

                return {
                    contents: {
                        kind: MarkupKind.Markdown,
                        value: generateSymbolTableEntityMarkdown(
                            foundEntity,
                            definitionDocument,
                            defSettings.implicitImports,
                            defSettings.binIncludeDirs
                        )
                    },
                    range: ref.location
                };
            }
        }

        const lineText = document.getText({
            start: { line: position.line, character: 0 },
            end: { line: position.line + 1, character: 0 }
        });
        const maskedLine = maskCommentsAtDocumentLine(document, position.line, undefined, settings.cComments);

        const segHit = findSegmentDirectiveAtPosition(document, position, settings.cComments);
        if (segHit) {
            const linkerConfig = loadLinkerConfigForUri(textDocument.uri, settings, documents);
            const segDef = lookupLinkerSegment(linkerConfig, segHit.segmentName);
            if (segDef && linkerConfig) {
                return {
                    contents: {
                        kind: MarkupKind.Markdown,
                        value: formatLinkerSegmentMarkdown(linkerConfig, segDef),
                    },
                    range: segHit.nameRange,
                };
            }
        }

        const numHit = findNumberLiteralAtPosition(document, position, settings.cComments);
        if (numHit) {
            const rawToken = lineText.slice(numHit.startChar, numHit.endChar);
            const hoverRange = Range.create(position.line, numHit.startChar, position.line, numHit.endChar);
            return {
                contents: {
                    kind: MarkupKind.Markdown,
                    value: generateNumberHoverMarkdown(numHit, rawToken),
                },
                range: hoverRange,
            };
        }

        const wordRegex = /[.a-zA-Z_][a-zA-Z0-9_]*/g;
        let match;

        while ((match = wordRegex.exec(maskedLine)) !== null) {
            const start = match.index!;
            const end = start + match[0].length;

            if (position.character >= start && position.character <= end) {
                const word = match[0];
                const hoverRange = Range.create(position.line, start, position.line, end);

                if (word.startsWith('.')) {
                    if (settings.enableDirectiveHover) {
                        const data = resolveDirectiveAlias(word.slice(1));
                        if (data) {
                            return { contents: { kind: MarkupKind.Markdown, value: generateDirectiveHoverMarkdown(word, data) }, range: hoverRange };
                        }
                    }
                } else if (settings.enableInstructionHover) {
                    const data = getMnemonicInfo(word, settings.cpu);
                    if (data) {
                        return { contents: { kind: MarkupKind.Markdown, value: generateMnemonicHoverMarkdown(word, data, settings.cpu) }, range: hoverRange };
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

/**
 * Renders an extracted doc comment block verbatim inside a `ca65` code fence
 * so comment syntax highlighting and monospace alignment (tables, diagrams) are preserved.
 */
export function formatDocCommentForHover(docCommentBlock: string): string {
    if (!docCommentBlock || /^\/\*+\s*\*\/$/.test(docCommentBlock.trim())) return '';
    return '```ca65\n' + docCommentBlock + '\n```';
}

export function extractLeadingDocInfo(document: TextDocument, definitionLine: number): {
    docCommentBlock: string;
    hasInlineExport: boolean;
} {
    const rawCommentLines: string[] = [];
    let hasInlineExport = false;
    let inBlockDoc = false;

    for (let i = definitionLine - 1; i >= 0; i--) {
        const lineText = document.getText({
            start: { line: i, character: 0 },
            end: { line: i + 1, character: 0 }
        });

        const rawNoEol = lineText.replace(/\r?\n$/, '').trimEnd();
        const trimmedLine = rawNoEol.trimStart();
        if (inBlockDoc) {
            rawCommentLines.unshift(rawNoEol);
            const openIdx = rawNoEol.indexOf('/*');
            if (openIdx >= 0) {
                // Reject trailing block comments attached to an earlier code line
                const prefix = rawNoEol.slice(0, openIdx);
                if (prefix.trim().length > 0) {
                    rawCommentLines.length = 0;
                } else if (openIdx > 0) {
                    for (let j = 0; j < rawCommentLines.length; j++) {
                        let strip = 0;
                        while (strip < openIdx && strip < rawCommentLines[j].length && (rawCommentLines[j][strip] === ' ' || rawCommentLines[j][strip] === '\t')) {
                            strip++;
                        }
                        if (strip > 0) {
                            rawCommentLines[j] = rawCommentLines[j].slice(strip);
                        }
                    }
                }
                break;
            }
            continue;
        }

        if (rawCommentLines.length === 0 && trimmedLine.endsWith('*/')) {
            const openIdx = rawNoEol.indexOf('/*');
            if (openIdx >= 0) {
                if (rawNoEol.slice(0, openIdx).trim().length === 0) {
                    rawCommentLines.unshift(trimmedLine);
                }
                break;
            }
            rawCommentLines.unshift(rawNoEol);
            inBlockDoc = true;
            continue;
        }

        if (trimmedLine.startsWith(';')) {
            rawCommentLines.unshift(trimmedLine);
            continue;
        }

        // Allow an .export / .exportzp between the doc comment and the symbol def
        if (rawCommentLines.length === 0) {
            const lowercase = trimmedLine.toLowerCase();
            if (i === definitionLine - 1 && lowercase.startsWith('.export')) {
                hasInlineExport = true;
                continue;
            } else if (hasInlineExport && i === definitionLine - 2 && !trimmedLine) {
                continue;
            }
        }

        break;
    }

    // Trim leading/trailing empty comment markers (e.g. standalone `;` spacer lines)
    if (!inBlockDoc && !rawCommentLines[0]?.startsWith('/*')) {
        const isEmptyComment = (line: string) => /^;+\s*$/.test(line);
        while (rawCommentLines.length > 0 && isEmptyComment(rawCommentLines[0])) {
            rawCommentLines.shift();
        }
        while (rawCommentLines.length > 0 && isEmptyComment(rawCommentLines[rawCommentLines.length - 1])) {
            rawCommentLines.pop();
        }
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

function getEffectiveSegmentAtLine(symbolTable: SymbolTable | undefined, line: number): string | undefined {
    if (!symbolTable) {
        return undefined;
    }
    const seg = symbolTable.getSegmentAtLine(line);
    return seg || undefined;
}

function formatQualifiedPrefixAndLeaf(entity: SymbolTableEntity): { prefixParts: string[]; leaf: string } {
    return {
        prefixParts: entity.getScopeStack().filter(name => !name.startsWith('<anon')),
        leaf: entity.name,
    };
}

function formatQualifiedMarkdownName(entity: SymbolTableEntity): string {
    const { prefixParts, leaf } = formatQualifiedPrefixAndLeaf(entity);
    const boldLeaf = `**${escapeInlineMarkdown(leaf)}**`;
    if (prefixParts.length === 0) {
        return boldLeaf;
    }
    const prefix = prefixParts.map(escapeInlineMarkdown).join('::');
    return `${prefix}::${boldLeaf}`;
}

function findCheapLocalBoundaryEntity(symbolTable: SymbolTable, boundaryLine: number): SymbolTableEntity | undefined {
    let matched: SymbolTableEntity | undefined;
    for (const candidate of symbolTable.getAllDefinedEntities()) {
        if (candidate.definition.start.line !== boundaryLine) {
            continue;
        }
        if (
            (candidate instanceof Scope && candidate.kind === ScopeKind.Proc)
            || (candidate instanceof Ca65Symbol && isLabelSymbolKind(candidate.kind))
        ) {
            matched = candidate;
        }
    }
    return matched;
}

function formatCheapLocalMarkdownName(
    label: string,
    document: TextDocument,
    defLine: number,
    symbolTable?: SymbolTable
): string {
    const leafName = label.startsWith('@') ? label.slice(1) : label;
    const escapedLeaf = escapeInlineMarkdown(leafName);
    const boldLeaf = `**@${escapedLeaf}**`;
    if (!symbolTable) {
        return boldLeaf;
    }
    const boundaryLine = findPreviousCheapLocalBoundary(document, defLine);
    if (boundaryLine >= 0) {
        const boundaryEntity = findCheapLocalBoundaryEntity(symbolTable, boundaryLine);
        if (boundaryEntity) {
            const { prefixParts, leaf } = formatQualifiedPrefixAndLeaf(boundaryEntity);
            const qualifiedBoundary = [...prefixParts, leaf].map(escapeInlineMarkdown).join('::');
            // Insert U+2060 (Word Joiner, Cf) after ** so CommonMark / VS Code marked parses **@...** as bold right after an alphanumeric parent without visible spacing or line breaks.
            return `${qualifiedBoundary}**\u2060@${escapedLeaf}**`;
        }
    }
    const enclosingScope = symbolTable.getScopeAtPosition({ line: defLine, character: 0 });
    if (enclosingScope && enclosingScope !== symbolTable.getRootScope()) {
        const { prefixParts, leaf } = formatQualifiedPrefixAndLeaf(enclosingScope);
        const scopeParts = enclosingScope.name.startsWith('<anon') ? prefixParts : [...prefixParts, leaf];
        if (scopeParts.length > 0) {
            return `${scopeParts.map(escapeInlineMarkdown).join('::')}::${boldLeaf}`;
        }
    }
    return boldLeaf;
}

function formatEntityHeaderParts(entity: SymbolTableEntity): {
    segment?: string | null;
    badges: string[];
    signatureMarkdown: string;
} {
    if (entity instanceof Macro) {
        const boldName = `**${escapeInlineMarkdown(entity.name)}**`;
        if (entity.kind === MacroKind.Define) {
            return {
                badges: ['define'],
                signatureMarkdown: entity.params.length > 0
                    ? `${boldName}${escapeInlineMarkdown(`(${entity.params.join(', ')})`)}`
                    : boldName,
            };
        }
        return {
            badges: ['macro'],
            signatureMarkdown: entity.params.length > 0
                ? `${boldName} ${escapeInlineMarkdown(entity.params.join(', '))}`
                : boldName,
        };
    }
    const qualifiedMarkdown = formatQualifiedMarkdownName(entity);
    if (entity instanceof Scope) {
        return {
            segment: entity.segment,
            badges: [entity.kind],
            signatureMarkdown: qualifiedMarkdown,
        };
    }
    if (entity instanceof Ca65Symbol) {
        const badgeByKind: Partial<Record<Ca65SymbolKind, string>> = {
            [Ca65SymbolKind.Constant]: 'const',
            [Ca65SymbolKind.EnumMember]: 'enum',
            [Ca65SymbolKind.Variable]: 'var',
            [Ca65SymbolKind.StructMember]: 'field',
        };
        const symbolBadge = badgeByKind[entity.kind];
        if (symbolBadge) {
            return {
                badges: [symbolBadge],
                signatureMarkdown: qualifiedMarkdown,
            };
        }
        return {
            segment: entity.segment,
            badges: [],
            signatureMarkdown: qualifiedMarkdown,
        };
    }
    return {
        segment: entity.segment,
        badges: [],
        signatureMarkdown: qualifiedMarkdown,
    };
}

function assembleEntityHoverMarkdown(
    header: {
        segment?: string | null;
        badges: string[];
        signatureMarkdown: string;
        trailingParts?: string[];
    },
    defLine: number,
    document: TextDocument
): string {
    const headerParts: string[] = [];
    if (header.segment) {
        headerParts.push(`\`${header.segment}\``);
    }
    for (const badge of header.badges) {
        headerParts.push(badge);
    }
    headerParts.push(header.signatureMarkdown);
    if (header.trailingParts) {
        headerParts.push(...header.trailingParts);
    }

    const sections: string[] = [headerParts.join(' ')];
    const { docCommentBlock } = extractLeadingDocInfo(document, defLine);
    if (docCommentBlock) {
        const renderedDoc = formatDocCommentForHover(docCommentBlock);
        if (renderedDoc) {
            sections.push(renderedDoc);
        }
    }
    return sections.join('\n\n');
}

export function generateCheapLocalHoverMarkdown(
    label: string,
    defRange: Range,
    document: TextDocument,
    symbolTable?: SymbolTable,
    implicitImports: boolean = false,
    binIncludeDirs?: string[]
): string {
    const defLine = defRange.start.line;
    const segment = getEffectiveSegmentAtLine(symbolTable, defLine);
    const signatureMarkdown = formatCheapLocalMarkdownName(label, document, defLine, symbolTable);
    const endLine = getCheapLocalScopeEndLine(document, defLine);
    const resolvedSize = evaluateLocationLabelSize(
        defRange,
        endLine,
        document,
        symbolTable,
        symbolTables,
        includesGraph,
        implicitImports,
        binIncludeDirs
    );
    const formattedSignature = resolvedSize !== null && Number.isFinite(resolvedSize) && resolvedSize >= 1
        ? `${signatureMarkdown} (${resolvedSize} ${resolvedSize === 1 ? 'byte' : 'bytes'})`
        : signatureMarkdown;
    return assembleEntityHoverMarkdown(
        {
            segment,
            badges: [],
            signatureMarkdown: formattedSignature,
        },
        defLine,
        document
    );
}

export function generateSymbolTableEntityMarkdown(
    entity: SymbolTableEntity,
    document: TextDocument,
    implicitImports: boolean = false,
    binIncludeDirs?: string[]
): string {
    const definitionStart = entity.definition.start.line;
    const entitySymTable = symbolTables.get(entity.uri);

    const { segment, badges, signatureMarkdown } = formatEntityHeaderParts(entity);
    const trailingParts: string[] = [];
    let resolvedSize: number | null = null;
    if (entity instanceof Ca65Symbol && isLabelSymbolKind(entity.kind)) {
        resolvedSize = evaluateLabelSize(
            entity,
            document,
            entitySymTable,
            symbolTables,
            includesGraph,
            implicitImports,
            binIncludeDirs
        );
    } else if (entity instanceof Ca65Symbol && entity.kind === Ca65SymbolKind.StructMember) {
        resolvedSize = evaluateStructFieldBadge(
            entity,
            document,
            entitySymTable,
            symbolTables,
            includesGraph,
            implicitImports,
            binIncludeDirs
        )?.totalBytes ?? null;
    }

    const finalSignature = signatureMarkdown;
    if (resolvedSize !== null && Number.isFinite(resolvedSize) && resolvedSize >= 1) {
        trailingParts.push(`(${resolvedSize} ${resolvedSize === 1 ? 'byte' : 'bytes'})`);
    }

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
            trailingParts.push(`= ${formatHexAndDecimal(evaluated)}`);
        }
    }

    return assembleEntityHoverMarkdown(
        { segment, badges, signatureMarkdown: finalSignature, trailingParts },
        definitionStart,
        document
    );
}

export function generateDirectiveHoverMarkdown(directiveName: string, data: any): string {
    const typeLabel = data.type ? ` · *${String(data.type).toLowerCase().replace(/_/g, ' ')}*` : '';
    let markdown = `\`${directiveName.toLowerCase()}\`${typeLabel}\n\n`;
    markdown += `${data.shortDescription}\n\n`;
    if (data.documentationUrl) {
        markdown += `[View cc65 documentation](${data.documentationUrl})\n`;
    }
    return markdown;
}

function formatModeBytes(info: MnemonicModeInfo): string {
    if (info.byteVariableM) return `${info.bytes}–${info.bytes + 1} (M)`;
    if (info.byteVariableX) return `${info.bytes}–${info.bytes + 1} (X)`;
    return `${info.bytes}`;
}

function formatModeCycles(info: MnemonicModeInfo): string {
    if (info.perByteCycles) return `${info.cycles}/byte`;
    const notes: string[] = [];
    if (info.branchPenalty) notes.push('+1 branch');
    if (info.pagePenalty) notes.push('+1 page');
    if (info.pageOrIndex16Penalty) notes.push('+1 page/16-bit X');
    if (info.emulationOnlyPagePenalty) notes.push('+1 page if E=1');
    if (info.cycleVariableM) notes.push(`+${info.cycleVariableM} if 16-bit M`);
    if (info.cycleVariableX) notes.push(`+${info.cycleVariableX} if 16-bit X`);
    if (info.dpNonZeroPenalty) notes.push('+1 if DL≠0');
    if (info.nativeModeCyclePenalty) notes.push(`+${info.nativeModeCyclePenalty} if E=0`);
    return notes.length > 0 ? `${info.cycles} (${notes.join(', ')})` : `${info.cycles}`;
}

export function generateMnemonicHoverMarkdown(
    mnemonic: string,
    data: MnemonicInfo,
    cpu?: Ca65Cpu,
    options: { detailed?: boolean } = {}
): string {
    const cpuTag = cpu && cpu !== '6502' ? ` (${cpu})` : '';
    const lowerMnemonic = mnemonic.toLowerCase();
    let markdown = `\`${lowerMnemonic}\` — **${data.fullName}**${cpuTag}\n\n`;
    if (data.description) markdown += `${data.description}\n\n`;
    if (data.warning) markdown += `⚠️ **Warning**: ${data.warning}\n\n`;
    if (data.note) markdown += `*Note: ${data.note}*\n\n`;

    const flagKeys = data.flagChanges ? Object.keys(data.flagChanges) : [];
    const modeEntries = data.modes ? Object.entries(data.modes) : [];

    if (options.detailed) {
        if (flagKeys.length > 0) {
            markdown += `**Flags affected:**\n`;
            for (const flag of flagKeys) {
                markdown += `- \`${flag}\`: ${data.flagChanges[flag]}\n`;
            }
            markdown += `\n`;
        }
        if (modeEntries.length > 0) {
            markdown += `| Mode | Opcode | Bytes | Cycles |\n`;
            markdown += `| :--- | :---: | :---: | :---: |\n`;
            for (const [modeName, info] of modeEntries) {
                markdown += `| ${modeName} | \`${info.opcode}\` | ${formatModeBytes(info)} | ${formatModeCycles(info)} |\n`;
            }
            markdown += `\n`;
        }
        return markdown;
    }

    const flagsSummary = flagKeys.length > 0 ? flagKeys.map(f => `\`${f}\``).join(', ') : 'None';
    const summaryLines: string[] = [`**Affected flags:** ${flagsSummary}`];
    if (modeEntries.length > 0) {
        const modeList = modeEntries.map(([modeName]) => `\`${modeName}\``).join(' ');
        summaryLines.push(`**Addressing modes:** ${modeList}`);
    }
    markdown += `${summaryLines.join('  \n')}\n\n`;

    const encodedArg = encodeURIComponent(JSON.stringify([lowerMnemonic]));
    markdown += `[See details](command:ca65.showReference?${encodedArg})\n`;
    return markdown;
}

export function generateNumberHoverMarkdown(hit: NumberLiteralHit, rawToken: string): string {
    const hexWidth = hit.value <= 0xFF ? 2 : hit.value <= 0xFFFF ? 4 : 8;
    const hexStr = '$' + hit.value.toString(16).toUpperCase().padStart(hexWidth, '0');
    const decStr = hit.value.toString(10);
    const binWidth = hit.value <= 0xFF ? 8 : hit.value <= 0xFFFF ? 16 : 32;
    const binStr = '%' + hit.value.toString(2).padStart(binWidth, '0');

    return `number **${escapeInlineMarkdown(rawToken)}**\n\nHex: \`${hexStr}\` · Dec: \`${decStr}\` · Bin: \`${binStr}\``;
}
