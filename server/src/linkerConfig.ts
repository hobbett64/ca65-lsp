import * as fsSync from 'fs';
import * as path from 'path';
import { Position, Range } from 'vscode-languageserver/node';
import { TextDocument } from 'vscode-languageserver-textdocument';
import { maskCommentsAtDocumentLine } from './documentScanner';
import { fsPathToUri, getWorkspaceFolderOfFile, uriToFsPath } from './pathUtils';
import { Ca65Settings } from './settings';
import { LabelSegmentCategory, SegmentAddrSize } from './symbolTable';

export interface LinkerMemoryArea {
    name: string;
    attrs: Record<string, string>;
    uri: string;
    range: Range;
}

export interface LinkerSegmentDef {
    name: string;
    attrs: Record<string, string>;
    uri: string;
    range: Range;
}

export interface LinkerConfigData {
    fsPath: string;
    uri: string;
    memoryAreas: Map<string, LinkerMemoryArea>;
    memoryAreasUpper: Map<string, LinkerMemoryArea>;
    memoryOrder: LinkerMemoryArea[];
    segments: Map<string, LinkerSegmentDef>;
    segmentsUpper: Map<string, LinkerSegmentDef>;
    segmentOrder: LinkerSegmentDef[];
}

export interface LiveDocProvider {
    get(uri: string): TextDocument | undefined;
}

interface CachedLinkerConfigEntry {
    mtimeMs: number;
    liveVersion?: number;
    data: LinkerConfigData;
}

const linkerConfigCache = new Map<string, CachedLinkerConfigEntry>();

export function clearLinkerConfigCache(): void {
    linkerConfigCache.clear();
}

/**
 * Strips `#` line comments outside double-quoted strings while keeping line/column offsets intact.
 */
function stripCfgCommentsPreservingOffsets(text: string): string {
    const out: string[] = [];
    let inQuote = false;
    let inComment = false;

    for (let i = 0; i < text.length; i++) {
        const ch = text[i];
        if (ch === '\n' || ch === '\r') {
            inComment = false;
            inQuote = false;
            out.push(ch);
            continue;
        }
        if (inComment) {
            out.push(' ');
            continue;
        }
        if (ch === '"' && (i === 0 || text[i - 1] !== '\\')) {
            inQuote = !inQuote;
            out.push(ch);
            continue;
        }
        if (!inQuote && ch === '#') {
            inComment = true;
            out.push(' ');
            continue;
        }
        out.push(ch);
    }

    return out.join('');
}

function buildLineStarts(text: string): number[] {
    const starts = [0];
    for (let i = 0; i < text.length; i++) {
        if (text.charCodeAt(i) === 10 /* \n */) {
            starts.push(i + 1);
        }
    }
    return starts;
}

function offsetToPosition(lineStarts: readonly number[], offset: number): Position {
    let lo = 0;
    let hi = lineStarts.length - 1;
    while (lo < hi) {
        const mid = (lo + hi + 1) >> 1;
        if (lineStarts[mid] <= offset) {
            lo = mid;
        } else {
            hi = mid - 1;
        }
    }
    return Position.create(lo, Math.max(0, offset - lineStarts[lo]));
}

function findBlockBody(strippedText: string, blockName: string): { bodyStart: number; bodyEnd: number } | null {
    const re = new RegExp(`\\b${blockName}\\s*\\{`, 'gi');
    let m: RegExpExecArray | null;
    while ((m = re.exec(strippedText)) !== null) {
        const openBraceOffset = m.index + m[0].length - 1;
        let depth = 0;
        let inQuote = false;
        for (let i = openBraceOffset; i < strippedText.length; i++) {
            const ch = strippedText[i];
            if (ch === '"' && (i === 0 || strippedText[i - 1] !== '\\')) {
                inQuote = !inQuote;
                continue;
            }
            if (inQuote) continue;
            if (ch === '{') depth++;
            else if (ch === '}') {
                depth--;
                if (depth === 0) {
                    return { bodyStart: openBraceOffset + 1, bodyEnd: i };
                }
            }
        }
    }
    return null;
}

function unquoteCfgIdent(raw: string): string {
    const trimmed = raw.trim();
    if (trimmed.length >= 2 && trimmed.startsWith('"') && trimmed.endsWith('"')) {
        return trimmed.slice(1, -1);
    }
    return trimmed;
}

