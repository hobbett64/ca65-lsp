const assert = require('assert');
const fs = require('fs');
const Module = require('module');
const os = require('os');
const path = require('path');
const { spawn } = require('child_process');
const { pathToFileURL } = require('url');

const serverEntry = path.resolve(process.cwd(), 'server/out/server.js');
const { TextDocument } = require('vscode-languageserver-textdocument');

function loadEditUtils() {
    const origLoad = Module._load;
    Module._load = function (request) {
        if (request === './server') {
            return {
                performanceMonitor: { time: (_k, fn) => fn() },
                getDocumentSettings: async () => ({ includeDirs: ['**/include'] }),
                connection: { console: { log() {} } },
            };
        }
        return origLoad.apply(this, arguments);
    };
    try {
        return require(path.resolve(process.cwd(), 'server/out/editUtils.js'));
    } finally {
        Module._load = origLoad;
    }
}

function loadHoverHelpers() {
    const origLoad = Module._load;
    Module._load = function (request) {
        if (request === './server') {
            return {
                includesGraph: { getIncludingRootsArray: () => [] },
                symbolTables: new Map(),
                initializationGate: { isInitialized: Promise.resolve() },
                ensureDocumentRefreshed: async () => {},
                getDocumentSettings: async () => ({ cpu: '6502', includeDirs: ['**/include'], implicitImports: false }),
                performanceMonitor: { timeAsync: (_k, fn) => fn() },
            };
        }
        return origLoad.apply(this, arguments);
    };
    try {
        return require(path.resolve(process.cwd(), 'server/out/hoverProvider.js'));
    } finally {
        Module._load = origLoad;
    }
}

function makeLspClient() {
    const proc = spawn(process.execPath, [serverEntry, '--stdio'], {
        cwd: process.cwd(),
        stdio: ['pipe', 'pipe', 'pipe'],
    });
    let buffer = Buffer.alloc(0);
    let nextId = 1;
    const pending = new Map();

    proc.stdout.on('data', (chunk) => {
        buffer = Buffer.concat([buffer, chunk]);
        while (true) {
            const headerEnd = buffer.indexOf('\r\n\r\n');
            if (headerEnd === -1) break;
            const headerStr = buffer.slice(0, headerEnd).toString('utf8');
            const m = headerStr.match(/Content-Length:\s*(\d+)/i);
            if (!m) throw new Error('Malformed LSP header: ' + headerStr);
            const len = parseInt(m[1], 10);
            const totalLen = headerEnd + 4 + len;
            if (buffer.length < totalLen) break;
            const bodyStr = buffer.slice(headerEnd + 4, totalLen).toString('utf8');
            buffer = buffer.slice(totalLen);
            const msg = JSON.parse(bodyStr);

            if (msg.id !== undefined && msg.method !== undefined) {
                if (msg.method === 'workspace/configuration') {
                    const items = (msg.params && msg.params.items) || [];
                    sendMessage({
                        jsonrpc: '2.0',
                        id: msg.id,
                        result: items.map(i => i.section === 'ca65' ? {
                            enableStderrDiagnostics: false,
                            enableUnusedSymbolDiagnostics: false,
                            autoIncludeExtensions: ['.inc', '.s'],
                            anonymousLabelIndexHints: true,
                            importFromHints: true,
                            fileExtensions: ['.s', '.asm', '.inc'],
                            smartFolding: true,
                            enableStatusBarCycleCount: true,
                        } : { associations: {} }),
                    });
                } else {
                    sendMessage({ jsonrpc: '2.0', id: msg.id, result: null });
                }
            } else if (msg.id !== undefined) {
                const entry = pending.get(msg.id);
                if (entry) {
                    pending.delete(msg.id);
                    if (msg.error) entry.reject(new Error(JSON.stringify(msg.error)));
                    else entry.resolve(msg.result);
                }
            }
        }
    });

    function sendMessage(obj) {
        const json = JSON.stringify(obj);
        proc.stdin.write(`Content-Length: ${Buffer.byteLength(json, 'utf8')}\r\n\r\n${json}`, 'utf8');
    }
    function request(method, params) {
        const id = nextId++;
        return new Promise((resolve, reject) => {
            pending.set(id, { resolve, reject });
            sendMessage({ jsonrpc: '2.0', id, method, params });
        });
    }
    function notify(method, params) {
        sendMessage({ jsonrpc: '2.0', method, params });
    }
    async function close() {
        try { await request('shutdown', null); notify('exit', null); } catch {}
        proc.kill();
    }
    return { request, notify, close };
}

