// Checks the cc65 toolchain helpers and the clangd behaviours the cc65 C mode bridge relies on:
// - generated compile database + shim parse cc65 sources without errors
// - textDocument/symbolInfo USRs distinguish external globals from statics/locals
// - workspace/symbol finds external C symbols by exact name
// - references and rename work across files via the background index
const assert = require('assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { spawn } = require('child_process');
const { pathToFileURL } = require('url');
const which = require('which');

const toolchain = require(path.resolve(process.cwd(), 'client/out/cc65Toolchain.js'));

async function unitChecks() {
    assert.strictEqual(toolchain.parseCc65VersionMacro('cc65 V2.19 - Debian 2.19-1'), '0x0213');
    assert.strictEqual(toolchain.parseCc65VersionMacro('cc65 V2.18 - Git 1a2b3c'), '0x0212');
    assert.strictEqual(toolchain.parseCc65VersionMacro('garbage'), undefined);

    const flags = toolchain.buildCc65ClangFlags({
        includeDir: '/cc65/include',
        shimHeaderPath: '/tmp/shim.h',
        versionMacro: '0x0213',
        userIncludeDirs: ['/ws', '/ws/inc'],
        extraFlags: ['-D__C64__'],
    });
    assert(flags.includes('--target=msp430'));
    assert(flags.includes('-nostdinc'));
    assert.deepStrictEqual(flags.slice(flags.indexOf('-include'), flags.indexOf('-include') + 2), ['-include', '/tmp/shim.h']);
    assert.deepStrictEqual(flags.slice(flags.indexOf('-isystem'), flags.indexOf('-isystem') + 2), ['-isystem', '/cc65/include']);
    assert(flags.includes('-I/ws/inc') && flags.includes('-D__C64__') && flags.includes('-D__CC65__=0x0213'));

    const cmds = toolchain.buildCompileCommands(
        [{ file: '/ws/b.c', directory: '/ws' }, { file: '/ws/a.c', directory: '/ws' }],
        ['-xc']
    );
    assert.deepStrictEqual(cmds.map(c => c.file), ['/ws/a.c', '/ws/b.c']);
    assert.deepStrictEqual(cmds[0].arguments, ['clang', '-xc', '-c', '/ws/a.c']);

    assert.deepStrictEqual(toolchain.collectHeaderDirs(['/ws/inc/a.h', '/ws/inc/b.h', '/ws/x.h']), ['/ws', '/ws/inc']);

    const fakeHome = fs.mkdtempSync(path.join(os.tmpdir(), 'cc65-home-'));
    fs.mkdirSync(path.join(fakeHome, 'include'));
    fs.writeFileSync(path.join(fakeHome, 'include', 'stdio.h'), '');
    assert.strictEqual(
        await toolchain.resolveCc65IncludeDir({ env: { CC65_HOME: fakeHome } }),
        path.join(fakeHome, 'include')
    );
    fs.rmSync(fakeHome, { recursive: true, force: true });

    // Naming / USR helpers
    assert.strictEqual(toolchain.asmNameToCName('_draw'), 'draw');
    assert.strictEqual(toolchain.asmNameToCName('draw'), undefined);
    assert.strictEqual(toolchain.asmNameToCName('_'), undefined);
    assert(toolchain.isExternalCUsr('c:@F@draw', 'draw'));
    assert(toolchain.isExternalCUsr('c:@counter', 'counter'));
    assert(!toolchain.isExternalCUsr('c:main.c@F@draw', 'draw'));
    assert.deepStrictEqual(toolchain.parseFileScopeCUsr('c:@F@draw'), { name: 'draw', isStatic: false });
    assert.deepStrictEqual(toolchain.parseFileScopeCUsr('c:@counter'), { name: 'counter', isStatic: false });
    assert.deepStrictEqual(toolchain.parseFileScopeCUsr('c:main.c@F@helper'), { name: 'helper', isStatic: true });
    assert.deepStrictEqual(toolchain.parseFileScopeCUsr('c:main.c@hidden'), { name: 'hidden', isStatic: true });
    for (const notFileScope of ['c:main.c@58@F@f@loc', 'c:@T@byte_t', 'c:@S@point', 'c:@E@Color@Red', 'c:main.c@24@macro@FOO', undefined]) {
        assert.strictEqual(toolchain.parseFileScopeCUsr(notFileScope), undefined, `${notFileScope} is not file scope`);
    }

    // Targets
    assert.strictEqual(toolchain.DEFAULT_CC65_TARGET, 'c64', 'same default as cc65 without -t');
    assert.deepStrictEqual([...toolchain.getCc65TargetDefines('c64')], ['__CBM__', '__C64__']);
    assert.deepStrictEqual([...toolchain.getCc65TargetDefines('bogus')], []);
    const nesFlags = toolchain.buildCc65ClangFlags({ target: 'nes' });
    assert(nesFlags.includes('-D__NES__=1'), 'target macro should be defined for clangd');
    const pkg = require(path.resolve(process.cwd(), 'package.json'));
    const targetEnum = pkg.contributes.configuration.properties['ca65.cc65.target'].enum;
    assert.deepStrictEqual([...targetEnum].sort(), Object.keys(toolchain.CC65_TARGET_DEFINES).sort(), 'ca65.cc65.target enum should match the define table');

    // cc65 compile args
    assert.deepStrictEqual(
        toolchain.buildCc65CompileArgs({ target: 'nes', includeDirs: ['/ws/inc'], extraFlags: ['-DX=1', '-Iextra', '-Wall', '--target=x'], outFile: '/o.s', file: '/a.c' }),
        ['-t', 'nes', '-I', '/ws/inc', '-DX=1', '-Iextra', '-o', '/o.s', '/a.c']
    );
    // Tool output parsing
    assert.deepStrictEqual(toolchain.parseCc65ToolOutput([
        'main.c(2): Error: Undefined symbol: \'x\'',
        'inc/h.h(5): Warning: Unknown pragma \'bogus\'',
        'out.s(31): Error: Range error (300 not in [0..255])',
        'main.c(7): Note: Assembly code generated from this line',
        'cc65: Error: Unknown option: --nope',
        'some unrelated line',
    ].join('\n'), '/ws'), [
        { file: '/ws/main.c', line: 2, severity: 'error', message: "Undefined symbol: 'x'" },
        { file: '/ws/inc/h.h', line: 5, severity: 'warning', message: "Unknown pragma 'bogus'" },
        { file: '/ws/main.c', line: 7, severity: 'error', message: 'Range error (300 not in [0..255])' },
        { file: undefined, line: undefined, severity: 'error', message: 'Unknown option: --nope' },
    ]);
    assert.deepStrictEqual(toolchain.parseMakeDependencies('out.s:\tmain.c inc/a.h \\\n inc/b.h\n\nmain.c inc/a.h:\n', '/ws'), ['/ws/main.c', '/ws/inc/a.h', '/ws/inc/b.h']);
    // Calling convention: clangd hover parsing + cc65 layout (offsets verified against cc65 output).
    const drawHover = [
        '### function `draw`  ', '', '---', '→ `uint8_t (aka unsigned char)`  ', 'Parameters:  ',
        '- `uint8_t index (aka unsigned char)`', '- `uint16_t addr (aka unsigned int)`', '- `const char * name`',
        '- `point_t * p`', '- `long big`', '', '---', '```cpp',
        'extern uint8_t draw(uint8_t index, uint16_t addr, const char *name, point_t *p,', '                    long big)', '```',
    ].join('\n');
    const draw = toolchain.parseClangdFunctionHover(drawHover);
    assert.deepStrictEqual(draw.params.map(p => [p.name, p.type, p.canonical]), [
        ['index', 'uint8_t', 'unsigned char'], ['addr', 'uint16_t', 'unsigned int'], ['name', 'const char *', 'const char *'],
        ['p', 'point_t *', 'point_t *'], ['big', 'long', 'long'],
    ]);
    assert.strictEqual(draw.returnCanonical, 'unsigned char');
    assert.strictEqual(draw.variadic, false);
    assert.strictEqual(toolchain.parseClangdFunctionHover('### variable `x`'), undefined);
    const vf = toolchain.parseClangdFunctionHover('### function `vfunc`  \n\n---\n→ `int`  \nParameters:  \n- `uint8_t n (aka unsigned char)`\n\n---\n```cpp\nint vfunc(uint8_t n, ...)\n```');
    assert(vf.variadic && vf.params.length === 1);
    const noArgs = toolchain.parseClangdFunctionHover('### function `tick`  \n\n---\n→ `void`  \n\n---\n```cpp\nvoid tick(void)\n```');
    assert.deepStrictEqual(noArgs.params, []);

    assert.strictEqual(toolchain.detectCallingConvention('extern void __cdecl__ f(int a);'), 'cdecl');
    assert.strictEqual(toolchain.detectCallingConvention('void fastcall f(int a);', 'cdecl'), 'fastcall');
    assert.strictEqual(toolchain.detectCallingConvention('void f(int a);'), 'fastcall');
    for (const [t, n] of [['unsigned char', 1], ['signed char', 1], ['_Bool', 1], ['int', 2], ['unsigned int', 2], ['short', 2], ['enum color', 2], ['const char *', 2], ['void (*)(void)', 2], ['long', 4], ['unsigned long', 4], ['point_t', undefined]]) {
        assert.strictEqual(toolchain.cc65TypeSize(t), n, `size of ${t}`);
    }

    // fc(a, b, c) fastcall: cc65 reads b at (sp),0..1 and a at (sp),2, c in A, then pops 3 bytes.
    const fc = { name: 'fc', returnType: 'unsigned char', returnCanonical: 'unsigned char', variadic: false, convention: 'fastcall', params: [
        { name: 'a', type: 'unsigned char', canonical: 'unsigned char' },
        { name: 'b', type: 'unsigned int', canonical: 'unsigned int' },
        { name: 'c', type: 'unsigned char', canonical: 'unsigned char' },
    ] };
    const fcLayout = toolchain.describeCc65CallingConvention(fc);
    assert.deepStrictEqual(fcLayout.args.map(a => [a.name, a.location]), [
        ['a', '(sp),y=2'], ['b', '(sp),y=0..1 (low byte first)'], ['c', 'A'],
    ]);
    assert.strictEqual(fcLayout.stackBytes, 3);
    assert.strictEqual(fcLayout.returns, 'A, with X = 0');
    // Same function as __cdecl__: everything on the stack (c at 0, b at 1..2, a at 3), pop 4.
    const cdLayout = toolchain.describeCc65CallingConvention({ ...fc, convention: 'cdecl' });
    assert.deepStrictEqual(cdLayout.args.map(a => a.location), ['(sp),y=3', '(sp),y=1..2 (low byte first)', '(sp),y=0']);
    assert.strictEqual(cdLayout.stackBytes, 4);
    // Returns: signed char sign-extends into X; long uses sreg.
    assert.match(toolchain.describeCc65CallingConvention({ ...fc, returnCanonical: 'signed char' }).returns, /sign extension/);
    assert.match(toolchain.describeCc65CallingConvention({ ...fc, returnCanonical: 'long' }).returns, /sreg/);
    assert.strictEqual(toolchain.describeCc65CallingConvention({ ...fc, returnCanonical: 'void' }).returns, undefined);
    // 16-bit last argument in A/X; variadic puts everything on the stack.
    assert.strictEqual(toolchain.describeCc65CallingConvention({ ...fc, params: [fc.params[1]] }).args[0].location, 'A (lo), X (hi)');
    const vLayout = toolchain.describeCc65CallingConvention({ ...fc, params: [fc.params[0]], variadic: true });
    assert.strictEqual(vLayout.args[0].location, '(sp),y=0');
    assert(vLayout.notes.some(n => /Y holds/.test(n)));

    assert.strictEqual(toolchain.formatPrototypeMarkdown(fc), '```c\nunsigned char __fastcall__ fc(unsigned char a, unsigned int b, unsigned char c)\n```');
    assert.strictEqual(toolchain.formatPrototypeMarkdown({ ...fc, params: [], convention: 'cdecl' }), '```c\nunsigned char __cdecl__ fc(void)\n```');
    // clangd's declaration block is replaced by the cc65 prototype (with the calling convention).
    const clangdCard = '### function `fc`  \n\n---\nDoes things.  \n\n---\n```cpp\n// In game.h\nunsigned char fc(unsigned char a)\n```';
    assert.strictEqual(
        toolchain.replaceClangdDeclarationBlock(clangdCard, toolchain.formatPrototypeMarkdown(fc)),
        '### function `fc`  \n\n---\nDoes things.  \n\n---\n```c\nunsigned char __fastcall__ fc(unsigned char a, unsigned int b, unsigned char c)\n```'
    );
    assert.strictEqual(toolchain.replaceClangdDeclarationBlock('no code', '```c\nx\n```'), 'no code');

    // Declaration extracted from clangd hovers (format from clangd 19).
    const varHover = [
        '### variable `player_x`  ', '', '---', 'Type: `uint8_t (aka unsigned char)`  ',
        'Defined in assembly in the zero page (src/zp.s).  ', '', '---', '```cpp', '// In game.h', 'extern uint8_t player_x', '```',
    ].join('\n');
    assert.strictEqual(toolchain.extractClangdDeclarationBlock(varHover), '```c\nextern uint8_t player_x\n```');

    const stub = toolchain.buildAsmStub(fc);
    assert(stub.includes('.export _fc') && stub.includes('.proc _fc') && stub.includes('.import incsp3') && stub.includes('jmp incsp3'), stub);
    assert(toolchain.buildAsmStub({ ...fc, params: [] }).includes('    rts'), 'no stack args: plain rts');

    // File-scope variable definitions (for linking cc65's data labels to C lines)
    const defs = toolchain.findFileScopeVariableDefinitions([
        '#include <stdint.h>',                    // 0
        '#define X(a) \\',                       // 1
        '    int not_a_var;',                     // 2 (macro continuation)
        'extern uint8_t ext;',                    // 3
        'typedef uint8_t byte_t;',                // 4
        '/* uint8_t in_comment; */',              // 5
        'uint8_t frame_count;',                   // 6
        'static uint8_t hidden = 5;',             // 7
        'const uint8_t table[] = { 1, 2, 3 };',   // 8
        'int a, b = 2;',                          // 9
        'struct { uint8_t x; } point;',           // 10
        'void f(int arg) {',                      // 11
        '    uint8_t local = 1;',                 // 12
        '    const char *s = "x; y;";',           // 13
        '}',                                      // 14
        'uint8_t after_fn;',                      // 15
    ].join('\n'));
    assert.deepStrictEqual(Object.fromEntries(defs), {
        frame_count: 6, hidden: 7, table: 8, a: 9, b: 9, point: 10, after_fn: 15,
    });

    console.log('cc65Toolchain unit checks passed');
}

const fc = { name: 'fc', returnType: 'unsigned char', returnCanonical: 'unsigned char', variadic: false, convention: 'fastcall', params: [
    { name: 'a', type: 'unsigned char', canonical: 'unsigned char' },
    { name: 'b', type: 'unsigned int', canonical: 'unsigned int' },
    { name: 'c', type: 'unsigned char', canonical: 'unsigned char' },
] };

async function cc65Checks(cc65Path) {
    const tmpRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'ca65-cc65-'));
    try {
        const incDir = path.join(tmpRoot, 'include');
        fs.mkdirSync(incDir);
        fs.writeFileSync(path.join(incDir, 'game.h'), '#include <stdint.h>\nextern uint8_t frame_count;\n');
        assert.strictEqual(await toolchain.findCc65Compiler({}), cc65Path, 'cc65 should be found on PATH');
        assert.strictEqual(await toolchain.findCc65Compiler({ cc65Path: path.join(tmpRoot, 'missing-cc65') }), undefined);

        // The target reaches cc65: `-t nes` defines __NES__, `-t c64` does not.
        const targetFile = path.join(tmpRoot, 'target.c');
        fs.writeFileSync(targetFile, '#ifdef __NES__\nint nes_flag;\n#else\nint other_flag;\n#endif\n');
        const compileFor = (target) => {
            const { spawnSync } = require('child_process');
            spawnSync(cc65Path, toolchain.buildCc65CompileArgs({ target, outFile: 'target.s', file: 'target.c' }), { cwd: tmpRoot });
            return fs.readFileSync(path.join(tmpRoot, 'target.s'), 'utf8');
        };
        assert(/_nes_flag/.test(compileFor('nes')) && !/_other_flag/.test(compileFor('nes')), 'target nes defines __NES__');
        assert(/_other_flag/.test(compileFor('c64')), 'target c64 does not define __NES__');

        // Diagnostics: cc65 errors + ca65 errors in inline asm mapped back to C lines via `cc65 -g`.
        const diagFile = path.join(tmpRoot, 'diag.c');
        fs.writeFileSync(diagFile, [
            '#include "game.h"',                  // 1
            'void f(void) {',                     // 2
            '    int unused;',                    // 3
            '    __asm__("lda #300");',           // 4  ca65: range error
            '    __asm__("lda #%b junk", 1);',    // 5  ca65: trailing garbage
            '}',                                  // 6
        ].join('\n') + '\n');
        const { spawnSync } = require('child_process');
        const run = (cmd, args, cwd) => {
            const r = spawnSync(cmd, args, { cwd, encoding: 'utf8' });
            return `${r.stdout || ''}\n${r.stderr || ''}`;
        };
        const depFile = path.join(tmpRoot, 'diag.d');
        const asmOut = path.join(tmpRoot, 'diag.s');
        const cc65Out = run(cc65Path, ['-g', '--create-dep', depFile, ...toolchain.buildCc65CompileArgs({
            target: 'nes', includeDirs: [incDir], extraFlags: [], outFile: asmOut, file: diagFile,
        })], tmpRoot);
        const cc65Diags = toolchain.parseCc65ToolOutput(cc65Out, tmpRoot);
        assert(cc65Diags.some(d => d.severity === 'warning' && d.file === diagFile && /unused/.test(d.message)), `cc65 warning expected, got ${JSON.stringify(cc65Diags)}`);
        assert.deepStrictEqual(toolchain.parseMakeDependencies(fs.readFileSync(depFile, 'utf8'), tmpRoot), [diagFile, path.join(incDir, 'game.h')]);
        const ca65Path = which.sync('ca65', { nothrow: true });
        if (ca65Path) {
            const ca65Out = run(ca65Path, ['-t', 'nes', '-o', path.join(tmpRoot, 'diag.o'), asmOut], tmpRoot);
            const ca65Diags = toolchain.parseCc65ToolOutput(ca65Out, tmpRoot);
            assert.deepStrictEqual(
                ca65Diags.map(d => `${path.basename(d.file)}:${d.line}:${d.severity}`),
                ['diag.c:4:error', 'diag.c:5:error'],
                `ca65 errors should map to the C lines, got ${JSON.stringify(ca65Diags)}`
            );
            assert(/Range error/.test(ca65Diags[0].message));
        }

        // Header errors are reported against the header.
        fs.writeFileSync(path.join(incDir, 'bad.h'), 'int broken = ;\n');
        fs.writeFileSync(diagFile, '#include "bad.h"\nint ok;\n');
        const headerDiags = toolchain.parseCc65ToolOutput(run(cc65Path, toolchain.buildCc65CompileArgs({
            target: 'nes', includeDirs: [incDir], extraFlags: [], outFile: asmOut, file: diagFile,
        }), tmpRoot), tmpRoot);
        assert(headerDiags.some(d => d.file === path.join(incDir, 'bad.h') && d.line === 1 && d.severity === 'error'), `header error expected, got ${JSON.stringify(headerDiags)}`);

        // Generated assembly view: `cc65 -g --add-source` output mapped back to C lines.
        const viewFile = path.join(tmpRoot, 'view.c');
        fs.writeFileSync(viewFile, [
            'unsigned char frame_count;',          // 0
            'void update(void) {',                 // 1
            '    ++frame_count;',                  // 2
            '    __asm__("nop");',                 // 3
            '    for (;;) { ++frame_count; }',     // 4
            '}',                                   // 5
        ].join('\n') + '\n');
        const viewAsmFile = path.join(tmpRoot, 'view.s');
        run(cc65Path, ['-g', '--add-source', ...toolchain.buildCc65CompileArgs({
            target: 'nes', includeDirs: [], extraFlags: [], outFile: 'view.s', file: 'view.c',
        })], tmpRoot);
        const view = toolchain.buildCc65AssemblyView(fs.readFileSync(viewAsmFile, 'utf8'), 'view.c');
        const viewLines = view.text.split('\n');
        assert(!viewLines.some(l => /^\s*\.dbg\b/.test(l)), 'view text has no .dbg lines');
        assert.strictEqual(view.asmToC.length, viewLines.length - 1, 'asmToC covers every view line');
        const linesFor = (cLine) => (view.cToAsm.get(cLine) || []).flatMap(([s, e]) => viewLines.slice(s, e + 1));
        assert(linesFor(2).some(l => /^\s*inc\s+_frame_count/.test(l)), `C line 3 maps to its inc, got ${JSON.stringify(linesFor(2))}`);
        assert(linesFor(2).some(l => l.includes('; ++frame_count;')), 'the --add-source comment belongs to its C line');
        assert(linesFor(3).some(l => /^\s*nop\b/.test(l)), 'inline asm maps to its C line');
        assert(linesFor(3).some(l => l.includes('; __asm__("nop");')), 'each C line owns its own --add-source comment');
        assert(!linesFor(2).some(l => l.includes('__asm__')), `a C line must not include the next line's comment, got ${JSON.stringify(linesFor(2))}`);
        // File-scope variables have no .dbg line: link cc65's data labels to their C definitions.
        toolchain.linkDataDefinitions(view, fs.readFileSync(viewFile, 'utf8'));
        assert(linesFor(0).some(l => /^_frame_count:/.test(l)) && linesFor(0).some(l => /\.res/.test(l)), `frame_count's data label links to its C line, got ${JSON.stringify(linesFor(0))}`);
        const labelLine = viewLines.findIndex(l => /^_frame_count:/.test(l));
        assert.strictEqual(view.asmToC[labelLine], 0, 'data label maps back to its C line');
        const incLine = viewLines.findIndex(l => /^\s*inc\s+_frame_count/.test(l));
        assert.strictEqual(view.asmToC[incLine], 2, 'asm line maps back to the C line');
        const originalAsm = fs.readFileSync(viewAsmFile, 'utf8').split('\n');
        assert.strictEqual(view.sourceLineIndex.length, viewLines.length - 1);
        assert.strictEqual(originalAsm[view.sourceLineIndex[incLine]], viewLines[incLine], 'sourceLineIndex points at the same line in cc65 output');
        const procLine = viewLines.findIndex(l => /^\.proc\s+_update/.test(l));
        assert.strictEqual(view.asmToC[procLine], undefined, '.proc line is not attributed to a C line');
        assert(!linesFor(2).some(l => /^;\s*-{4,}/.test(l)), 'function separators are not part of a C line');

        // #include lines link to everything the header generated (whole function from banner to .endproc).
        fs.writeFileSync(path.join(tmpRoot, 'util.h'), 'extern unsigned char counter;\nstatic void bump(void) {\n    ++counter;\n}\n');
        fs.writeFileSync(path.join(tmpRoot, 'inc.c'), '#include "util.h"\nunsigned char counter;\nvoid f(void) {\n    bump();\n}\n');
        run(cc65Path, ['-g', '--add-source', ...toolchain.buildCc65CompileArgs({ target: 'nes', includeDirs: [tmpRoot], outFile: 'inc.s', file: 'inc.c' })], tmpRoot);
        const incView = toolchain.buildCc65AssemblyView(fs.readFileSync(path.join(tmpRoot, 'inc.s'), 'utf8'), 'inc.c');
        toolchain.linkIncludes(incView, fs.readFileSync(path.join(tmpRoot, 'inc.c'), 'utf8'));
        const incLines = incView.text.split('\n');
        const includeLines = (incView.cToAsm.get(0) || []).flatMap(([a, b]) => incLines.slice(a, b + 1));
        assert(includeLines.some(l => /^\.proc\s+_bump/.test(l)), `#include covers the header's function, got ${JSON.stringify(includeLines)}`);
        assert(includeLines.some(l => /^\s*inc\s+_counter/.test(l)) && includeLines.some(l => /^\.endproc/.test(l)));
        assert(includeLines.some(l => /void __near__ bump/.test(l)), 'the function banner is part of the range');
        assert(!includeLines.some(l => /_f\b/.test(l)), 'code from the C file itself is not part of the #include range');
        const incAsmLine = incLines.findIndex(l => /^\s*inc\s+_counter/.test(l));
        assert.strictEqual(incView.asmToC[incAsmLine], 0, 'header code maps back to the #include line');
        const callLine = incLines.findIndex(l => /^\s*jsr\s+_bump/.test(l));
        assert.strictEqual(incView.asmToC[callLine], 3, 'the call stays linked to its own C line');

        // The demo project: `#include "game.h"` (declarations only) links to the imports it declares.
        const demoDir = path.resolve(process.cwd(), 'examples/cc65-c-mode');
        const demoAsm = path.join(tmpRoot, 'demo.s');
        const demoDep = path.join(tmpRoot, 'demo.d');
        run(cc65Path, ['-g', '--add-source', '--create-full-dep', demoDep, ...toolchain.buildCc65CompileArgs({
            target: 'nes', includeDirs: [path.join(demoDir, 'include')], outFile: demoAsm, file: 'src/main.c',
        })], demoDir);
        const demoView = toolchain.buildCc65AssemblyView(fs.readFileSync(demoAsm, 'utf8'), 'main.c');
        const demoHeaders = toolchain.parseMakeDependencies(fs.readFileSync(demoDep, 'utf8'), demoDir)
            .filter(p => !p.endsWith('main.c'))
            .map(p => ({ path: p, text: fs.readFileSync(p, 'utf8') }));
        const demoSource = fs.readFileSync(path.join(demoDir, 'src/main.c'), 'utf8');
        toolchain.linkIncludes(demoView, demoSource, demoHeaders);
        const demoLines = demoView.text.split('\n');
        const includeLine = demoSource.split('\n').findIndex(l => l.includes('#include "game.h"'));
        const linked = (demoView.cToAsm.get(includeLine) || []).flatMap(([a, b]) => demoLines.slice(a, b + 1)).map(l => l.trim());
        for (const expected of ['.import\t\t_draw_sprite', '.import\t\t_clamp', '.importzp\t_player_x']) {
            assert(linked.some(l => l.replace(/\s+/g, ' ') === expected.replace(/\s+/g, ' ')), `#include "game.h" should link ${expected}, got ${JSON.stringify(linked)}`);
        }
        assert(!linked.some(l => /\bsp\b|\bptr1\b/.test(l)), 'runtime zero-page imports are not attributed to game.h');
        const importLine = demoLines.findIndex(l => /\.import\s+_draw_sprite/.test(l));
        assert.strictEqual(demoView.asmToC[importLine], includeLine, 'the import maps back to the #include line');

        assert.deepStrictEqual(
            toolchain.sanitizeCc65AdditionalArgs(['-Oirs', '-o', 'x.s', '--create-dep', 'a.d', '-oy.s', '--dep-target=foo', '--code-name', 'BANK1', 42, '']),
            ['-Oirs', '--code-name', 'BANK1']
        );
        assert.deepStrictEqual(
            toolchain.buildCc65CompileArgs({ target: 'nes', additionalArgs: ['-Oirs'], outFile: 'o.s', file: 'a.c' }),
            ['-t', 'nes', '-Oirs', '-o', 'o.s', 'a.c']
        );
        assert.deepStrictEqual(toolchain.buildCc65CompileArgs({ target: 'cx16', cpu: 'W65C02', outFile: 'o.s', file: 'a.c' }),
            ['-t', 'cx16', '--cpu', '65C02', '-o', 'o.s', 'a.c'], 'cc65 knows W65C02 as 65C02');
        assert.deepStrictEqual(toolchain.buildCc65CompileArgs({ target: 'nes', cpu: '65816', outFile: 'o.s', file: 'a.c' }).slice(0, 4), ['-t', 'nes', '--cpu', '65816']);

        // The documented calling convention, executed: asm written from describeCc65CallingConvention's
        // offsets, called from cc65-compiled C, run under sim65.
        const sim65 = which.sync('sim65', { nothrow: true });
        const cl65 = which.sync('cl65', { nothrow: true });
        if (sim65 && cl65) {
            const abiDir = path.join(tmpRoot, 'abi');
            fs.mkdirSync(abiDir);
            fs.writeFileSync(path.join(abiDir, 'run.c'), [
                'unsigned char __fastcall__ fc(unsigned char a, unsigned int b, unsigned char c);',
                'unsigned char __cdecl__ cd(unsigned char a, unsigned int b, unsigned char c);',
                'signed char __fastcall__ neg(signed char v);',
                'int main(void) {',
                '    if (fc(1, 0x0210, 3) != 0x14) return 1;',
                '    if (cd(1, 0x0210, 3) != 0x14) return 2;',
                '    if (neg(5) + 0 != -5) return 3;',
                '    return 0;',
                '}',
            ].join('\n') + '\n');
            const fcl = toolchain.describeCc65CallingConvention(fc);
            const cdl = toolchain.describeCc65CallingConvention({ ...fc, convention: 'cdecl' });
            const off = (loc) => Number(/\(sp\),y=(\d+)/.exec(loc)[1]);
            fs.writeFileSync(path.join(abiDir, 'impl.s'), [
                '.importzp sp, tmp1',
                `.import incsp${fcl.stackBytes}, incsp${cdl.stackBytes}`,
                '.export _fc, _cd, _neg',
                '.proc _fc',                                   // c in A
                '    sta tmp1',
                `    ldy #${off(fcl.args[1].location)}`, '    lda (sp),y', '    clc', '    adc tmp1',
                `    ldy #${off(fcl.args[0].location)}`, '    adc (sp),y',
                '    ldx #0', `    jmp incsp${fcl.stackBytes}`,
                '.endproc',
                '.proc _cd',
                `    ldy #${off(cdl.args[2].location)}`, '    lda (sp),y', '    clc',
                `    ldy #${off(cdl.args[1].location)}`, '    adc (sp),y',
                `    ldy #${off(cdl.args[0].location)}`, '    adc (sp),y',
                '    ldx #0', `    jmp incsp${cdl.stackBytes}`,
                '.endproc',
                '.proc _neg',
                '    eor #$FF', '    clc', '    adc #1', '    ldx #0', '    cmp #$80', '    bcc :+', '    dex', ':   rts',
                '.endproc',
            ].join('\n') + '\n');
            const build = spawnSync(cl65, ['-t', 'sim6502', '-O', '-o', 'run.prg', 'run.c', 'impl.s'], { cwd: abiDir, encoding: 'utf8' });
            assert.strictEqual(build.status, 0, `cl65 failed: ${build.stdout}${build.stderr}`);
            const sim = spawnSync(sim65, ['run.prg'], { cwd: abiDir, encoding: 'utf8' });
            assert.strictEqual(sim.status, 0, `asm written from the documented convention returned wrong results (exit ${sim.status})`);
        } else {
            console.log('SKIP sim65 calling convention run (sim65/cl65 not found)');
        }

        console.log('cc65 checks passed');
    } finally {
        fs.rmSync(tmpRoot, { recursive: true, force: true });
    }
}