function parseCfgAttributes(rawAttrs: string): Record<string, string> {
    const attrs: Record<string, string> = {};
    const parts: string[] = [];
    let start = 0;
    let inQuote = false;
    for (let i = 0; i < rawAttrs.length; i++) {
        const ch = rawAttrs[i];
        if (ch === '"' && (i === 0 || rawAttrs[i - 1] !== '\\')) {
            inQuote = !inQuote;
        } else if (!inQuote && ch === ',') {
            parts.push(rawAttrs.slice(start, i));
            start = i + 1;
        }
    }
    parts.push(rawAttrs.slice(start));

    for (const part of parts) {
        const eqIdx = part.indexOf('=');
        if (eqIdx < 0) continue;
        const key = part.slice(0, eqIdx).trim().toLowerCase();
        const val = unquoteCfgIdent(part.slice(eqIdx + 1));
        if (key) {
            attrs[key] = val;
        }
    }
    return attrs;
}

function parseCfgEntries(
    strippedText: string,
    lineStarts: readonly number[],
    bodyStart: number,
    bodyEnd: number,
    uri: string
): Array<{ name: string; attrs: Record<string, string>; uri: string; range: Range }> {
    const entries: Array<{ name: string; attrs: Record<string, string>; uri: string; range: Range }> = [];
    let stmtStart = bodyStart;
    let inQuote = false;

    const processStatement = (startOffset: number, endOffset: number) => {
        const rawStmt = strippedText.slice(startOffset, endOffset);
        const colonIdx = rawStmt.indexOf(':');
        if (colonIdx < 0) return;

        const nameRegion = rawStmt.slice(0, colonIdx);
        const nameMatch = nameRegion.match(/^\s*("(?:\\.|[^"])*"|[a-zA-Z0-9_.$@+-]+)\s*$/);
        if (!nameMatch) return;

        const rawToken = nameMatch[1];
        const name = unquoteCfgIdent(rawToken);
        if (!name) return;

        const tokenLeadingWs = nameRegion.indexOf(rawToken);
        const tokenOffset = startOffset + tokenLeadingWs + (rawToken.startsWith('"') ? 1 : 0);
        const tokenEnd = tokenOffset + name.length;
        const range = Range.create(
            offsetToPosition(lineStarts, tokenOffset),
            offsetToPosition(lineStarts, tokenEnd)
        );
        const attrs = parseCfgAttributes(rawStmt.slice(colonIdx + 1));
        entries.push({ name, attrs, uri, range });
    };

    for (let i = bodyStart; i < bodyEnd; i++) {
        const ch = strippedText[i];
        if (ch === '"' && (i === 0 || strippedText[i - 1] !== '\\')) {
            inQuote = !inQuote;
        } else if (!inQuote && ch === ';') {
            processStatement(stmtStart, i);
            stmtStart = i + 1;
        }
    }
    if (stmtStart < bodyEnd) {
        processStatement(stmtStart, bodyEnd);
    }
    return entries;
}

export function parseLinkerConfig(text: string, fsPath: string, uri: string): LinkerConfigData {
    const stripped = stripCfgCommentsPreservingOffsets(text);
    const lineStarts = buildLineStarts(stripped);

    const memoryAreas = new Map<string, LinkerMemoryArea>();
    const memoryAreasUpper = new Map<string, LinkerMemoryArea>();
    const memoryOrder: LinkerMemoryArea[] = [];
    const memBlock = findBlockBody(stripped, 'MEMORY');
    if (memBlock) {
        for (const entry of parseCfgEntries(stripped, lineStarts, memBlock.bodyStart, memBlock.bodyEnd, uri)) {
            memoryAreas.set(entry.name, entry);
            memoryAreasUpper.set(entry.name.toUpperCase(), entry);
            memoryOrder.push(entry);
        }
    }

    const segments = new Map<string, LinkerSegmentDef>();
    const segmentsUpper = new Map<string, LinkerSegmentDef>();
    const segmentOrder: LinkerSegmentDef[] = [];
    const segBlock = findBlockBody(stripped, 'SEGMENTS');
    if (segBlock) {
        for (const entry of parseCfgEntries(stripped, lineStarts, segBlock.bodyStart, segBlock.bodyEnd, uri)) {
            segments.set(entry.name, entry);
            segmentsUpper.set(entry.name.toUpperCase(), entry);
            segmentOrder.push(entry);
        }
    }

    return {
        fsPath,
        uri,
        memoryAreas,
        memoryAreasUpper,
        memoryOrder,
        segments,
        segmentsUpper,
        segmentOrder,
    };
}

