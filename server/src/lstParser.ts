import * as path from 'path';
import { URI } from 'vscode-uri';
import { resolveIncludeUri } from './pathUtils';

export interface LstLineInfo {
    line: number; // 0-based
    offset: number;
    offsetHex: string;
    isRelocatable: boolean;
    bytesText: string;
    byteCount: number;
}

interface IncludeStackFrame {
    uri: string | null;
    nextLine: number;
    lastItem?: LstLineInfo;
    lastSourceText?: string;
}

const LST_LINE_REGEX = /^([0-9a-fA-F]{6})(r| ) (\s*\d+)(.*)$/;

function extractByteTokens(rawByteRegion: string): { text: string; count: number } {
    const tokens = rawByteRegion
        .trim()
        .split(/\s+/)
        .filter(tok => /^[0-9a-fA-F]{2}$|^xx$|^rr$/.test(tok));
    return {
        text: tokens.join(' '),
        count: tokens.length,
    };
}

/**
 * Parses a `ca65 -l` listing file into per-URI, 0-based line entries.
 * Correctly handles nested `.include` depth tracking and multi-line byte continuations.
 */
export function parseLstContent(
    lstContent: string,
    rootUri: string,
    includeDirs: string[]
): Map<string, Map<number, LstLineInfo>> {
    const byUri = new Map<string, Map<number, LstLineInfo>>();
    const getOrCreateUriMap = (uri: string): Map<number, LstLineInfo> => {
        let map = byUri.get(uri);
        if (!map) {
            map = new Map();
            byUri.set(uri, map);
        }
        return map;
    };

    let activeRootUri = rootUri;
    const stack: IncludeStackFrame[] = [{ uri: activeRootUri, nextLine: 0 }];

    for (const rawLine of lstContent.split(/\r?\n/)) {
        const mainFileMatch = rawLine.match(/^Main file\s*:\s*(.+)$/);
        if (mainFileMatch) {
            const candidate = mainFileMatch[1].trim();
            if (candidate && path.isAbsolute(candidate) && stack.length === 1 && stack[0].nextLine === 0) {
                // Only override rootUri when `Main file` isn't a temporary shadow path
                if (!candidate.includes('ca65-lsp-')) {
                    activeRootUri = URI.file(candidate).toString();
                    stack[0].uri = activeRootUri;
                }
            }
            continue;
        }

        const match = rawLine.match(LST_LINE_REGEX);
        if (!match) continue;

        const [, offsetHex, relocFlag, depthStr, tail] = match;
        const depth = parseInt(depthStr.trim(), 10);
        if (!Number.isFinite(depth) || depth < 1) continue;

        // `ca65` puts up to 4 byte pairs in columns 11..23 (i.e. 14 chars after `<offset><r> <depth>`).
        // Compute split relative to column 24 when possible so source indentation isn't eaten.
        const sourceColStart = Math.min(24, rawLine.length);
        const prefixLen = 8 + depthStr.length;
        const byteSliceEnd = Math.max(prefixLen, sourceColStart);
        const byteRegion = rawLine.slice(prefixLen, byteSliceEnd);
        const sourcePart = rawLine.length > 24 ? rawLine.slice(24) : tail.slice(Math.min(tail.length, 14));
        const bytes = extractByteTokens(byteRegion);

        // Pop frames when exiting `.include` files
        while (stack.length > depth) {
            stack.pop();
        }

        // Push new frame when entering an `.include` file
        if (depth > stack.length) {
            const parentFrame = stack[stack.length - 1];
            let childUri: string | null = null;
            if (parentFrame?.uri && parentFrame.lastSourceText) {
                const incMatch = parentFrame.lastSourceText.match(/\.include\s+(['"])([^'"]+)\1/i);
                if (incMatch) {
                    childUri = resolveIncludeUri(parentFrame.uri, incMatch[2], includeDirs);
                }
            }
            while (stack.length < depth) {
                stack.push({ uri: childUri, nextLine: 0 });
                childUri = null;
            }
        }

        const frame = stack[depth - 1];
        if (!frame) continue;

        // Continuation byte line: has bytes in the byte column and no source text at col 24+
        if (bytes.count > 0 && sourcePart.trim().length === 0 && frame.lastItem) {
            frame.lastItem.bytesText = frame.lastItem.bytesText
                ? `${frame.lastItem.bytesText} ${bytes.text}`
                : bytes.text;
            frame.lastItem.byteCount += bytes.count;
            continue;
        }

        const lineNum = frame.nextLine++;
        frame.lastSourceText = sourcePart;

        const entry: LstLineInfo = {
            line: lineNum,
            offset: parseInt(offsetHex, 16),
            offsetHex: offsetHex.replace(/^0+(?=[0-9a-fA-F]{4}$)/, ''),
            isRelocatable: relocFlag === 'r',
            bytesText: bytes.text,
            byteCount: bytes.count,
        };
        frame.lastItem = entry;

        if (frame.uri && bytes.count > 0) {
            getOrCreateUriMap(frame.uri).set(lineNum, entry);
        }
    }

    return byUri;
}
