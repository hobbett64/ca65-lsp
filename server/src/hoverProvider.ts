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

import { getMnemonicInfo, isCc65RuntimeSymbol, MnemonicInfo, MnemonicModeInfo, resolveDirectiveAlias } from './dataManager';
import { Ca65Cpu, HoverDocsMode } from './settings';
import { Import, isLabelSymbolKind, Macro, MacroKind, Scope, ScopeKind, Symbol as Ca65Symbol, SymbolKind as Ca65SymbolKind, SymbolTable, SymbolTableEntity } from './symbolTable';
import {
    extractCommentSymbolTokensInLine,
    findCommentSymbolAtPosition,
    resolveCommentSymbol,
    resolveReference,
} from './symbolResolver';
import { ensureDocumentRefreshed, getDocumentSettings, includesGraph, initializationGate, performanceMonitor, symbolTables } from './server';
import { getCachedTextDocument } from './documentCache';
import { evaluateConstantEntity, evaluateLabelSize, evaluateLocationLabelSize, evaluateStructFieldBadge } from './instructionAnalyzer';
import {
    findCheapLocalLabelDefinition,
    findCheapLocalTokenAtPosition,
    findPreviousCheapLocalBoundary,
    getCheapLocalScopeEndLine,
    parseCheapLocalAssignment,
} from './cheapLocalLabelUtils';
import { findNumberLiteralAtPosition, NumberLiteralHit } from './codeActionProvider';
import { getWorkspaceRelativePath } from './pathUtils';
import { maskCommentsAtDocumentLine, stripCommentsInLine } from './documentScanner';
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

        // Cheap locals (@name) aren't in the symbol table: they're resolved within the
        // span between the surrounding normal labels.
        const cheapToken = findCheapLocalTokenAtPosition(document, position);
        if (cheapToken) {
            const cheapDef = findCheapLocalLabelDefinition(document, position, cheapToken.name);
            if (!cheapDef) {
                return undefined;
            }
            return {
                contents: {
                    kind: MarkupKind.Markdown,
                    value: generateCheapLocalHoverMarkdown(
                        cheapToken.name,
                        cheapDef.range,
                        document,
                        symbolTable,
                        settings.implicitImports,
                        settings.binIncludeDirs,
                        settings
                    ),
                },
                range: cheapToken.range,
            };
        }

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
                            defSettings.binIncludeDirs,
                            defSettings
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

        const commentHit = findCommentSymbolAtPosition(document, position, settings.cComments);
        if (commentHit) {
            const commentEntity = resolveCommentSymbol(
                textDocument.uri,
                position,
                commentHit.rawName,
                symbolTables,
                includesGraph,
                settings.implicitImports
            );
            if (commentEntity) {
                const definitionDocument = await getCachedTextDocument(commentEntity.uri, documents);
                if (definitionDocument) {
                    const defSettings = commentEntity.uri === textDocument.uri
                        ? settings
                        : await getDocumentSettings(commentEntity.uri);
                    return {
                        contents: {
                            kind: MarkupKind.Markdown,
                            value: generateSymbolTableEntityMarkdown(
                                commentEntity,
                                definitionDocument,
                                defSettings.implicitImports,
                                defSettings.binIncludeDirs,
                                defSettings
                            ),
                        },
                        range: commentHit.range,
                    };
                }
            }
        }

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
                        return { contents: { kind: MarkupKind.Markdown, value: generateMnemonicHoverMarkdown(word, data, settings.cpu, { detailed: true }) }, range: hoverRange };
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

export interface DocCommentFormatContext {
    uri: string;
    line: number;
    implicitImports?: boolean;
}

/**
 * Renders an extracted doc comment block verbatim inside a `ca65` code fence
 * so comment syntax highlighting and monospace alignment (tables, diagrams) are preserved,
 * and appends clickable Markdown links for any resolved `{symbol}` / `{@link symbol}` / `@see` targets.
 */
