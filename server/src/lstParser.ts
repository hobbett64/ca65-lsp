import * as path from 'path';
import { fsPathToUri, resolveIncludeUri } from './pathUtils';

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
    lastSourceStart?: number;
    lastSourceEnd?: number;
}

const INCLUDE_DIR_REGEX = /\.include\s+(['"])([^'"]+)\1/i;

function isHexCharCode(code: number): boolean {
    return (code >= 48 && code <= 57) // 0-9
        || (code >= 65 && code <= 70) // A-F
        || (code >= 97 && code <= 102); // a-f
}

function hexVal(code: number): number {
    if (code >= 48 && code <= 57) return code - 48;
    if (code >= 65 && code <= 70) return code - 55;
    return code - 87;
}

function isWhitespaceCode(code: number): boolean {
    return code === 32 || code === 9 || code === 11 || code === 12 || code === 160;
}

function isValidLstBytePair(str: string, pos: number): boolean {
    const c0 = str.charCodeAt(pos);
    const c1 = str.charCodeAt(pos + 1);
    return (isHexCharCode(c0) && isHexCharCode(c1))
        || (c0 === 120 && c1 === 120) // 'xx'
        || (c0 === 114 && c1 === 114); // 'rr'
}

function extractByteTokensFromRange(str: string, start: number, end: number): { text: string; count: number } {
    let i = start;
    let count = 0;
    let text = '';

    while (i < end) {
        while (i < end && isWhitespaceCode(str.charCodeAt(i))) {
            i++;
        }
        if (i >= end) break;
        const tokStart = i;
        while (i < end && !isWhitespaceCode(str.charCodeAt(i))) {
            i++;
        }
        if (i - tokStart === 2 && isValidLstBytePair(str, tokStart)) {
            const tok = str.slice(tokStart, i);
            text = count === 0 ? tok : `${text} ${tok}`;
            count++;
        }
    }

    return { text, count };
}

function hasNonWhitespaceInRange(str: string, start: number, end: number): boolean {
    for (let i = start; i < end; i++) {
        if (!isWhitespaceCode(str.charCodeAt(i))) {
            return true;
        }
    }
    return false;
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

    let lineStart = 0;
    const contentLen = lstContent.length;
    while (lineStart <= contentLen) {
        const nl = lstContent.indexOf('\n', lineStart);
        const rawEnd = nl === -1 ? contentLen : nl;
        const lineEnd = (rawEnd > lineStart && lstContent.charCodeAt(rawEnd - 1) === 13) ? rawEnd - 1 : rawEnd;
        const lineLen = lineEnd - lineStart;

        if (lineLen > 0) {
            if (lineLen >= 9 && lstContent.charCodeAt(lineStart) === 77 && lstContent.startsWith('Main file', lineStart)) {
                const rawLine = lstContent.slice(lineStart, lineEnd);
                const mainFileMatch = rawLine.match(/^Main file\s*:\s*(.+)$/);
                if (mainFileMatch) {
                    const candidate = mainFileMatch[1].trim();
                    if (candidate && path.isAbsolute(candidate) && stack.length === 1 && stack[0].nextLine === 0) {
                        // Only override rootUri when `Main file` isn't a temporary shadow path
                        if (!candidate.includes('ca65-lsp-')) {
                            activeRootUri = fsPathToUri(candidate);
                            stack[0].uri = activeRootUri;
                        }
                    }
                }
            } else if (
                lineLen >= 9
                && isHexCharCode(lstContent.charCodeAt(lineStart))
                && isHexCharCode(lstContent.charCodeAt(lineStart + 1))
                && isHexCharCode(lstContent.charCodeAt(lineStart + 2))
                && isHexCharCode(lstContent.charCodeAt(lineStart + 3))
                && isHexCharCode(lstContent.charCodeAt(lineStart + 4))
                && isHexCharCode(lstContent.charCodeAt(lineStart + 5))
                && (lstContent.charCodeAt(lineStart + 6) === 114 || lstContent.charCodeAt(lineStart + 6) === 32)
                && lstContent.charCodeAt(lineStart + 7) === 32
            ) {
                let p = lineStart + 8;
                while (p < lineEnd && isWhitespaceCode(lstContent.charCodeAt(p))) {
                    p++;
                }
                const digitStart = p;
                let depth = 0;
                while (p < lineEnd) {
                    const c = lstContent.charCodeAt(p);
                    if (c < 48 || c > 57) break;
                    depth = depth * 10 + (c - 48);
                    p++;
                }

                if (p > digitStart && depth >= 1) {
                    const prefixLen = p - lineStart;
                    const relocFlag = lstContent.charCodeAt(lineStart + 6) === 114;

                    // `ca65` puts up to 4 byte pairs in columns 11..23.
                    // Compute split relative to column 24 when possible so source indentation isn't eaten.
                    const sourceColStart = Math.min(24, lineLen);
                    const byteSliceEnd = Math.max(prefixLen, sourceColStart);
                    const bytes = extractByteTokensFromRange(lstContent, lineStart + prefixLen, lineStart + byteSliceEnd);
                    const sourceStartOffset = lineStart + (lineLen > 24 ? 24 : Math.min(lineLen, prefixLen + 14));
                    const hasSource = hasNonWhitespaceInRange(lstContent, sourceStartOffset, lineEnd);

                    // Pop frames when exiting `.include` files
                    while (stack.length > depth) {
                        stack.pop();
                    }

                    // Push new frame when entering an `.include` file
                    if (depth > stack.length) {
                        const parentFrame = stack[stack.length - 1];
                        let childUri: string | null = null;
                        if (
                            parentFrame?.uri
                            && parentFrame.lastSourceStart !== undefined
                            && parentFrame.lastSourceEnd !== undefined
                            && parentFrame.lastSourceEnd > parentFrame.lastSourceStart
                        ) {
                            const parentSource = lstContent.slice(parentFrame.lastSourceStart, parentFrame.lastSourceEnd);
                            const incMatch = parentSource.match(INCLUDE_DIR_REGEX);
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
                    if (frame) {
                        // Continuation byte line: has bytes in the byte column and no source text at col 24+
                        if (bytes.count > 0 && !hasSource && frame.lastItem) {
                            frame.lastItem.bytesText = frame.lastItem.bytesText
                                ? `${frame.lastItem.bytesText} ${bytes.text}`
                                : bytes.text;
                            frame.lastItem.byteCount += bytes.count;
                        } else {
                            const lineNum = frame.nextLine++;
                            if (hasSource) {
                                frame.lastSourceStart = sourceStartOffset;
                                frame.lastSourceEnd = lineEnd;
                            } else {
                                frame.lastSourceStart = undefined;
                                frame.lastSourceEnd = undefined;
                            }

                            const offset = (hexVal(lstContent.charCodeAt(lineStart)) << 20)
                                | (hexVal(lstContent.charCodeAt(lineStart + 1)) << 16)
                                | (hexVal(lstContent.charCodeAt(lineStart + 2)) << 12)
                                | (hexVal(lstContent.charCodeAt(lineStart + 3)) << 8)
                                | (hexVal(lstContent.charCodeAt(lineStart + 4)) << 4)
                                | hexVal(lstContent.charCodeAt(lineStart + 5));

                            const trimOffset = lstContent.charCodeAt(lineStart) === 48
                                ? (lstContent.charCodeAt(lineStart + 1) === 48 ? 2 : 1)
                                : 0;

                            const entry: LstLineInfo = {
                                line: lineNum,
                                offset,
                                offsetHex: lstContent.slice(lineStart + trimOffset, lineStart + 6),
                                isRelocatable: relocFlag,
                                bytesText: bytes.text,
                                byteCount: bytes.count,
                            };
                            frame.lastItem = entry;

                            if (frame.uri && bytes.count > 0) {
                                getOrCreateUriMap(frame.uri).set(lineNum, entry);
                            }
                        }
                    }
                }
            }
        }

        if (nl === -1) break;
        lineStart = nl + 1;
    }

    return byUri;
}
