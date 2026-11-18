/**
 * cc65 inline assembly (`__asm__("lda #%b", x);` / `asm("nop");`) support helpers.
 *
 * For a C document we build an "embedded" ca65 document with exactly the same lines and columns:
 * every character outside inline asm string literals becomes a space, and the string contents are
 * kept (with C escapes and cc65 format specifiers neutralized). Language features inside inline asm
 * are then answered by the ca65 language server on that embedded document, and positions map 1:1.
 *
 * This module has no dependency on the `vscode` API so it can be unit tested.
 */

/** URI scheme of the embedded ca65 documents (must match the server). */
export const EMBEDDED_ASM_SCHEME = 'ca65-inline';
/** Suffix appended to the C file's path to form the embedded document's path (gives it the ca65 language). */
export const EMBEDDED_ASM_SUFFIX = '.inline.s';

/** Offsets [start, end) of the contents of one string literal that is (part of) an inline asm template. */
export interface InlineAsmRegion {
    start: number;
    end: number;
}

/** cc65 inline asm format specifiers (`%b` byte, `%w` word, `%l` long, `%v` variable, `%o` stack offset, `%g` label, `%s` string). */
const FORMAT_SPECIFIERS = new Set(['b', 'w', 'l', 'v', 'o', 'g', 's']);

function isIdentStart(ch: string): boolean {
    return (ch >= 'a' && ch <= 'z') || (ch >= 'A' && ch <= 'Z') || ch === '_';
}

function isIdentChar(ch: string): boolean {
    return isIdentStart(ch) || (ch >= '0' && ch <= '9');
}

/** Index just past the end of a string/char literal starting at `start` (the opening quote). */
function skipQuoted(text: string, start: number, quote: string): number {
    let i = start + 1;
    while (i < text.length) {
        const ch = text[i];
        if (ch === '\\') {
            i += 2;
            continue;
        }
        if (ch === quote) return i + 1;
        if (ch === '\n') return i; // unterminated
        i++;
    }
    return i;
}

/** Skips whitespace and comments. */
function skipTrivia(text: string, start: number): number {
    let i = start;
    while (i < text.length) {
        const ch = text[i];
        if (ch === ' ' || ch === '\t' || ch === '\r' || ch === '\n') {
            i++;
        } else if (ch === '/' && text[i + 1] === '/') {
            while (i < text.length && text[i] !== '\n') i++;
        } else if (ch === '/' && text[i + 1] === '*') {
            const close = text.indexOf('*/', i + 2);
            i = close < 0 ? text.length : close + 2;
        } else {
            break;
        }
    }
    return i;
}

/**
 * Finds the string literal contents of every `asm(...)` / `__asm__(...)` template in C source,
 * including adjacent literals that C concatenates (`__asm__("jsr foo" " ; comment")`).
 */
export function findInlineAsmRegions(text: string): InlineAsmRegion[] {
    const regions: InlineAsmRegion[] = [];
    let i = 0;
    while (i < text.length) {
        const ch = text[i];
        if (ch === '/' && (text[i + 1] === '/' || text[i + 1] === '*')) {
            i = skipTrivia(text, i);
            continue;
        }
        if (ch === '"' || ch === '\'') {
            i = skipQuoted(text, i, ch);
            continue;
        }
        if (isIdentStart(ch) && (i === 0 || !isIdentChar(text[i - 1]))) {
            let j = i + 1;
            while (j < text.length && isIdentChar(text[j])) j++;
            const ident = text.slice(i, j);
            i = j;
            if (ident !== 'asm' && ident !== '__asm__') continue;

            let k = skipTrivia(text, j);
            if (text[k] !== '(') continue;
            k = skipTrivia(text, k + 1);
            while (text[k] === '"') {
                const after = skipQuoted(text, k, '"');
                const closed = text[after - 1] === '"' && after - 1 > k;
                regions.push({ start: k + 1, end: closed ? after - 1 : after });
                k = skipTrivia(text, after);
            }
            i = k;
            continue;
        }
        i++;
    }
    return regions;
}

/**
 * Builds the embedded ca65 document text for a C source: same length and line structure, with only
 * inline asm contents kept. C escapes become spaces (`\"` -> ` "`), `%%` becomes ` %`, and cc65 format
 * specifiers (`%b`, `%v`, ...) become blanks.
 */
export function buildEmbeddedAsmText(text: string, regions: InlineAsmRegion[] = findInlineAsmRegions(text)): string {
    const out = new Array<string>(text.length);
    for (let i = 0; i < text.length; i++) {
        const ch = text[i];
        out[i] = ch === '\n' || ch === '\r' ? ch : ' ';
    }
    for (const { start, end } of regions) {
        let k = start;
        while (k < end) {
            const ch = text[k];
            if (ch === '\\' && k + 1 < end) {
                const next = text[k + 1];
                out[k] = ' ';
                out[k + 1] = next === '"' || next === '\\' || next === '\'' ? next : ' ';
                k += 2;
            } else if (ch === '%' && k + 1 < end) {
                const next = text[k + 1];
                if (next === '%') {
                    out[k] = ' ';
                    out[k + 1] = '%';
                    k += 2;
                } else if (FORMAT_SPECIFIERS.has(next)) {
                    out[k] = ' ';
                    out[k + 1] = ' ';
                    k += 2;
                } else {
                    out[k] = ch;
                    k++;
                }
            } else {
                out[k] = ch;
                k++;
            }
        }
    }
    return out.join('');
}

/** The inline asm region containing `offset` (inclusive of the closing quote position), if any. */
export function findRegionAt(regions: InlineAsmRegion[], offset: number): InlineAsmRegion | undefined {
    let lo = 0;
    let hi = regions.length - 1;
    while (lo <= hi) {
        const mid = (lo + hi) >> 1;
        const r = regions[mid];
        if (offset < r.start) hi = mid - 1;
        else if (offset > r.end) lo = mid + 1;
        else return r;
    }
    return undefined;
}

/** Cheap pre-check before scanning a file for inline asm. */
export function mayContainInlineAsm(text: string): boolean {
    return /\b(?:__asm__|asm)\s*\(/.test(text);
}

/** `/ws/src/main.c` -> `/ws/src/main.c.inline.s` (path of the embedded document). */
export function embeddedPathForHostPath(hostPath: string): string {
    return `${hostPath}${EMBEDDED_ASM_SUFFIX}`;
}

/** Inverse of {@link embeddedPathForHostPath}. */
export function hostPathForEmbeddedPath(embeddedPath: string): string | undefined {
    return embeddedPath.endsWith(EMBEDDED_ASM_SUFFIX)
        ? embeddedPath.slice(0, -EMBEDDED_ASM_SUFFIX.length)
        : undefined;
}