export function formatDocCommentForHover(
    docCommentBlocks: string | string[],
    context?: DocCommentFormatContext
): string {
    const blocks = (Array.isArray(docCommentBlocks) ? docCommentBlocks : [docCommentBlocks])
        .filter(block => block && !/^\/\*+\s*\*\/$/.test(block.trim()));
    if (blocks.length === 0) return '';
    // Several blocks (comments above, trailing comment) get their own fences, split by a horizontal rule.
    const codeFence = blocks.map(block => '```ca65\n' + block + '\n```').join('\n\n---\n\n');
    const docCommentBlock = blocks.join('\n');
    if (!context || !symbolTables || !includesGraph) {
        return codeFence;
    }

    const lines = docCommentBlock.split(/\r?\n/);
    const seenEntities = new Set<SymbolTableEntity>();
    const seeLinks: string[] = [];
    for (let i = 0; i < lines.length; i++) {
        for (const hit of extractCommentSymbolTokensInLine(lines[i], i)) {
            const resolved = resolveCommentSymbol(
                context.uri,
                { line: context.line, character: 0 },
                hit.rawName,
                symbolTables,
                includesGraph,
                Boolean(context.implicitImports)
            );
            if (resolved && !seenEntities.has(resolved)) {
                seenEntities.add(resolved);
                const { prefixParts, leaf } = formatQualifiedPrefixAndLeaf(resolved);
                const qualifiedDisplayName = prefixParts.length > 0
                    ? `${prefixParts.join('::')}::${leaf}`
                    : leaf;
                const oneBasedLine = resolved.definition.start.line + 1;
                seeLinks.push(`[${escapeInlineMarkdown(qualifiedDisplayName)}](${resolved.uri}#L${oneBasedLine})`);
            }
        }
    }

    if (seeLinks.length === 0) {
        return codeFence;
    }
    return `${codeFence}\n\n*See:* ${seeLinks.join(', ')}`;
}

export interface LeadingDocInfo {
    /** Raw doc comment text: a `/** ... *\/` block when C comments are on, otherwise the touching `;` lines. */
    docCommentBlock: string;
    /** Trailing `;` comment on the definition line itself (not collected for a `/** ... *\/` block). */
    inlineComment: string;
    /** True when `docCommentBlock` is a JSDoc-style `/** ... *\/` block (rendered as Markdown). */
    isJsDoc: boolean;
    hasInlineExport: boolean;
}

/** Settings that decide which comments become hover documentation. */
export interface DocCommentOptions {
    cComments?: boolean;
    hoverDocs?: HoverDocsMode;
}

/**
 * Collects the documentation attached to a definition:
 * - a `/** ... *\/` block directly above the definition (needs `cComments`), otherwise
 * - unless `hoverDocs` is `docBlocks`, the contiguous `;` comment lines directly above plus the trailing
 *   `;` comment on the definition line, all verbatim (dividers and bare `;` lines included).
 * In both cases a single `.export` / `.exportzp` line may sit between the doc and the definition.
 */
export function extractLeadingDocInfo(
    document: TextDocument,
    definitionLine: number,
    options: DocCommentOptions = {}
): LeadingDocInfo {
    const cComments = options.cComments ?? true;
    const getLine = (i: number) => document.getText({
        start: { line: i, character: 0 },
        end: { line: i + 1, character: 0 }
    }).replace(/\r?\n$/, '').trimEnd();

    let hasInlineExport = false;
    let i = definitionLine - 1;
    if (i >= 0 && getLine(i).trimStart().toLowerCase().startsWith('.export')) {
        hasInlineExport = true;
        i--;
        if (i >= 0 && getLine(i).trim().length === 0) {
            i--;
        }
    }

    const empty: LeadingDocInfo = { docCommentBlock: '', inlineComment: '', isJsDoc: false, hasInlineExport };
    if (cComments) {
        const jsDoc = collectJsDocBlockAbove(getLine, i);
        if (jsDoc) {
            return { ...empty, docCommentBlock: jsDoc, isJsDoc: true };
        }
    }
    if (options.hoverDocs === 'docBlocks') {
        return empty;
    }

    const rawCommentLines: string[] = [];
    for (; i >= 0; i--) {
        const trimmedLine = getLine(i).trimStart();
        if (!trimmedLine.startsWith(';')) break;
        rawCommentLines.unshift(trimmedLine);
    }

    let inlineComment = '';
    if (definitionLine >= 0 && definitionLine < document.lineCount) {
        const defLineText = getLine(definitionLine);
        const stripped = stripCommentsInLine(defLineText, false, cComments);
        if (stripped.hasSemicolonComment && stripped.code.trim().length > 0) {
            inlineComment = defLineText.slice(stripped.code.length).trim();
        }
    }

    return { ...empty, docCommentBlock: rawCommentLines.join('\n'), inlineComment };
}

