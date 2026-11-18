/**
 * Embedded ca65 documents: virtual documents the client derives from C sources, containing only the
 * cc65 inline assembly (`__asm__("...")`) at the same line/column positions (see client/src/inlineAsm.ts).
 * They are indexed like regular asm so inline asm gets hovers, completion, navigation and rename, but
 * they are never assembled and never get diagnostics.
 */
import { URI } from 'vscode-uri';

export const EMBEDDED_ASM_SCHEME = 'ca65-inline';
const EMBEDDED_ASM_SUFFIX = '.inline.s';

export function isEmbeddedUri(uri: string): boolean {
    return uri.startsWith(`${EMBEDDED_ASM_SCHEME}:`);
}

/** `ca65-inline:/ws/main.c.inline.s` -> `file:///ws/main.c` (the C document hosting the inline asm). */
export function embeddedToHostUri(uri: string): string | undefined {
    if (!isEmbeddedUri(uri)) return undefined;
    const parsed = URI.parse(uri);
    if (!parsed.path.endsWith(EMBEDDED_ASM_SUFFIX)) return undefined;
    return parsed.with({ scheme: 'file', path: parsed.path.slice(0, -EMBEDDED_ASM_SUFFIX.length) }).toString();
}
