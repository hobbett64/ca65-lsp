// Unit checks for cc65 inline asm detection and the embedded ca65 document builder (client/src/inlineAsm.ts).
const assert = require('assert');
const path = require('path');

const inline = require(path.resolve(process.cwd(), 'client/out/inlineAsm.js'));

const source = [
    'extern unsigned char counter;',                     // 0
    '// __asm__("not asm, line comment");',               // 1
    '/* asm("not asm, block comment") */',                // 2
    'const char *s = "__asm__(\\"not asm, string\\")";', // 3
    'void f(unsigned char p) {',                          // 4
    '    __asm__("lda #%b", 5);',                         // 5
    '    __asm__ ( "lda %v" , counter);',                 // 6
    '    __asm__("lda #%%10 ; comment \\"quoted\\"");',  // 7
    '    asm("nop");',                                    // 8
    '    __asm__("jsr _helper"',                          // 9
    '            " ; split literal");',                   // 10
    '    __asm__("rts\\t; tab");',                        // 11
    '    my_asm("not asm");',                             // 12
    '}',                                                  // 13
    '#define WAIT() __asm__("nop")',                      // 14
].join('\n') + '\n';

const regions = inline.findInlineAsmRegions(source);
const contents = regions.map(r => source.slice(r.start, r.end));
assert.deepStrictEqual(contents, [
    'lda #%b',
    'lda %v',
    'lda #%%10 ; comment \\"quoted\\"',
    'nop',
    'jsr _helper',
    ' ; split literal',
    'rts\\t; tab',
    'nop',
], `regions: ${JSON.stringify(contents)}`);

const embedded = inline.buildEmbeddedAsmText(source, regions);
assert.strictEqual(embedded.length, source.length, 'embedded text keeps the same length');
const srcLines = source.split('\n');
const embLines = embedded.split('\n');
assert.strictEqual(embLines.length, srcLines.length, 'embedded text keeps the same lines');
for (let i = 0; i < srcLines.length; i++) {
    assert.strictEqual(embLines[i].length, srcLines[i].length, `line ${i} keeps its length`);
}
const trimmed = embLines.map(l => l.trim());
assert.deepStrictEqual(trimmed, [
    '', '', '', '', '',
    'lda #',                                  // %b blanked
    'lda',                                    // %v blanked
    'lda # %10 ; comment  "quoted "',         // %% -> %, \" -> "
    'nop',
    'jsr _helper',
    '; split literal',
    'rts  ; tab',                             // \t blanked
    '',
    '',
    'nop',
    '',
]);
// Columns are preserved: `_helper` sits at the same column in both.
assert.strictEqual(embLines[9].indexOf('_helper'), srcLines[9].indexOf('_helper'));

// findRegionAt
const jsrOffset = source.indexOf('_helper');
assert.strictEqual(source.slice(...Object.values(inline.findRegionAt(regions, jsrOffset))), 'jsr _helper');
assert.strictEqual(inline.findRegionAt(regions, source.indexOf('counter;')), undefined, 'C code is not inline asm');
assert.strictEqual(inline.findRegionAt(regions, source.indexOf('not asm, string')), undefined, 'strings are not inline asm');

// Unterminated literal does not run past the line.
const broken = '__asm__("lda #1\nint x;\n';
const brokenRegions = inline.findInlineAsmRegions(broken);
assert.deepStrictEqual(brokenRegions.map(r => broken.slice(r.start, r.end)), ['lda #1']);

assert(inline.mayContainInlineAsm(source));
assert(!inline.mayContainInlineAsm('int main(void) { return 0; }'));
assert.strictEqual(inline.embeddedPathForHostPath('/ws/main.c'), '/ws/main.c.inline.s');
assert.strictEqual(inline.hostPathForEmbeddedPath('/ws/main.c.inline.s'), '/ws/main.c');
assert.strictEqual(inline.hostPathForEmbeddedPath('/ws/main.s'), undefined);

console.log('ALL INLINE ASM CHECKS PASSED!');