/** Returns the `/** ... *\/` block whose closing line is `endLine`, dedented to its opener, or '' if there is none. */
function collectJsDocBlockAbove(getLine: (i: number) => string, endLine: number): string {
    if (endLine < 0) return '';
    const last = getLine(endLine);
    if (!last.endsWith('*/')) return '';

    const rawLines: string[] = [];
    for (let i = endLine; i >= 0; i--) {
        const raw = getLine(i);
        rawLines.unshift(raw);
        // The closing line itself may also hold the opener (`/** one-liner *\/`); search before its `*/`.
        const searchIn = i === endLine ? raw.slice(0, raw.length - 2) : raw;
        const openIdx = searchIn.lastIndexOf('/*');
        if (openIdx < 0) continue;
        // Reject trailing block comments attached to an earlier code line, and plain `/* ... */` blocks.
        if (raw.slice(0, openIdx).trim().length > 0) return '';
        if (!/^\/\*\*(?!\/)/.test(raw.slice(openIdx))) return '';
        if (i !== endLine && searchIn.indexOf('*/', openIdx) >= 0) return '';
        return rawLines.map(line => {
            let strip = 0;
            while (strip < openIdx && strip < line.length && (line[strip] === ' ' || line[strip] === '\t')) strip++;
            return line.slice(strip);
        }).join('\n');
    }
    return '';
}

/**
 * Renders the documentation for the definition at `defLine` in `document` (see `extractLeadingDocInfo`):
 * a `/** ... *\/` block as Markdown, or else the line comments above and the definition line's
 * trailing comment, each verbatim in a `ca65` code fence, separated by a horizontal rule.
 */
export function renderDefinitionDocMarkdown(
    document: TextDocument,
    defLine: number,
    options: DocCommentOptions & { implicitImports?: boolean } = {}
): string {
    const info = extractLeadingDocInfo(document, defLine, options);
    const context: DocCommentFormatContext = {
        uri: document.uri,
        line: defLine,
        implicitImports: options.implicitImports,
    };
    if (info.isJsDoc) {
        return info.docCommentBlock ? formatJsDocForHover(info.docCommentBlock, context) : '';
    }
    return formatDocCommentForHover([info.docCommentBlock, info.inlineComment], context);
}

/**
 * Converts a `/** ... *\/` block into Markdown: strips the delimiters and `*` gutter, turns
 * `{symbol}` / `{@link symbol}` / tag targets into links, and renders each `@tag` as its own paragraph in VS Code's TypeScript hover style.
 * @param docCommentBlock the raw comment text, including the opening and closing delimiters
 * @param context where the comment's symbol is defined, used to resolve symbol links; omit it to skip linking
 * @returns the Markdown for the hover, or an empty string if the comment has no text
 * @see formatDocCommentForHover
 */
export function formatJsDocForHover(docCommentBlock: string, context?: DocCommentFormatContext): string {
    let lines = docCommentBlock.split(/\r?\n/);
    lines[0] = lines[0].replace(/^\s*\/\*\*/, '');
    lines[lines.length - 1] = lines[lines.length - 1].replace(/\*\/\s*$/, '');

    // Strip the ` * ` gutter where present, then dedent the remaining lines by their common indent.
    lines = lines.map((line, idx) => idx === 0 ? line.trimStart() : line.replace(/^[ \t]*\*(?!\/) ?/, ''));
    const indents = lines.slice(1).filter(l => l.trim()).map(l => l.match(/^[ \t]*/)![0].length);
    const common = indents.length > 0 ? Math.min(...indents) : 0;
    if (common > 0) {
        lines = lines.map((line, idx) => idx === 0 ? line : line.slice(Math.min(common, line.match(/^[ \t]*/)![0].length)));
    }
    lines = convertDocCommentHtml(lines.map(line => line.trimEnd()));
    while (lines.length > 0 && !lines[0]) lines.shift();
    while (lines.length > 0 && !lines[lines.length - 1]) lines.pop();
    if (lines.length === 0) return '';

    const out: string[] = [];
    let inFence = false;
    for (let i = 0; i < lines.length; i++) {
        const line = lines[i];
        if (/^\s*(```|~~~)/.test(line)) {
            inFence = !inFence;
            out.push(line);
            continue;
        }
        if (inFence) {
            out.push(line);
            continue;
        }
        if (!JSDOC_TAG_LINE_RE.test(line)) {
            out.push(linkCommentSymbols(line, i, context));
            continue;
        }
        // A tag's text runs on until a blank line, the next tag or a code fence.
        const continuation: string[] = [];
        while (i + 1 < lines.length && lines[i + 1].trim() && !JSDOC_TAG_LINE_RE.test(lines[i + 1]) && !/^\s*(```|~~~)/.test(lines[i + 1])) {
            i++;
            continuation.push(linkCommentSymbols(lines[i].trim(), i, context));
        }
        // Each tag is its own paragraph, styled like VS Code's TypeScript hovers.
        if (out.length > 0 && out[out.length - 1] !== '') out.push('');
        out.push(formatJsDocTag(line, i - continuation.length, continuation, context));
    }
    return out.join('\n');
}