async function clangdChecks(clangdPath) {
    const tmpRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'ca65-clangd-'));
    const dbDir = path.join(tmpRoot, '.storage');
    const mainPath = path.join(tmpRoot, 'main.c');
    const utilPath = path.join(tmpRoot, 'util.c');
    const headerPath = path.join(tmpRoot, 'game.h');

    const headerText = [
        '#include <stdint.h>',
        'extern void __fastcall__ draw(uint8_t x);',
        'extern uint8_t counter;',
        '#pragma zpsym ("counter")',
    ].join('\n') + '\n';
    const mainText = [
        '#include <conio.h>',
        '#include "game.h"',
        'static void helper(void) { }',
        'void main(void) {',
        '    uint8_t local = 0;',
        '    draw(local);',
        '    helper();',
        '    __asm__("lda %v", counter);',
        '    __AX__ = 1;',
        '    cprintf("%d", counter);',
        '}',
    ].join('\n') + '\n';
    const utilText = [
        '#include "game.h"',
        'uint8_t counter;',
        'void bump(void) { ++counter; draw(counter); }',
    ].join('\n') + '\n';
    fs.writeFileSync(headerPath, headerText);
    fs.writeFileSync(mainPath, mainText);
    fs.writeFileSync(utilPath, utilText);

    const shimPath = path.join(dbDir, 'cc65_shim.h');
    await toolchain.writeFileIfChanged(shimPath, toolchain.CC65_SHIM_HEADER);
    const includeDir = await toolchain.resolveCc65IncludeDir({ executable: await toolchain.findCc65Executable() });
    assert(includeDir, 'cc65 include dir should be found when cc65 is installed');
    const flags = toolchain.buildCc65ClangFlags({ includeDir, shimHeaderPath: shimPath, userIncludeDirs: [tmpRoot] });
    const entries = toolchain.buildCompileCommands(
        [mainPath, utilPath].map(file => ({ file, directory: tmpRoot })),
        flags
    );
    await toolchain.writeFileIfChanged(path.join(dbDir, 'compile_commands.json'), JSON.stringify(entries));

    const proc = spawn(clangdPath, ['--background-index', `--compile-commands-dir=${dbDir}`, '--log=error'], {
        cwd: tmpRoot,
        stdio: ['pipe', 'pipe', 'pipe'],
        env: { ...process.env, XDG_CACHE_HOME: path.join(tmpRoot, '.cache') },
    });
    let buffer = Buffer.alloc(0);
    let nextId = 1;
    const pending = new Map();
    const diagnostics = new Map();
    proc.stdout.on('data', (chunk) => {
        buffer = Buffer.concat([buffer, chunk]);
        while (true) {
            const headerEnd = buffer.indexOf('\r\n\r\n');
            if (headerEnd === -1) break;
            const m = buffer.slice(0, headerEnd).toString('utf8').match(/Content-Length:\s*(\d+)/i);
            const totalLen = headerEnd + 4 + parseInt(m[1], 10);
            if (buffer.length < totalLen) break;
            const msg = JSON.parse(buffer.slice(headerEnd + 4, totalLen).toString('utf8'));
            buffer = buffer.slice(totalLen);
            if (msg.id !== undefined && msg.method !== undefined) {
                send({ jsonrpc: '2.0', id: msg.id, result: null });
            } else if (msg.id !== undefined) {
                const entry = pending.get(msg.id);
                if (entry) {
                    pending.delete(msg.id);
                    if (msg.error) entry.reject(new Error(JSON.stringify(msg.error)));
                    else entry.resolve(msg.result);
                }
            } else if (msg.method === 'textDocument/publishDiagnostics') {
                diagnostics.set(msg.params.uri, msg.params.diagnostics);
            }
        }
    });
    function send(obj) {
        const json = JSON.stringify(obj);
        proc.stdin.write(`Content-Length: ${Buffer.byteLength(json, 'utf8')}\r\n\r\n${json}`, 'utf8');
    }
    function request(method, params) {
        const id = nextId++;
        return new Promise((resolve, reject) => {
            pending.set(id, { resolve, reject });
            send({ jsonrpc: '2.0', id, method, params });
        });
    }
    const notify = (method, params) => send({ jsonrpc: '2.0', method, params });
    const sleep = (ms) => new Promise(r => setTimeout(r, ms));

    try {
        const rootUri = pathToFileURL(tmpRoot).toString();
        const mainUri = pathToFileURL(mainPath).toString();
        const utilUri = pathToFileURL(utilPath).toString();
        await request('initialize', { processId: process.pid, rootUri, capabilities: {}, initializationOptions: { fallbackFlags: flags } });
        notify('initialized', {});
        notify('textDocument/didOpen', { textDocument: { uri: mainUri, languageId: 'c', version: 1, text: mainText } });

        for (let i = 0; i < 100 && !diagnostics.has(mainUri); i++) await sleep(100);
        const errors = (diagnostics.get(mainUri) || []).filter(d => d.severity === 1);
        assert.deepStrictEqual(errors, [], `cc65 source should parse without errors, got ${JSON.stringify(errors, null, 2)}`);

        const lines = mainText.split('\n');
        const at = (line, word) => ({ line, character: lines[line].indexOf(word) + 1 });
        const usr = async (line, word) => {
            const info = await request('textDocument/symbolInfo', { textDocument: { uri: mainUri }, position: at(line, word) });
            return info && info[0] && info[0].usr;
        };
        assert.strictEqual(await usr(5, 'draw'), 'c:@F@draw', 'extern function USR');
        assert.strictEqual(await usr(9, 'counter'), 'c:@counter', 'extern variable USR');
        assert.notStrictEqual(await usr(6, 'helper'), 'c:@F@helper', 'static function must not look external');
        assert(!/^c:@local$/.test(await usr(5, 'local') || ''), 'local variable must not look external');

        // Wait for the background index to cover util.c.
        let symbols = [];
        for (let i = 0; i < 100; i++) {
            symbols = (await request('workspace/symbol', { query: 'counter' })) || [];
            if (symbols.some(s => s.name === 'counter' && s.location.uri === utilUri)) break;
            await sleep(200);
        }
        const counterSym = symbols.find(s => s.name === 'counter' && !s.containerName);
        assert(counterSym, `workspace/symbol should find counter, got ${JSON.stringify(symbols)}`);
        assert.strictEqual(counterSym.location.uri, utilUri, 'workspace/symbol should prefer the definition');

        // findCDefinitionFile relies on clangd's index resolving an extern to its defining .c file.
        const defs = await request('textDocument/definition', { textDocument: { uri: mainUri }, position: at(9, 'counter') });
        const defUris = (Array.isArray(defs) ? defs : [defs]).map(d => d.uri || d.targetUri);
        assert(defUris.includes(utilUri), `definition of counter should be util.c, got ${JSON.stringify(defUris)}`);

        const refs = await request('textDocument/references', {
            textDocument: { uri: mainUri }, position: at(5, 'draw'), context: { includeDeclaration: true },
        });
        const refFiles = new Set(refs.map(r => path.basename(new URL(r.uri).pathname)));
        assert(refFiles.has('main.c') && refFiles.has('util.c') && refFiles.has('game.h'), `draw refs should span files, got ${[...refFiles]}`);

        // The shim keeps inline asm arguments visible: `__asm__("lda %v", counter)` references counter.
        const counterRefs = await request('textDocument/references', {
            textDocument: { uri: mainUri }, position: at(9, 'counter'), context: { includeDeclaration: true },
        });
        assert(counterRefs.some(r => r.uri === mainUri && r.range.start.line === 7), `%v argument should be a reference, got ${JSON.stringify(counterRefs.map(r => r.range.start.line))}`);

        const rename = await request('textDocument/rename', { textDocument: { uri: mainUri }, position: at(5, 'draw'), newName: 'render' });
        const changes = rename.changes || Object.fromEntries((rename.documentChanges || []).map(d => [d.textDocument.uri, d.edits]));
        const renamedFiles = new Set(Object.keys(changes).map(u => path.basename(new URL(u).pathname)));
        assert(renamedFiles.has('util.c') && renamedFiles.has('game.h'), `rename should span files, got ${[...renamedFiles]}`);
        console.log('clangd bridge assumptions verified');
    } finally {
        try { await request('shutdown', null); notify('exit', null); } catch {}
        proc.kill();
        fs.rmSync(tmpRoot, { recursive: true, force: true });
    }
}

(async () => {
    await unitChecks();
    const cc65Path = which.sync('cc65', { nothrow: true });
    if (cc65Path) {
        await cc65Checks(cc65Path);
    } else {
        console.log('SKIP cc65 checks (cc65 not found in PATH)');
    }
    const clangdPath = which.sync('clangd', { nothrow: true });
    const hasCc65 = Boolean(which.sync('cc65', { nothrow: true }) || which.sync('ca65', { nothrow: true }));
    if (!clangdPath || !hasCc65) {
        console.log('SKIP clangd checks (clangd or cc65 not found in PATH)');
    } else {
        await clangdChecks(clangdPath);
    }
    console.log('ALL CLANGD TOOLCHAIN CHECKS PASSED!');
})().catch((err) => {
    console.error(err);
    process.exit(1);
});