(async () => {
    // ------------------------------------------------------------------
    // 1. Unit test: editUtils.makeIncludeEdit skips multi-line /* ... */ headers
    // ------------------------------------------------------------------
    const { makeIncludeEdit } = loadEditUtils();
    const headerDoc = TextDocument.create(
        'file:///hdr_test.s',
        'ca65',
        1,
        [
            '/*',
            ' * Leading file banner',
            '',
            ' * across blank lines',
            ' */',
            '; Subheader line comment',
            '',
            'lda #$00',
        ].join('\n')
    );
    const incEdit = makeIncludeEdit(headerDoc, 'defs.inc');
    assert.strictEqual(incEdit.range.start.line, 7, `Expected .include after leading /* ... */ + ; header, got line ${incEdit.range.start.line}`);
    assert.strictEqual(incEdit.newText, '.include "defs.inc"\n\n');

    // ------------------------------------------------------------------
    // 2. Full LSP E2E tests for C-style block comments & line continuations
    // ------------------------------------------------------------------
    const tmpRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'ca65-ccomments-'));
    const defsPath = path.join(tmpRoot, 'defs.inc');
    const mainPath = path.join(tmpRoot, 'main.s');

    const defsText = [
        '/*',
        '  External base constant',
        '*/',
        '.export imp_alpha, \\',
        '  imp_beta',
        'imp_alpha: .res 1',
        'imp_beta: .res 1',
    ].join('\n') + '\n';

    const fillerLines = [];
    for (let i = 0; i < 215; i++) {
        fillerLines.push(` * filler comment line ${i}`);
    }

    const mainText = [
        '/*',
        ' * Huge leading block comment (>200 lines) with fake symbols:',
        ' * FakeHeaderLabel:',
        ' * .proc FakeHeaderProc',
        ' * .export FakeHeaderExport',
        ' * @retry:',
        ' * :',
        ' * CONST_A',
        ' * lda #$FF',
        ...fillerLines,
        ' */',
        '.import imp_alpha, \\',
        '  imp_beta',
        '.export exported_one, \\',
        '  exported_two',
        'CONST_A = 10',
        'CONST_ML = $10 + \\',
        '  $02',
        '.define DEF_CONST ($20 + \\',
        '  $04)',
        '.enum MultiEnum',
        '  ME_ZERO = $01 + \\',
        '    $03',
        '.endenum',
        '.struct Box',
        '  width .byte 1 + \\',
        '    1',
        '  height /* mid field */ .word',
        '.endstruct',
        '/**',
        '  Macro block doc for SUM3',
        '*/',
        '.macro SUM3 first, \\',
        '  second, \\',
        '  third',
        '  lda #first + second + third',
        '.endmacro',
        '/**',
        '  Define block doc for ADD2',
        '*/',
        '.define ADD2(a, \\',
        '  b) ((a) + (b))',
        '/**',
        '  Proc block doc for MainProc',
        '*/',
        '.proc MainProc',
        ': ; real anon 1',
        '@retry: ; real cheap local',
        '  /*',
        '    FakeBodyLabel:',
        '    @retry:',
        '    :',
        '    CONST_A',
        '    lda #$99',
        '    nop',
        '  */',
        '  /* inline pre */ lda /* mid */ #$10 ; tail',
        '  /* "quote" ; semi */ lda CONST_A',
        '  lda #$01 ; /* semicolon blocks c_comment',
        '  CONST_AFTER_SEMI = $77',
        '  lda /* #$99 */ #$20',
        '  lda tbl + \\',
        '    1, x',
        '  lda /* across',
        '    newline */ #$20',
        '  lda CONST_ML',
        '  lda DEF_CONST',
        '  SUM3 1, \\',
        '    2, \\',
        '    3',
        '  SUM3 10, /*',
        '    */ 20',
        '  lda #ADD2(1, \\',
        '    2)',
        '  bne /* jmp */ @retry',
        '  beq /* anon */ :-',
        '@trailing_note_src: lda #$01 /* unrelated trailing comment */',
        'UndocAfterTrailing:',
        '  nop',
        '  lda /* mid_complete */ ',
        '.endproc',
        '/** doc with export between */',
        '.export exported_one',
        'exported_one:',
        '  rts',
        'exported_two:',
        '  rts',
        '  /**',
        '   * Indented JSDoc',
        '   */',
        '  IndentedDocLbl:',
        '    nop',
        '  /*',
        '   * Plain block',
        '   */',
        '  PlainBlockLbl:',
        '    nop',
        '/**',
        ' * Draws a sprite cleanly.',
        ' *',
        ' * **Important:** call inside NMI.',
        ' * - outer',
        ' *   - nested',
        ' *',
        ' * ```ca65',
        ' * @loop:',
        ' *   dex',
        ' * ```',
        ' *',
        ' * @param A tile index',
        ' * @param dst - destination',
        ' * @return Carry set on error',
        ' * @clobber X, Y',
        ' * @preserve tmp0',
        ' * @loop prose label stays untouched',
        ' */',
        '.proc DrawSprite',
        '  rts',
        '.endproc',
        '/**',
        ' * Emits immediate byte.',
        ' * @param val byte to load',
        ' */',
        '.macro JSDOC_MAC val',
        '  lda #val',
        '.endmacro',
        '  JSDOC_MAC $01',
        'tbl: .byte $01, \\',
        '  $02, \\',
        '  $03',
        '.export exported_one, \\',
        '  ',
    ].join('\n');

    fs.writeFileSync(defsPath, defsText);
    fs.writeFileSync(mainPath, mainText);

    const wsUri = pathToFileURL(tmpRoot).toString();
    const defsUri = pathToFileURL(defsPath).toString();
    const mainUri = pathToFileURL(mainPath).toString();
    const lines = mainText.split('\n');

    const findLine = (needle, from = 0) => {
        const idx = lines.findIndex((l, i) => i >= from && l.includes(needle));
        assert(idx !== -1, `Could not find line containing: ${needle}`);
        return idx;
    };

    const client = makeLspClient();
    try {
        await client.request('initialize', {
            processId: process.pid,
            rootUri: wsUri,
            workspaceFolders: [{ uri: wsUri, name: 'ws' }],
            capabilities: {},
        });
        client.notify('initialized', {});
        client.notify('textDocument/didOpen', { textDocument: { uri: defsUri, languageId: 'ca65', version: 1, text: defsText } });
        client.notify('textDocument/didOpen', { textDocument: { uri: mainUri, languageId: 'ca65', version: 1, text: mainText } });
        await new Promise(r => setTimeout(r, 350));

        // --------------------------------------------------------------
        // A. Document Symbols & Scoping (comments excluded, ; /* handled)
        // --------------------------------------------------------------
        const syms = await client.request('textDocument/documentSymbol', { textDocument: { uri: mainUri } });
        const flatNames = [];
        function collectSymNames(list) {
            for (const s of list) {
                flatNames.push(s.name);
                if (s.children) collectSymNames(s.children);
            }
        }
        collectSymNames(syms);
        for (const expected of ['CONST_A', 'CONST_ML', 'MultiEnum', 'ME_ZERO', 'Box', 'width', 'height', 'MainProc', 'CONST_AFTER_SEMI', 'exported_one', 'exported_two', 'tbl']) {
            assert(flatNames.includes(expected), `Expected symbol ${expected} in ${JSON.stringify(flatNames)}`);
        }
        for (const bogus of ['FakeHeaderLabel', 'FakeHeaderProc', 'FakeHeaderExport', 'FakeBodyLabel']) {
            assert(!flatNames.includes(bogus), `Commented symbol ${bogus} should not be defined`);
        }

        // --------------------------------------------------------------
        // B. References & Multi-line Go-To-Definition & Anon Hints
        // --------------------------------------------------------------
        const constADefLine = findLine('CONST_A = 10');
        const constARefs = await client.request('textDocument/references', {
            textDocument: { uri: mainUri },
            position: { line: constADefLine, character: 1 },
            context: { includeDeclaration: true },
        });
        const realQuoteSemiLine = findLine('/* "quote" ; semi */ lda CONST_A');
        const constRefLines = new Set(constARefs.map(r => r.range.start.line));
        assert(constRefLines.has(constADefLine), 'CONST_A declaration expected in refs');
        assert(constRefLines.has(realQuoteSemiLine), 'CONST_A ref after inline comment with quotes/semicolon expected');
        assert.strictEqual(constARefs.length, 2, `Expected exactly 2 refs for CONST_A (ignoring comment matches), got ${JSON.stringify(constARefs.map(r => r.range.start.line))}`);

        const retryDefLine = findLine('@retry: ; real cheap local');
        const retryUseLine = findLine('bne /* jmp */ @retry');
        const retryRefs = await client.request('textDocument/references', {
            textDocument: { uri: mainUri },
            position: { line: retryDefLine, character: 2 },
            context: { includeDeclaration: true },
        });
        const retryLines = new Set(retryRefs.map(r => r.range.start.line));
        assert(retryLines.has(retryDefLine) && retryLines.has(retryUseLine), 'Expected real @retry def + ref');
        assert.strictEqual(retryRefs.length, 2, `Commented @retry should be excluded from refs, got ${JSON.stringify([...retryLines])}`);

        // Go-to-definition on continuation line `  imp_beta` -> defs.inc
        const impBetaLine = findLine('  imp_beta');
        const impBetaDef = await client.request('textDocument/definition', {
            textDocument: { uri: mainUri },
            position: { line: impBetaLine, character: lines[impBetaLine].indexOf('imp_beta') + 2 },
        });
        const impBetaLoc = Array.isArray(impBetaDef) ? impBetaDef[0] : impBetaDef;
        assert(impBetaLoc && impBetaLoc.uri === defsUri, 'Expected imp_beta on continuation line to resolve to defs.inc');

        // Go-to-definition on `exported_two` on continuation line
        const expTwoRefLine = findLine('  exported_two');
        const expTwoDef = await client.request('textDocument/definition', {
            textDocument: { uri: mainUri },
            position: { line: expTwoRefLine, character: lines[expTwoRefLine].indexOf('exported_two') + 2 },
        });
        const expTwoLoc = Array.isArray(expTwoDef) ? expTwoDef[0] : expTwoDef;
        const expTwoDefLine = findLine('exported_two:');
        assert(expTwoLoc && expTwoLoc.range.start.line === expTwoDefLine, 'Expected exported_two on continuation line to resolve to exported_two:');

        // Anonymous label go-to-definition + inlay hints
        const realAnonLine = findLine(': ; real anon 1');
        const beqAnonLine = findLine('beq /* anon */ :-');
        const anonDef = await client.request('textDocument/definition', {
            textDocument: { uri: mainUri },
            position: { line: beqAnonLine, character: lines[beqAnonLine].indexOf(':-') },
        });
        const anonLoc = Array.isArray(anonDef) ? anonDef[0] : anonDef;
        assert(anonLoc && anonLoc.range.start.line === realAnonLine, `Expected :- to resolve to line ${realAnonLine}, got ${JSON.stringify(anonLoc)}`);

        const hints = await client.request('textDocument/inlayHint', {
            textDocument: { uri: mainUri },
            range: { start: { line: 0, character: 0 }, end: { line: lines.length, character: 0 } },
        });
        assert(
            hints.some(h => h.label === '1' && h.position.line === realAnonLine && h.position.character === 0),
            'Expected 1 inlay hint left of the real anonymous label colon'
        );
        assert(
            hints.some(h => h.label === '1' && h.position.line === beqAnonLine && h.position.character === lines[beqAnonLine].indexOf(':-')),
            'Expected 1 inlay hint left of :- ref'
        );
        const headerAnonFakeLine = findLine(' * :');
        const bodyAnonFakeLine = findLine('    :', realAnonLine);
        assert(
            !hints.some(h => h.position.line === headerAnonFakeLine || h.position.line === bodyAnonFakeLine),
            'No anonymous label inlay hints should appear inside /* ... */ comments'
        );

        // --------------------------------------------------------------
        // C. Hover: block comment suppression, column preservation, doc comments, multi-line evals
        // --------------------------------------------------------------
        const fakeHdrLdaLine = findLine(' * lda #$FF');
        assert.strictEqual(
            await client.request('textDocument/hover', {
                textDocument: { uri: mainUri },
                position: { line: fakeHdrLdaLine, character: lines[fakeHdrLdaLine].indexOf('lda') + 1 },
            }),
            null,
            'Hover on mnemonic inside multi-line /* ... */ (>200 lines) must be null'
        );
        assert.strictEqual(
            await client.request('textDocument/hover', {
                textDocument: { uri: mainUri },
                position: { line: fakeHdrLdaLine, character: lines[fakeHdrLdaLine].indexOf('$FF') + 1 },
            }),
            null,
            'Hover on hex number inside multi-line /* ... */ (>200 lines) must be null'
        );

        const inlineCommentValLine = findLine('  lda /* #$99 */ #$20');
        assert.strictEqual(
            await client.request('textDocument/hover', {
                textDocument: { uri: mainUri },
                position: { line: inlineCommentValLine, character: lines[inlineCommentValLine].indexOf('$99') + 1 },
            }),
            null,
            'Hover on #$99 inside inline /* #$99 */ must be null'
        );

        const inlineMidLine = findLine('  /* inline pre */ lda /* mid */ #$10 ; tail');
        const ldaHover = await client.request('textDocument/hover', {
            textDocument: { uri: mainUri },
            position: { line: inlineMidLine, character: lines[inlineMidLine].indexOf('lda') + 1 },
        });
        assert(ldaHover && ldaHover.contents.value.includes('Load accumulator'), 'Expected lda hover after inline /* inline pre */');

        const hexHover = await client.request('textDocument/hover', {
            textDocument: { uri: mainUri },
            position: { line: inlineMidLine, character: lines[inlineMidLine].indexOf('$10') + 1 },
        });
        assert(hexHover && hexHover.contents.value.includes('16'), `Expected numeric hover (16) after /* mid */, got ${JSON.stringify(hexHover)}`);

        // Doc comments with /* ... */ and multi-line params/values
        const procDefLine = findLine('.proc MainProc');
        const procHover = await client.request('textDocument/hover', {
            textDocument: { uri: mainUri },
            position: { line: procDefLine, character: lines[procDefLine].indexOf('MainProc') + 2 },
        });
        assert(procHover && procHover.contents.value.includes('Proc block doc for MainProc'), `Expected /* ... */ doc on MainProc hover, got ${JSON.stringify(procHover)}`);

        const macroDefLine = findLine('.macro SUM3');
        const macroHover = await client.request('textDocument/hover', {
            textDocument: { uri: mainUri },
            position: { line: macroDefLine, character: lines[macroDefLine].indexOf('SUM3') + 1 },
        });
        assert(
            macroHover
            && macroHover.contents.value.includes('Macro block doc for SUM3')
            && macroHover.contents.value.includes('first')
            && macroHover.contents.value.includes('second')
            && macroHover.contents.value.includes('third'),
            `Expected /* ... */ doc and all 3 multi-line params on SUM3 hover, got ${JSON.stringify(macroHover)}`
        );

        const defineDefLine = findLine('.define ADD2');
        const defineHover = await client.request('textDocument/hover', {
            textDocument: { uri: mainUri },
            position: { line: defineDefLine, character: lines[defineDefLine].indexOf('ADD2') + 1 },
        });
        assert(
            defineHover
            && defineHover.contents.value.includes('Define block doc for ADD2')
            && defineHover.contents.value.includes('a')
            && defineHover.contents.value.includes('b'),
            `Expected /* ... */ doc and multi-line params on ADD2 hover, got ${JSON.stringify(defineHover)}`
        );

        const expOneDefLine = findLine('exported_one:');
        const expOneHover = await client.request('textDocument/hover', {
            textDocument: { uri: mainUri },
            position: { line: expOneDefLine, character: 2 },
        });
        assert(expOneHover && expOneHover.contents.value.includes('doc with export between'), `Expected /* ... */ doc across .export on exported_one hover`);

        const undocLine = findLine('UndocAfterTrailing:');
        const undocHover = await client.request('textDocument/hover', {
            textDocument: { uri: mainUri },
            position: { line: undocLine, character: 2 },
        });
        assert(undocHover && !undocHover.contents.value.includes('unrelated trailing comment'), 'Trailing inline /* ... */ on previous code line must not attach as doc');

        const indentedDocLine = findLine('IndentedDocLbl:');
        const indentedDocHover = await client.request('textDocument/hover', {
            textDocument: { uri: mainUri },
            position: { line: indentedDocLine, character: lines[indentedDocLine].indexOf('IndentedDocLbl') + 2 },
        });
        assert(
            indentedDocHover && indentedDocHover.contents.value.endsWith('\n\nIndented JSDoc'),
            `Expected indented JSDoc hover rendered as Markdown without delimiters, got ${JSON.stringify(indentedDocHover)}`
        );

        const plainBlockLine = findLine('PlainBlockLbl:');
        const plainBlockHover = await client.request('textDocument/hover', {
            textDocument: { uri: mainUri },
            position: { line: plainBlockLine, character: lines[plainBlockLine].indexOf('PlainBlockLbl') + 2 },
        });
        assert(
            plainBlockHover && !plainBlockHover.contents.value.includes('Plain block'),
            `Plain /* ... */ (non-JSDoc) block must not attach as hover doc when C comments are on, got ${JSON.stringify(plainBlockHover)}`
        );

        const drawSpriteLine = findLine('.proc DrawSprite');
        const drawSpriteHover = await client.request('textDocument/hover', {
            textDocument: { uri: mainUri },
            position: { line: drawSpriteLine, character: lines[drawSpriteLine].indexOf('DrawSprite') + 2 },
        });
        const dsVal = drawSpriteHover && drawSpriteHover.contents && drawSpriteHover.contents.value;
        assert(
            dsVal
            && dsVal.includes('\n\nDraws a sprite cleanly.\n\n**Important:** call inside NMI.\n- outer\n  - nested')
            && dsVal.includes('```ca65\n@loop:\n  dex\n```')
            && dsVal.includes('\n\n*@param* `A` \u2014 tile index\n\n*@param* `dst` \u2014 destination\n\n*@return* \u2014 Carry set on error\n\n*@clobber* `X`, `Y`\n\n*@preserve* `tmp0`')
            && !dsVal.includes('/**') && !dsVal.includes('*/'),
            `Expected JSDoc rendered as Markdown for DrawSprite, got:\n${dsVal}`
        );

        const constMlLine = findLine('CONST_ML = $10');
        const constMlHover = await client.request('textDocument/hover', {
            textDocument: { uri: mainUri },
            position: { line: constMlLine, character: 2 },
        });
        assert(constMlHover && constMlHover.contents.value.includes('$12') && constMlHover.contents.value.includes('18'), `Expected multi-line CONST_ML = $12 (18), got ${JSON.stringify(constMlHover)}`);

        const enumMemberLine = findLine('ME_ZERO = $01');
        const enumHover = await client.request('textDocument/hover', {
            textDocument: { uri: mainUri },
            position: { line: enumMemberLine, character: lines[enumMemberLine].indexOf('ME_ZERO') + 2 },
        });
        assert(enumHover && (enumHover.contents.value.includes('$04') || enumHover.contents.value.includes('= 4')), `Expected multi-line ME_ZERO = 4 / $04, got ${JSON.stringify(enumHover)}`);

        const structWidthLine = findLine('  width .byte 1 + \\');
        const structWidthHover = await client.request('textDocument/hover', {
            textDocument: { uri: mainUri },
            position: { line: structWidthLine, character: lines[structWidthLine].indexOf('width') + 2 },
        });
        assert(structWidthHover && structWidthHover.contents.value.includes('(2 bytes)'), `Expected multi-line Box::width (2 bytes) hover, got ${JSON.stringify(structWidthHover)}`);

        // --------------------------------------------------------------
        // D. Instruction Selection Analysis (/* ... */ + multi-line)
        // --------------------------------------------------------------
        const inlineAnalysis = await client.request('ca65/analyzeSelection', {
            uri: mainUri,
            range: { start: { line: inlineMidLine, character: 0 }, end: { line: inlineMidLine, character: lines[inlineMidLine].length } },
        });
        assert.strictEqual(inlineAnalysis.items.length, 1);
        assert.strictEqual(inlineAnalysis.items[0].mode, 'Immediate');
        assert.strictEqual(inlineAnalysis.minCycles, 2);

        const bodyCommentStart = findLine('  /*', realAnonLine);
        const bodyCommentSkipRange = await client.request('ca65/analyzeSelection', {
            uri: mainUri,
            range: { start: { line: bodyCommentStart, character: 0 }, end: { line: inlineMidLine, character: lines[inlineMidLine].length } },
        });
        assert.strictEqual(bodyCommentSkipRange.items.length, 1, 'Analyzer should skip instructions inside /* ... */ and count only real lda');

        const mlInstrLine = findLine('  lda tbl + \\');
        const mlInstrAnalysis = await client.request('ca65/analyzeSelection', {
            uri: mainUri,
            range: { start: { line: mlInstrLine, character: 0 }, end: { line: mlInstrLine + 1, character: lines[mlInstrLine + 1].length } },
        });
        assert.strictEqual(mlInstrAnalysis.items.length, 1);
        assert.strictEqual(mlInstrAnalysis.items[0].mode, 'Absolute, X');
        assert.strictEqual(mlInstrAnalysis.minBytes, 3);
        assert.strictEqual(mlInstrAnalysis.maxBytes, 3);

        // Selecting just the first line of a continued instruction should also follow continuation
        const mlFirstLineOnly = await client.request('ca65/analyzeSelection', {
            uri: mainUri,
            range: { start: { line: mlInstrLine, character: 0 }, end: { line: mlInstrLine, character: lines[mlInstrLine].length } },
        });
        assert.strictEqual(mlFirstLineOnly.items.length, 1);
        assert.strictEqual(mlFirstLineOnly.items[0].mode, 'Absolute, X');

        // Multi-line comment spanning an instruction across a newline
        const mlBlockInstrLine = findLine('  lda /* across');
        const mlBlockInstr = await client.request('ca65/analyzeSelection', {
            uri: mainUri,
            range: { start: { line: mlBlockInstrLine, character: 0 }, end: { line: mlBlockInstrLine + 1, character: lines[mlBlockInstrLine + 1].length } },
        });
        assert.strictEqual(mlBlockInstr.items.length, 1);
        assert.strictEqual(mlBlockInstr.items[0].mode, 'Immediate');
        assert.strictEqual(mlBlockInstr.minCycles, 2);

        // Constant value resolved from multi-line `=` / `.define` narrows `lda CONST_ML` & `lda DEF_CONST` to Zero page (2 bytes, 3 cycles)
        const ldaConstMlLine = findLine('  lda CONST_ML');
        const ldaConstMl = await client.request('ca65/analyzeSelection', {
            uri: mainUri,
            range: { start: { line: ldaConstMlLine, character: 0 }, end: { line: ldaConstMlLine, character: lines[ldaConstMlLine].length } },
        });
        assert.strictEqual(ldaConstMl.items[0].mode, 'Zero page', 'CONST_ML ($12) should narrow lda CONST_ML to Zero page');

        const ldaDefConstLine = findLine('  lda DEF_CONST');
        const ldaDefConst = await client.request('ca65/analyzeSelection', {
            uri: mainUri,
            range: { start: { line: ldaDefConstLine, character: 0 }, end: { line: ldaDefConstLine, character: lines[ldaDefConstLine].length } },
        });
        assert.strictEqual(ldaDefConst.items[0].mode, 'Zero page', 'DEF_CONST ($24) should narrow lda DEF_CONST to Zero page');

        // --------------------------------------------------------------
        // E. Completion: comment suppression & continuation-line context
        // --------------------------------------------------------------
        const deepFillerLine = 210;
        const compInMultiLineComment = await client.request('textDocument/completion', {
            textDocument: { uri: mainUri },
            position: { line: deepFillerLine, character: 4 },
        });
        const compInMultiItems = Array.isArray(compInMultiLineComment) ? compInMultiLineComment : compInMultiLineComment.items;
        assert.strictEqual(compInMultiItems.length, 0, 'Completion inside >200 line /* ... */ comment must be empty');

        const compInInlineComment = await client.request('textDocument/completion', {
            textDocument: { uri: mainUri },
            position: { line: inlineCommentValLine, character: lines[inlineCommentValLine].indexOf('#$99') + 2 },
        });
        const compInInlineItems = Array.isArray(compInInlineComment) ? compInInlineComment : compInInlineComment.items;
        assert.strictEqual(compInInlineItems.length, 0, 'Completion inside inline /* #$99 */ must be empty');

        const compExportContLine = lines.length - 1;
        const compExportCont = await client.request('textDocument/completion', {
            textDocument: { uri: mainUri },
            position: { line: compExportContLine, character: 2 },
        });
        const expContLabels = new Set((Array.isArray(compExportCont) ? compExportCont : compExportCont.items).map(i => i.label));
        assert(expContLabels.has('MainProc') || expContLabels.has('tbl'), 'Continuation line of .export should offer symbol completions');

        const compAfterMidCommentLine = findLine('  lda /* mid_complete */ ');
        const compAfterMid = await client.request('textDocument/completion', {
            textDocument: { uri: mainUri },
            position: { line: compAfterMidCommentLine, character: lines[compAfterMidCommentLine].length },
        });
        const compAfterMidLabels = new Set((Array.isArray(compAfterMid) ? compAfterMid : compAfterMid.items).map(i => i.label));
        assert(compAfterMidLabels.has('CONST_A'), 'Operand completions should be active after inline /* mid_complete */');
        assert(!compAfterMidLabels.has('nop'), 'Mnemonics should not be suggested in operand position after /* mid_complete */');

        const docTagLine = findLine(' * @param A tile index');
        const compDocTag = await client.request('textDocument/completion', {
            textDocument: { uri: mainUri },
            position: { line: docTagLine, character: lines[docTagLine].indexOf('@param') + 1 },
        });
        const compDocTagItems = Array.isArray(compDocTag) ? compDocTag : compDocTag.items;
        const compDocTagLabels = new Set(compDocTagItems.map(i => i.label));
        assert(
            compDocTagLabels.has('@input') && compDocTagLabels.has('@output') && compDocTagLabels.has('@param') && compDocTagLabels.has('@return') && compDocTagLabels.has('@clobber') && compDocTagLabels.has('@preserve'),
            `Expected Javadoc annotation dropdown on @ inside /** ... */, got ${JSON.stringify([...compDocTagLabels])}`
        );

        const docProseLine = findLine(' * **Important:** call inside NMI.');
        const compDocProse = await client.request('textDocument/completion', {
            textDocument: { uri: mainUri },
            position: { line: docProseLine, character: lines[docProseLine].indexOf('Important') },
        });
        const compDocProseItems = Array.isArray(compDocProse) ? compDocProse : compDocProse.items;
        assert.strictEqual(compDocProseItems.length, 0, 'Completion inside /** ... */ prose without @ must remain empty');

        // --------------------------------------------------------------
        // F. Signature Help: multi-line calls (\ and /* ... */) + /* doc */
        // --------------------------------------------------------------
        const sum3CallLine = findLine('  SUM3 1, \\');
        const sigParam0 = await client.request('textDocument/signatureHelp', {
            textDocument: { uri: mainUri },
            position: { line: sum3CallLine, character: lines[sum3CallLine].indexOf('1') + 1 },
        });
        assert(sigParam0 && sigParam0.signatures.length > 0);
        assert.strictEqual(sigParam0.activeParameter, 0);
        assert(
            sigParam0.signatures[0].documentation && sigParam0.signatures[0].documentation.value.includes('Macro block doc for SUM3'),
            'Signature help should include /* ... */ doc comment for macro'
        );

        const sigParam1 = await client.request('textDocument/signatureHelp', {
            textDocument: { uri: mainUri },
            position: { line: sum3CallLine + 1, character: lines[sum3CallLine + 1].indexOf('2') + 1 },
        });
        assert.strictEqual(sigParam1 && sigParam1.activeParameter, 1, 'Line 2 of multi-line macro call should highlight param 1');

        const sigParam2 = await client.request('textDocument/signatureHelp', {
            textDocument: { uri: mainUri },
            position: { line: sum3CallLine + 2, character: lines[sum3CallLine + 2].indexOf('3') + 1 },
        });
        assert.strictEqual(sigParam2 && sigParam2.activeParameter, 2, 'Line 3 of multi-line macro call should highlight param 2');

        const sum3BlockCallLine = findLine('  SUM3 10, /*');
        const sigBlockParam1 = await client.request('textDocument/signatureHelp', {
            textDocument: { uri: mainUri },
            position: { line: sum3BlockCallLine + 1, character: lines[sum3BlockCallLine + 1].indexOf('20') + 1 },
        });
        assert.strictEqual(sigBlockParam1 && sigBlockParam1.activeParameter, 1, 'Multi-line /* ... */ macro call should track parameter index across newline');

        const add2CallLine = findLine('  lda #ADD2(1, \\');
        const sigDefineParam1 = await client.request('textDocument/signatureHelp', {
            textDocument: { uri: mainUri },
            position: { line: add2CallLine + 1, character: lines[add2CallLine + 1].indexOf('2)') + 1 },
        });
        assert.strictEqual(sigDefineParam1 && sigDefineParam1.activeParameter, 1, 'Multi-line .define call should highlight param 1');
        assert(
            sigDefineParam1.signatures[0].documentation && sigDefineParam1.signatures[0].documentation.value.includes('Define block doc for ADD2'),
            'Signature help should include /* ... */ doc comment for .define'
        );

        const jsdocCallLine = findLine('  JSDOC_MAC $01');
        const sigJsdoc = await client.request('textDocument/signatureHelp', {
            textDocument: { uri: mainUri },
            position: { line: jsdocCallLine, character: lines[jsdocCallLine].indexOf('$01') },
        });
        assert(
            sigJsdoc
            && sigJsdoc.signatures[0].documentation
            && sigJsdoc.signatures[0].documentation.value === 'Emits immediate byte.\n\n*@param* `val` \u2014 byte to load',
            `Signature help should render /** ... */ comment as Markdown, got: ${JSON.stringify(sigJsdoc)}`
        );

        // --------------------------------------------------------------
        // G. Code Actions: number conversion ignores inline /* ... */ but works after it
        // --------------------------------------------------------------
        const realNumActions = await client.request('textDocument/codeAction', {
            textDocument: { uri: mainUri },
            range: {
                start: { line: inlineMidLine, character: lines[inlineMidLine].indexOf('#$10') + 1 },
                end: { line: inlineMidLine, character: lines[inlineMidLine].indexOf('#$10') + 1 },
            },
            context: { diagnostics: [] },
        });
        const decAction = realNumActions.find(a => a.title === 'Convert to decimal (16)');
        assert(
            decAction,
            `Expected number conversion code action after inline /* mid */, got ${JSON.stringify(realNumActions.map(a => a.title))}`
        );
        const decEdit = decAction.edit && decAction.edit.changes && decAction.edit.changes[mainUri] && decAction.edit.changes[mainUri][0];
        assert(
            decEdit && decEdit.range.start.character === lines[inlineMidLine].indexOf('$10') && decEdit.newText === '16',
            `Expected code action edit at exact $10 column, got ${JSON.stringify(decEdit)}`
        );

        const commentedNumActions = await client.request('textDocument/codeAction', {
            textDocument: { uri: mainUri },
            range: {
                start: { line: inlineCommentValLine, character: lines[inlineCommentValLine].indexOf('#$99') + 2 },
                end: { line: inlineCommentValLine, character: lines[inlineCommentValLine].indexOf('#$99') + 2 },
            },
            context: { diagnostics: [] },
        });
        assert.strictEqual(commentedNumActions.length, 0, 'No number conversion code actions should trigger inside inline /* #$99 */');

        console.log('ALL C-STYLE COMMENT & MULTILINE CHECKS PASSED!');
    } finally {
        await client.close();
        fs.rmSync(tmpRoot, { recursive: true, force: true });
    }

    // ------------------------------------------------------------------
    // 3. Language Configuration (/** auto-closing & * continuation onEnterRules)
    // ------------------------------------------------------------------
    const langCfg = JSON.parse(
        fs.readFileSync(path.resolve(process.cwd(), 'language-configuration.json'), 'utf8')
    );
    const jsdocPair = langCfg.autoClosingPairs.find(p => p && p.open === '/**');
    assert.deepStrictEqual(jsdocPair, { open: '/**', close: ' */', notIn: ['string'] });

    const matchOnEnterRule = (before, after = '', prevLine = '') => {
        for (const rule of langCfg.onEnterRules) {
            const bRe = new RegExp(typeof rule.beforeText === 'string' ? rule.beforeText : rule.beforeText.pattern);
            if (!bRe.test(before)) continue;
            if (rule.afterText) {
                const aRe = new RegExp(typeof rule.afterText === 'string' ? rule.afterText : rule.afterText.pattern);
                if (!aRe.test(after)) continue;
            }
            if (rule.previousLineText) {
                const pRe = new RegExp(typeof rule.previousLineText === 'string' ? rule.previousLineText : rule.previousLineText.pattern);
                if (!pRe.test(prevLine)) continue;
            }
            return rule.action;
        }
        return null;
    };

    assert.deepStrictEqual(matchOnEnterRule('  /**', ' */'), { indent: 'indentOutdent', appendText: ' * ' });
    assert.deepStrictEqual(matchOnEnterRule('  /** summary', ' */'), { indent: 'indentOutdent', appendText: ' * ' });
    assert.deepStrictEqual(matchOnEnterRule('  /** summary', ''), { indent: 'none', appendText: ' * ' });
    assert.deepStrictEqual(matchOnEnterRule('   * line 1', '', '  /**'), { indent: 'none', appendText: '* ' });
    assert.deepStrictEqual(matchOnEnterRule('   * line 2', '', '   * line 1'), { indent: 'none', appendText: '* ' });
    assert.strictEqual(matchOnEnterRule('   * $02', '', 'FOO = $10 \\'), null, 'Multi-line * expression must not append * ');
    assert.deepStrictEqual(matchOnEnterRule('   */', '', '   * line 2'), { indent: 'none', removeText: 1 });
    assert.deepStrictEqual(matchOnEnterRule('   * end */', '', '   * line 2'), { indent: 'none', removeText: 1 });
    assert.deepStrictEqual(matchOnEnterRule('   * a/b */', '', '   * line 2'), { indent: 'none', removeText: 1 });
    assert.strictEqual(matchOnEnterRule('   * a */ /* b */', '', '   * line 2'), null);
    assert.strictEqual(matchOnEnterRule('  /** inline */', '', ''), null);

    const unindentedRe = new RegExp(langCfg.indentationRules.unIndentedLinePattern);
    assert(unindentedRe.test(' * line'), 'unIndentedLinePattern should ignore * doc lines');
    assert(unindentedRe.test(' *'), 'unIndentedLinePattern should ignore bare * doc lines');
    assert(unindentedRe.test(' */'), 'unIndentedLinePattern should ignore closing */ lines');
    assert(unindentedRe.test(' * end/path */'), 'unIndentedLinePattern should ignore closing * ... */ lines');
    assert(unindentedRe.test('     */'), 'unIndentedLinePattern should ignore indented closing */ lines');
    assert(!unindentedRe.test('/**'), 'unIndentedLinePattern must not ignore opening /** line');
    assert(!unindentedRe.test('    /**'), 'unIndentedLinePattern must not ignore indented opening /** line');
    assert(!unindentedRe.test('    lda #$00'), 'unIndentedLinePattern must not ignore normal code');

    const getInheritedIndentAfterBlankLine = (docLines) => {
        for (let i = docLines.length - 1; i >= 0; i--) {
            const line = docLines[i];
            if (/^\s*$/.test(line) || unindentedRe.test(line)) continue;
            return (line.match(/^(\s*)/) || ['', ''])[1];
        }
        return '';
    };
    assert.strictEqual(
        getInheritedIndentAfterBlankLine(['/**', ' * doc', ' */', '']),
        '',
        'Pressing Enter on blank line after top-level /** ... */ must align to column 1, not column 2'
    );
    assert.strictEqual(
        getInheritedIndentAfterBlankLine(['.proc foo', '    /**', '     * doc', '     */', '    ']),
        '    ',
        'Pressing Enter on blank line after indented /** ... */ must align to /** indent (4 spaces), not */ indent (5 spaces)'
    );

    // ------------------------------------------------------------------
    // 4. Verbatim doc comment block unit checks
    // ------------------------------------------------------------------
    const { formatDocCommentForHover, extractLeadingDocInfo, renderDefinitionDocMarkdown } = loadHoverHelpers();
    const stubDoc = (text) => {
        const docLines = text.split('\n');
        return {
            uri: 'file:///stub.s',
            lineCount: docLines.length,
            getText: (r) => docLines.slice(r.start.line, r.end.line).map(l => l + '\n').join(''),
        };
    };
    const inlineDoc = stubDoc([
        '; this is a comment',                 // 0
        'foo: ; this is inline',               // 1
        'bar: lda #";" ; semi in string',      // 2
        '/** jsdoc */',                        // 3
        'baz: ; ignored inline',               // 4
        '; ======================',            // 5
        '; Section title',                     // 6
        ';;;;;;;;;;;;;;;;;;;;;;;',             // 7
        ';',                                   // 8
        '; Real doc',                          // 9
        ';',                                   // 10
        '; - not a divider',                   // 11
        '; ----------',                        // 12
        'qux: ; ------',                       // 13
        '/* plain */',                         // 14
        'quux: ; after plain',                 // 15
    ].join('\n'));
    for (const cComments of [false, true]) {
        assert.strictEqual(
            renderDefinitionDocMarkdown(inlineDoc, 1, { cComments }),
            '```ca65\n; this is a comment\n```\n\n---\n\n```ca65\n; this is inline\n```',
            `The touching ; block and the definition line's trailing ; comment render verbatim, split by a rule (cComments ${cComments})`
        );
        assert.strictEqual(
            renderDefinitionDocMarkdown(inlineDoc, 13, { cComments }),
            '```ca65\n; ======================\n; Section title\n;;;;;;;;;;;;;;;;;;;;;;;\n;\n; Real doc\n;\n; - not a divider\n; ----------\n```\n\n---\n\n```ca65\n; ------\n```',
            `; doc blocks and the trailing comment render verbatim, dividers and bare ; lines included (cComments ${cComments})`
        );
    }
    assert.strictEqual(extractLeadingDocInfo(inlineDoc, 2, { cComments: false }).inlineComment, '; semi in string');
    assert.strictEqual(renderDefinitionDocMarkdown(inlineDoc, 4, { cComments: true }), 'jsdoc', 'A /** */ block wins over ; comments and skips the trailing ; comment');
    assert.strictEqual(renderDefinitionDocMarkdown(inlineDoc, 15, { cComments: true }), '```ca65\n; after plain\n```', 'A plain /* */ block is not a doc comment');

    // ca65.hoverDocs: docBlocks shows only /** */ blocks
    assert.strictEqual(renderDefinitionDocMarkdown(inlineDoc, 1, { hoverDocs: 'docBlocks' }), '', 'docBlocks ignores ; comments above and beside');
    assert.strictEqual(renderDefinitionDocMarkdown(inlineDoc, 4, { hoverDocs: 'docBlocks' }), 'jsdoc', 'docBlocks still shows /** */ blocks');
    assert.strictEqual(renderDefinitionDocMarkdown(inlineDoc, 4, { hoverDocs: 'docBlocks', cComments: false }), '', 'docBlocks shows nothing when C comments are off');

    assert.strictEqual(formatDocCommentForHover('/**/'), '');
    assert.strictEqual(formatDocCommentForHover('/*   */'), '');
    assert.strictEqual(
        formatDocCommentForHover('/**\n * | col1 | col2 |\n */'),
        '```ca65\n/**\n * | col1 | col2 |\n */\n```'
    );
    assert.strictEqual(
        formatDocCommentForHover('; verbatim\n; comment'),
        '```ca65\n; verbatim\n; comment\n```'
    );
})().catch((err) => {
    console.error(err);
    process.exit(1);
});