const JSDOC_TAG_LINE_RE = /^\s*@[a-zA-Z]+\b/;

/**
 * Converts the HTML commonly written in Javadoc-style comments (`<p>`, `<br>`, `<b>`/`<strong>`,
 * `<i>`/`<em>`, `<code>`, `<ul>`/`<ol>`/`<li>`) to Markdown, and escapes any other tag so it shows
 * as written: raw HTML isn't rendered in hovers, and a line starting with an HTML tag would hide
 * everything up to the next blank line. Code spans, fenced code and `<https://...>` autolinks are
 * left alone.
 */
function convertDocCommentHtml(lines: string[]): string[] {
    const out: string[] = [];
    const fenced = new Set<number>();
    let inFence = false;
    const lists: string[] = [];
    const convert = (text: string): string => text
        .replace(/<\/?p(?:\s[^>]*)?>/gi, '\n\n')
        .replace(/<br\s*\/?>/gi, '\\\n')
        .replace(/<\/?(?:b|strong)>/gi, '**')
        .replace(/<\/?(?:i|em)>/gi, '*')
        .replace(/<\/?code>/gi, '`')
        .replace(/<(\/?)(ul|ol|li)(?:\s[^>]*)?>/gi, (_m, close: string, tag: string) => {
            const name = tag.toLowerCase();
            if (name === 'li') return close ? '' : `\n${lists[lists.length - 1] === 'ol' ? '1.' : '-'} `;
            if (close) lists.pop();
            else lists.push(name);
            return '\n\n';
        })
        .replace(/<(?=[a-zA-Z/!?])(?![a-zA-Z][a-zA-Z0-9+.-]{1,31}:[^\s<>]*>)/g, '\\<');
    for (const line of lines) {
        if (/^\s*(```|~~~)/.test(line)) inFence = !inFence;
        if (inFence || /^\s*(```|~~~)/.test(line)) {
            fenced.add(out.length);
            out.push(line);
            continue;
        }
        const converted = line.split(/(`+[^`]*`+)/).map((part, idx) => idx % 2 === 1 ? part : convert(part)).join('');
        converted.split('\n').forEach((segment, idx) => out.push(idx === 0 ? segment.trimEnd() : segment.trim()));
    }
    // Tidy up: no hard break (`\`) right before a paragraph end, and no runs of blank lines.
    return out
        .map((line, idx) => !fenced.has(idx) && line.endsWith('\\') && !out[idx + 1]?.trim() ? line.slice(0, -1).trimEnd() : line)
        .filter((line, idx) => fenced.has(idx) || line !== '' || (idx > 0 && out[idx - 1] !== ''));
}

const JSDOC_SINGLE_TARGET_TAGS = new Set(['param', 'arg', 'argument', 'template', 'input', 'in', 'output', 'out']);
const JSDOC_LIST_TARGET_TAGS = new Set(['see', 'modifies', 'uses']);
const JSDOC_REGISTER_TAGS = new Set(['clobber', 'clobbers', 'preserve', 'preserves']);
const JSDOC_TARGET_ITEM = String.raw`\{?[^\s,{}]+\}?`;

/**
 * Splits a tag's text into its targets (a parameter name, a symbol list or registers, matching
 * the tags `extractCommentSymbolTokensInLine` links) and its description. Returns null for tags
 * that take no target, such as `@return`.
 */
function splitJsDocTagTargets(tag: string, body: string): { type: string; names: string[]; description: string } | null {
    const lower = tag.toLowerCase();
    let m: RegExpExecArray | null = null;
    if (JSDOC_SINGLE_TARGET_TAGS.has(lower)) {
        m = new RegExp(String.raw`^(\s+\{[^}]*\})?\s+(${JSDOC_TARGET_ITEM})(?:\s+(?:[-\u2013\u2014]\s+)?(.*))?$`).exec(body);
    } else if (JSDOC_LIST_TARGET_TAGS.has(lower)) {
        m = new RegExp(String.raw`^()\s+(${JSDOC_TARGET_ITEM}(?:\s*,\s*${JSDOC_TARGET_ITEM})*)(?:\s+(?:[-\u2013\u2014]\s+)?(.*))?$`).exec(body);
    } else if (JSDOC_REGISTER_TAGS.has(lower)) {
        // Registers run until ` - `, `:` or `(`, as in `@clobbers A, X - used as temps`.
        const stop = /\s+[-\u2013\u2014]\s+|\s*:\s*|\s*(?=\()/.exec(body);
        const targets = stop ? body.slice(0, stop.index) : body;
        if (targets.trim()) m = ['', '', targets, stop ? body.slice(stop.index + stop[0].length) : ''] as unknown as RegExpExecArray;
    }
    if (!m) return null;
    const names = m[2].split(/[\s,]+/).filter(Boolean).map(n => n.replace(/^\{|\}$/g, ''));
    return { type: m[1] ?? '', names, description: m[3] ?? '' };
}

/**
 * Renders one tag the way VS Code's TypeScript hover does: the tag name in italics, any targets
 * as code (linked when they resolve to a symbol), then ` — description`, or the description on
 * its own line when it spans several lines.
 */
function formatJsDocTag(line: string, lineIndex: number, continuation: string[], context?: DocCommentFormatContext): string {
    const [, indent, tag, body] = /^(\s*)@([a-zA-Z]+)\b(.*)$/.exec(line)!;
    let head = `${indent}*@${tag}*`;
    let firstLine = body;
    const split = splitJsDocTagTargets(tag, body);
    if (split) {
        const names = split.names.map(name => {
            const target = resolveCommentLinkTarget(name, context);
            return target ? `[\`${name}\`](${target})` : `\`${name}\``;
        });
        head += `${linkCommentSymbols(split.type, lineIndex, context)} ${names.join(', ')}`;
        firstLine = split.description;
    }
    const text = [linkCommentSymbols(firstLine.trim(), lineIndex, context), ...continuation].filter(Boolean).join('\n');
    if (!text) return head;
    return text.includes('\n') ? `${head}  \n${text}` : `${head} \u2014 ${text}`;
}