export function resolveLinkerConfigFsPath(fileUri: string, configuredPath: string | undefined): string | null {
    const trimmed = configuredPath?.trim();
    if (!trimmed) {
        return null;
    }
    if (path.isAbsolute(trimmed)) {
        return path.normalize(trimmed);
    }
    const workspaceUri = getWorkspaceFolderOfFile(fileUri);
    const baseFsPath = workspaceUri
        ? uriToFsPath(workspaceUri)
        : path.dirname(uriToFsPath(fileUri));
    return path.resolve(baseFsPath, trimmed);
}

export function loadLinkerConfigForUri(
    fileUri: string,
    settings: Pick<Ca65Settings, 'linkerConfig'> | undefined,
    liveDocs?: LiveDocProvider
): LinkerConfigData | null {
    const cfgFsPath = resolveLinkerConfigFsPath(fileUri, settings?.linkerConfig);
    if (!cfgFsPath) {
        return null;
    }
    const cfgUri = fsPathToUri(cfgFsPath);
    const liveDoc = liveDocs?.get(cfgUri);
    if (liveDoc) {
        const cached = linkerConfigCache.get(cfgFsPath);
        if (cached && cached.liveVersion === liveDoc.version) {
            return cached.data;
        }
        const parsed = parseLinkerConfig(liveDoc.getText(), cfgFsPath, cfgUri);
        linkerConfigCache.set(cfgFsPath, { mtimeMs: -1, liveVersion: liveDoc.version, data: parsed });
        return parsed;
    }

    try {
        const stat = fsSync.statSync(cfgFsPath);
        if (!stat.isFile()) {
            return null;
        }
        const cached = linkerConfigCache.get(cfgFsPath);
        if (cached && cached.liveVersion === undefined && cached.mtimeMs === stat.mtimeMs) {
            return cached.data;
        }
        const raw = fsSync.readFileSync(cfgFsPath, 'utf8');
        const parsed = parseLinkerConfig(raw, cfgFsPath, cfgUri);
        linkerConfigCache.set(cfgFsPath, { mtimeMs: stat.mtimeMs, data: parsed });
        return parsed;
    } catch {
        linkerConfigCache.delete(cfgFsPath);
        return null;
    }
}

export function lookupLinkerSegment(
    config: LinkerConfigData | null | undefined,
    segmentName: string | null | undefined
): LinkerSegmentDef | undefined {
    if (!config || !segmentName) return undefined;
    return config.segments.get(segmentName) ?? config.segmentsUpper.get(segmentName.toUpperCase());
}

export function lookupLinkerMemory(
    config: LinkerConfigData | null | undefined,
    memoryName: string | null | undefined
): LinkerMemoryArea | undefined {
    if (!config || !memoryName) return undefined;
    return config.memoryAreas.get(memoryName) ?? config.memoryAreasUpper.get(memoryName.toUpperCase());
}

export function getLinkerSegmentAddrSize(
    config: LinkerConfigData | null | undefined,
    segmentName: string | null | undefined
): SegmentAddrSize | undefined {
    const seg = lookupLinkerSegment(config, segmentName);
    if (!seg) return undefined;
    const rawType = seg.attrs.type?.toLowerCase();
    if (rawType === 'zp') return 'zp';
    return undefined;
}

export function classifyLinkerSegmentCategory(
    config: LinkerConfigData | null | undefined,
    segmentName: string | null | undefined
): LabelSegmentCategory | null {
    const seg = lookupLinkerSegment(config, segmentName);
    if (!seg) return null;
    const rawType = seg.attrs.type?.toLowerCase();
    switch (rawType) {
        case 'zp':
        case 'bss':
            return 'bss';
        case 'rw':
            return 'data';
        case 'ro':
            return 'rodata';
        default:
            return null;
    }
}

export function formatLinkerSegmentDetail(config: LinkerConfigData, seg: LinkerSegmentDef): string {
    const parts: string[] = [];
    if (seg.attrs.type) parts.push(`type=${seg.attrs.type}`);
    if (seg.attrs.load) parts.push(`load=${seg.attrs.load}`);
    if (seg.attrs.run && seg.attrs.run !== seg.attrs.load) parts.push(`run=${seg.attrs.run}`);
    if (parts.length === 0) return 'Linker segment';
    const memName = seg.attrs.run || seg.attrs.load;
    const mem = lookupLinkerMemory(config, memName);
    if (mem?.attrs.start && mem?.attrs.size) {
        parts.push(`${mem.attrs.start}, ${mem.attrs.size}`);
    }
    return parts.join(' · ');
}

export function formatLinkerSegmentMarkdown(config: LinkerConfigData, seg: LinkerSegmentDef): string {
    const summaryParts: string[] = [];
    for (const key of ['type', 'load', 'run', 'start', 'align', 'offset', 'optional']) {
        if (seg.attrs[key]) {
            summaryParts.push(`${key}: \`${seg.attrs[key]}\``);
        }
    }
    const lines: string[] = [`\`${seg.name}\` segment`];
    if (summaryParts.length > 0) {
        lines.push(summaryParts.join(' · '));
    }

    const memSeen = new Set<string>();
    for (const memAttr of ['load', 'run'] as const) {
        const memName = seg.attrs[memAttr];
        if (!memName || memSeen.has(memName)) continue;
        memSeen.add(memName);
        const mem = lookupLinkerMemory(config, memName);
        if (mem) {
            const memDetails = [
                mem.attrs.start ? `start \`${mem.attrs.start}\`` : '',
                mem.attrs.size ? `size \`${mem.attrs.size}\`` : '',
                mem.attrs.type ? `type \`${mem.attrs.type}\`` : '',
            ].filter(Boolean).join(', ');
            if (memDetails) {
                lines.push(`Memory \`${mem.name}\`: ${memDetails}`);
            }
        }
    }

    return lines.join('\n\n');
}

export interface SegmentDirectiveHit {
    segmentName: string;
    nameRange: Range;
}

const SEGMENT_DIRECTIVE_ON_LINE_RE = /^(\s*(?:[a-zA-Z_@.][a-zA-Z0-9_@.]*:\s*)?\.segment\s+")([^"]*)(")/i;
const BUILTIN_SEGMENT_DIRECTIVE_ON_LINE_RE = /^(\s*(?:[a-zA-Z_@.][a-zA-Z0-9_@.]*:\s*)?)(\.(?:bss|code|data|rodata|zeropage))(?![a-zA-Z0-9_@])/i;

export function findSegmentDirectiveInLine(
    lineText: string,
    lineNumber: number,
    cComments: boolean = true,
    document?: TextDocument
): SegmentDirectiveHit | null {
    const code = document
        ? maskCommentsAtDocumentLine(document, lineNumber, undefined, cComments)
        : lineText;
    const m = code.match(SEGMENT_DIRECTIVE_ON_LINE_RE);
    if (!m || !m[2]) {
        return null;
    }
    const startChar = m[1].length;
    const endChar = startChar + m[2].length;
    return {
        segmentName: m[2],
        nameRange: Range.create(lineNumber, startChar, lineNumber, endChar),
    };
}

export function findSegmentDirectiveAtPosition(
    document: TextDocument,
    position: Position,
    cComments: boolean = true
): SegmentDirectiveHit | null {
    if (position.line < 0 || position.line >= document.lineCount) {
        return null;
    }
    const hit = findSegmentDirectiveInLine('', position.line, cComments, document);
    if (!hit) {
        return null;
    }
    // Accept cursor inside `"NAME"` (including the surrounding quotes)
    if (position.character >= hit.nameRange.start.character - 1 && position.character <= hit.nameRange.end.character + 1) {
        return hit;
    }
    return null;
}

export function findBuiltinSegmentDirectiveAtPosition(
    document: TextDocument,
    position: Position,
    cComments: boolean = true
): SegmentDirectiveHit | null {
    if (position.line < 0 || position.line >= document.lineCount) {
        return null;
    }
    const code = maskCommentsAtDocumentLine(document, position.line, undefined, cComments);
    const m = code.match(BUILTIN_SEGMENT_DIRECTIVE_ON_LINE_RE);
    if (!m) {
        return null;
    }
    const startChar = m[1].length;
    const endChar = startChar + m[2].length;
    if (position.character < startChar || position.character > endChar) {
        return null;
    }
    return {
        segmentName: m[2].slice(1).toUpperCase(),
        nameRange: Range.create(position.line, startChar, position.line, endChar),
    };
}