function resolveCommentLinkTarget(rawName: string, context?: DocCommentFormatContext): string | undefined {
    if (!context || !symbolTables || !includesGraph) return undefined;
    const resolved = resolveCommentSymbol(
        context.uri,
        { line: context.line, character: 0 },
        rawName,
        symbolTables,
        includesGraph,
        Boolean(context.implicitImports)
    );
    return resolved ? `${resolved.uri}#L${resolved.definition.start.line + 1}` : undefined;
}

function linkCommentSymbols(line: string, lineIndex: number, context?: DocCommentFormatContext): string {
    if (!context || !symbolTables || !includesGraph) return line;
    const hits = extractCommentSymbolTokensInLine(line, lineIndex);
    for (let h = hits.length - 1; h >= 0; h--) {
        const hit = hits[h];
        const target = resolveCommentLinkTarget(hit.rawName, context);
        if (!target) continue;
        const link = `[${escapeInlineMarkdown(hit.rawName)}](${target})`;
        const braced = line[hit.hitStartChar] === '{';
        const start = braced ? hit.hitStartChar : hit.range.start.character;
        const end = braced ? hit.hitEndChar : hit.range.end.character;
        line = line.slice(0, start) + link + line.slice(end);
    }
    return line;
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
    // The @ stays outside the bold: a ** between punctuation (@) and a letter always
    // opens bold in CommonMark, even right after a letter (Scope::name@**local**).
    const boldLeaf = `@**${escapedLeaf}**`;
    if (!symbolTable) {
        return boldLeaf;
    }
    const boundaryLine = findPreviousCheapLocalBoundary(document, defLine);
    if (boundaryLine >= 0) {
        const boundaryEntity = findCheapLocalBoundaryEntity(symbolTable, boundaryLine);
        if (boundaryEntity) {
            const { prefixParts, leaf } = formatQualifiedPrefixAndLeaf(boundaryEntity);
            const qualifiedBoundary = [...prefixParts, leaf].map(escapeInlineMarkdown).join('::');
            return `${qualifiedBoundary}${boldLeaf}`;
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
    // An import nothing in the workspace defines, provided by the cc65 runtime library.
    if (entity instanceof Import && isCc65RuntimeSymbol(entity.name)) {
        return {
            segment: entity.segment,
            badges: ['cc65 runtime'],
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
    document: TextDocument,
    implicitImports: boolean = false,
    docOptions: DocCommentOptions = {}
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
    const renderedDoc = renderDefinitionDocMarkdown(document, defLine, { ...docOptions, implicitImports });
    if (renderedDoc) {
        sections.push(renderedDoc);
    }
    return sections.join('\n\n');
}

export function generateCheapLocalHoverMarkdown(
    label: string,
    defRange: Range,
    document: TextDocument,
    symbolTable?: SymbolTable,
    implicitImports: boolean = false,
    binIncludeDirs?: string[],
    docOptions: DocCommentOptions = {}
): string {
    const defLine = defRange.start.line;
    const signatureMarkdown = formatCheapLocalMarkdownName(label, document, defLine, symbolTable);

    // Assigned (@x = r0): show it like a constant, with the expression it stands for.
    const assignment = parseCheapLocalAssignment(
        maskCommentsAtDocumentLine(document, defLine, undefined, docOptions.cComments),
        label
    );
    if (assignment) {
        const trailingParts = assignment.expression
            ? [`${assignment.operator === '.set' ? '.set' : '='} \`${assignment.expression.replace(/`/g, '\\`')}\``]
            : [];
        return assembleEntityHoverMarkdown(
            {
                badges: [assignment.operator === '.set' ? 'var' : 'const'],
                signatureMarkdown,
                trailingParts,
            },
            defLine,
            document,
            implicitImports,
            docOptions
        );
    }

    const segment = getEffectiveSegmentAtLine(symbolTable, defLine);
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
        document,
        implicitImports,
        docOptions
    );
}

export function generateSymbolTableEntityMarkdown(
    entity: SymbolTableEntity,
    document: TextDocument,
    implicitImports: boolean = false,
    binIncludeDirs?: string[],
    docOptions: DocCommentOptions = {}
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
        document,
        implicitImports,
        docOptions
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

/**
 * A Markdown table with its columns padded to line up as plain text, for clients that
 * show hover Markdown unrendered (e.g. Neovim). Widths ignore backticks, since those
 * clients hide them; renderers that draw the table (VS Code) ignore the padding.
 */
function formatMarkdownTable(header: string[], align: ('left' | 'center')[], rows: string[][]): string {
    const visibleWidth = (cell: string) => cell.replace(/`/g, '').length;
    const widths = header.map((h, i) => Math.max(visibleWidth(h), ...rows.map(r => visibleWidth(r[i])), 3));
    const pad = (cell: string, i: number) => cell + ' '.repeat(widths[i] - visibleWidth(cell));
    const line = (cells: string[]) => `| ${cells.map(pad).join(' | ')} |\n`;
    const rule = widths.map((w, i) => align[i] === 'center' ? `:${'-'.repeat(w - 2)}:` : `:${'-'.repeat(w - 1)}`);
    return line(header) + `| ${rule.join(' | ')} |\n` + rows.map(line).join('');
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
            const rows = modeEntries.map(([modeName, info]) =>
                [modeName, `\`${info.opcode}\``, formatModeBytes(info), formatModeCycles(info)]);
            markdown += formatMarkdownTable(['Mode', 'Opcode', 'Bytes', 'Cycles'], ['left', 'center', 'center', 'center'], rows);
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
