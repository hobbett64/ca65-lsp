const assert = require('assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { pathToFileURL } = require('url');
const { spawn } = require('child_process');
const { TextDocument } = require(require.resolve('vscode-languageserver-textdocument', { paths: [process.cwd()] }));

const Module = require('module');
const origLoad = Module._load;
const stMapGlobal = new Map();
let workspaceFolderUrisGlobal = [];
const { ExportsMap } = require(path.resolve(process.cwd(), 'server/out/exportsMap.js'));
const { IncludesGraph } = require(path.resolve(process.cwd(), 'server/out/includesGraph.js'));
const { Performance } = require(path.resolve(process.cwd(), 'server/out/performance.js'));
Module._load = function (req) {
    if (req === './server') {
        return {
            symbolTables: stMapGlobal,
            workspaceFolderUris: workspaceFolderUrisGlobal,
            exportsMap: new ExportsMap(),
            includesGraph: new IncludesGraph(),
            performanceMonitor: new Performance(),
            getDocumentSettings: async () => ({ includeDirs: [], implicitImports: false }),
            connection: { console: { log() {}, error() {} } },
        };
    }
    return origLoad.apply(this, arguments);
};

const { findPreviousCheapLocalBoundary, getCheapLocalLabelDefinitions, findAllCheapLocalLabelReferences, findCheapLocalLabelDefinition } =
    require(path.resolve(process.cwd(), 'server/out/cheapLocalLabelUtils.js'));
const { makeIncludeEdit, makeImportEdit, makeExportEdit } =
    require(path.resolve(process.cwd(), 'server/out/editUtils.js'));
const { parseLstContent } =
    require(path.resolve(process.cwd(), 'server/out/lstParser.js'));
const { analyzeInstructionRange } =
    require(path.resolve(process.cwd(), 'server/out/instructionAnalyzer.js'));
const { loadAllData } =
    require(path.resolve(process.cwd(), 'server/out/dataManager.js'));

loadAllData({ console: { log() {}, error() {} } });

// 1. cheapLocalLabelUtils edge cases: empty line 0, CRLF, @def after @ref
{
    const doc = TextDocument.create('file:///test/cl.s', 'ca65', 1, '\r\nmain:\r\n  bne @next\r\n@next:\r\n  rts\r\n');
    assert.strictEqual(findPreviousCheapLocalBoundary(doc, 0), -1);
    assert.strictEqual(findPreviousCheapLocalBoundary(doc, 3), 1);
    assert.deepStrictEqual(getCheapLocalLabelDefinitions(doc, { line: 2, character: 6 }), ['@next']);
    const refs = findAllCheapLocalLabelReferences(doc, { line: 2, character: 8 });
    assert.strictEqual(refs.length, 2);

    const noBoundary = TextDocument.create('file:///test/cl2.s', 'ca65', 1, '\n\n@top:\n  bne @top\n');
    assert.strictEqual(findPreviousCheapLocalBoundary(noBoundary, 2), -1);
    assert.deepStrictEqual(getCheapLocalLabelDefinitions(noBoundary, { line: 3, character: 4 }), ['@top']);

    // Cheap locals defined by assignment are scoped like labels: each routine has its own @x.
    const assigned = TextDocument.create('file:///test/cl3.s', 'ca65', 1, [
        'first:',          // 0
        '@x = r0',         // 1
        '@y := r1',        // 2
        '@n .set 3',       // 3
        '  lda @x',        // 4
        '  lda @y',        // 5
        '@done:',          // 6
        '  rts',           // 7
        'second:',         // 8
        '@x = r2 ; other', // 9
        '  lda @x',        // 10
        '',
    ].join('\n'));
    assert.deepStrictEqual(getCheapLocalLabelDefinitions(assigned, { line: 4, character: 0 }), ['@x', '@y', '@n', '@done']);
    assert.deepStrictEqual(getCheapLocalLabelDefinitions(assigned, { line: 10, character: 0 }), ['@x']);
    const firstX = findAllCheapLocalLabelReferences(assigned, { line: 4, character: 7 });
    assert.deepStrictEqual(firstX.map(l => l.range.start.line), [1, 4]);
    const secondX = findAllCheapLocalLabelReferences(assigned, { line: 10, character: 7 });
    assert.deepStrictEqual(secondX.map(l => l.range.start.line), [9, 10]);
    const def = findCheapLocalLabelDefinition(assigned, { line: 10, character: 7 }, '@x');
    assert.strictEqual(def.range.start.line, 9);
}

// 2. editUtils edge cases: comment-only file ending in \n, CRLF sorted insertion
{
    const commentOnly = TextDocument.create('file:///test/e1.s', 'ca65', 1, '; header\n');
    const incEdit = makeIncludeEdit(commentOnly, 'foo.inc');
    assert.strictEqual(incEdit.newText, '.include "foo.inc"\n');

    const crlfDoc = TextDocument.create(
        'file:///test/e2.s',
        'ca65',
        1,
        '; doc\r\n\r\n.include "a.inc"\r\n.include "c.inc"\r\n\r\n.import Alpha\r\n\r\n  lda #0\r\n'
    );
    const incB = makeIncludeEdit(crlfDoc, 'b.inc');
    assert.deepStrictEqual(incB.range.start, { line: 3, character: 0 });
    const impBeta = makeImportEdit(crlfDoc, 'Beta', '.importzp');
    assert.strictEqual(impBeta.newText, '.importzp Beta\n');
    assert.deepStrictEqual(impBeta.range.start, { line: 6, character: 0 });
    const expEdit = makeExportEdit(crlfDoc, 'OutSym');
    assert.strictEqual(expEdit.newText, '.export OutSym\n\n');
}

// 3. lstParser edge cases: continuation bytes, .res xx bytes, reloc rr, include depth
{
    const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'ca65-lst-edge-'));
    try {
        const incFile = path.join(tmpDir, 'inc.s');
        const mainFile = path.join(tmpDir, 'main.s');
        fs.writeFileSync(incFile, 'lda #$01\n');
        fs.writeFileSync(mainFile, '.include "inc.s"\n');

        const incUri = pathToFileURL(incFile).toString();
        const mainUri = pathToFileURL(mainFile).toString();
        workspaceFolderUrisGlobal.push(pathToFileURL(tmpDir).toString());
        stMapGlobal.set(incUri, {});
        stMapGlobal.set(mainUri, {});
        try {
            const lst = [
                'ca65 V2.19',
                'Main file   : ' + mainFile,
                '',
                '000000r 1               .include "inc.s"',
                '000000r 2  A9 01        lda #$01',
                '000002r 1  01 02 03 04  .byte 1,2,3,4,5,6',
                '000006r 1  05 06',
                '000008  1  xx xx xx xx  .res 4',
                '00000Cr 1  20 rr rr     jsr ext_fn',
            ].join('\r\n');
            const parsed = parseLstContent(lst, mainUri, []);
            const mainMap = parsed.get(mainUri);
            const incMap = parsed.get(incUri);
            assert(incMap && incMap.get(0).bytesText === 'A9 01', 'Included line 0 bytes');
            assert(mainMap && mainMap.get(1).bytesText === '01 02 03 04 05 06', 'Continuation bytes');
            assert(mainMap.get(1).byteCount === 6, 'Continuation byteCount');
            assert(mainMap.get(2).bytesText === 'xx xx xx xx', 'xx bytes');
            assert(mainMap.get(3).bytesText === '20 rr rr' && mainMap.get(3).offsetHex === '000C', 'rr bytes + offsetHex');
        } finally {
            stMapGlobal.clear();
            workspaceFolderUrisGlobal.length = 0;
        }
    } finally {
        fs.rmSync(tmpDir, { recursive: true, force: true });
    }
}

// 4. instructionAnalyzer: char-code tokenizeExpr & custom : zeropage / : far segment width
{
    const { Position, Range } = require('vscode-languageserver-types');
    const { parseSegmentDirectiveArgs, ReferenceInfo, SymbolKind, SymbolTable } = require(path.resolve(process.cwd(), 'server/out/symbolTable.js'));
    assert.deepStrictEqual(parseSegmentDirectiveArgs('"AUDIOZP": zeropage'), { segment: 'AUDIOZP', addrSize: 'zp' });
    assert.deepStrictEqual(parseSegmentDirectiveArgs('"BANK01": far'), { segment: 'BANK01', addrSize: 'far' });
    assert.deepStrictEqual(parseSegmentDirectiveArgs('"CODE"'), { segment: 'CODE', addrSize: undefined });

    const asm = [
        'ZP_VAL = ($1_0 << 1) + %0010_0000 - 0x10',
        "  lda #'A'",
        '  lda ZP_VAL,x',
        '  jmp $1234',
        '  lda audio_zp',
    ].join('\n');
    const doc = TextDocument.create('file:///test/ia.s', 'ca65', 1, asm);
    const st = new SymbolTable(doc.uri);
    st.recordSegmentAddrSize('AUDIOZP', 'zp');
    st.getRootScope().addSymbol('audio_zp', Range.create(Position.create(0, 0), Position.create(0, 8)), SymbolKind.ResLabel, 'AUDIOZP');
    st.addReference(new ReferenceInfo(doc.uri, 'audio_zp', [], 'symbol', Range.create(Position.create(4, 6), Position.create(4, 14)), st.getRootScope()));
    const ig = new IncludesGraph();
    ig.updateIncludes(doc.uri, []);
    const res = analyzeInstructionRange(
        doc,
        { start: { line: 0, character: 0 }, end: { line: 4, character: 14 } },
        st,
        new Map([[doc.uri, st]]),
        ig,
        false
    );
    assert.strictEqual(res.instructionCount, 4);
    assert.strictEqual(res.items[0].mode, 'Immediate');
    assert.strictEqual(res.items[2].mode, 'Absolute');
    assert.strictEqual(res.items[3].mode, 'Zero page');
}

// 4b. Feature-flag comment/continuation gating & built-in fs glob matcher
{
    const {
        stripCommentsInLine,
        maskCommentsAtDocumentLine,
        doesStrippedLineContinue,
        getCursorCommentContext,
    } = require(path.resolve(process.cwd(), 'server/out/documentScanner.js'));
    const { globPatternToRegExp, resolveWorkspaceRelativeDirs, clearResolvedDirsCache } =
        require(path.resolve(process.cwd(), 'server/out/pathUtils.js'));

    // cComments = false leaves `/* ... */` untouched
    assert.strictEqual(stripCommentsInLine('lda /* x */ #1', false, true).code, 'lda         #1');
    assert.strictEqual(stripCommentsInLine('lda /* x */ #1', false, false).code, 'lda /* x */ #1');
    assert.strictEqual(stripCommentsInLine('lda /* x */ ; semi', false, false).code, 'lda /* x */ ');

    const contDoc = TextDocument.create('file:///test/flags.s', 'ca65', 1, 'FOO = 1 + \\\n  2\n/* unclosed\n  lda ');
    assert.strictEqual(maskCommentsAtDocumentLine(contDoc, 3, undefined, true), '');
    assert.strictEqual(maskCommentsAtDocumentLine(contDoc, 3, undefined, false), '  lda ');
    assert.strictEqual(doesStrippedLineContinue(stripCommentsInLine('FOO = 1 + \\', false, true), true), true);
    assert.strictEqual(doesStrippedLineContinue(stripCommentsInLine('FOO = 1 + \\', false, true), false), false);

    const ctxDefault = getCursorCommentContext(contDoc, { line: 1, character: 3 }, { cComments: true, lineContinuations: true });
    assert.strictEqual(ctxDefault.logicalCodeToCursor, 'FOO = 1 +    2');
    const ctxNoCont = getCursorCommentContext(contDoc, { line: 1, character: 3 }, { cComments: false, lineContinuations: false });
    assert.strictEqual(ctxNoCont.logicalCodeToCursor, '  2');
    assert.strictEqual(ctxNoCont.inComment, false);

    // Built-in glob regex & resolveWorkspaceRelativeDirs
    const incRe = globPatternToRegExp('**/include');
    assert(incRe.test('include') && incRe.test('src/include') && !incRe.test('my_include'));
    const multiExtRe = globPatternToRegExp('**/*.{s,inc}');
    assert(multiExtRe.test('main.s') && multiExtRe.test('inc/defs.inc') && !multiExtRe.test('main.o'));

    const globTmp = fs.mkdtempSync(path.join(os.tmpdir(), 'ca65-glob-'));
    try {
        fs.mkdirSync(path.join(globTmp, 'src', 'include'), { recursive: true });
        fs.mkdirSync(path.join(globTmp, 'levels', 'lvl1'), { recursive: true });
        fs.mkdirSync(path.join(globTmp, '.git', 'include'), { recursive: true });
        fs.mkdirSync(path.join(globTmp, 'node_modules', 'include'), { recursive: true });
        const wsTmpUri = pathToFileURL(globTmp).toString();
        const fileTmpUri = pathToFileURL(path.join(globTmp, 'src', 'main.s')).toString();
        workspaceFolderUrisGlobal.push(wsTmpUri);
        clearResolvedDirsCache();
        const dirs = resolveWorkspaceRelativeDirs(fileTmpUri, ['**/include', 'levels/*']);
        assert(dirs.includes(path.join(globTmp, 'src', 'include')), 'Should expand **/include');
        assert(dirs.includes(path.join(globTmp, 'levels', 'lvl1')), 'Should expand levels/*');
        assert(!dirs.some(d => d.includes('.git') || d.includes('node_modules')), 'Should ignore .git and node_modules');
    } finally {
        workspaceFolderUrisGlobal.length = 0;
        clearResolvedDirsCache();
        fs.rmSync(globTmp, { recursive: true, force: true });
    }

    // 4c. instructionAnalyzer .lst refinement & fallback
    const { Position, Range } = require('vscode-languageserver-types');
    const { ReferenceInfo, SymbolKind, SymbolTable } = require(path.resolve(process.cwd(), 'server/out/symbolTable.js'));
    const lstAsm = [
        '.import imp_unknown',
        '  lda imp_unknown',
        '  lda #$12',
        '  lda #$12',
        '  brk',
        '  brk $00',
        '  lda zp_forward',
        '  lda no_lst_entry',
        '.zeropage',
        'zp_forward: .res 1',
        '  .byte 1, 2',
        '  .byte 3, 4, 5',
    ].join('\n');
    const lstDoc = TextDocument.create('file:///test/ia_lst.s', 'ca65', 1, lstAsm);
    const lstSt = new SymbolTable(lstDoc.uri);
    lstSt.getRootScope().addSymbol('zp_forward', Range.create(Position.create(9, 0), Position.create(9, 10)), SymbolKind.ResLabel, 'ZEROPAGE');
    lstSt.addReference(new ReferenceInfo(lstDoc.uri, 'zp_forward', [], 'symbol', Range.create(Position.create(6, 6), Position.create(6, 16)), lstSt.getRootScope()));
    const lstIg = new IncludesGraph();
    lstIg.updateIncludes(lstDoc.uri, []);
    const lstAllSt = new Map([[lstDoc.uri, lstSt]]);

    const lstMap = new Map([
        [1, { line: 1, offset: 0, offsetHex: '0000', isRelocatable: true, bytesText: 'AD rr rr', byteCount: 3 }],
        [2, { line: 2, offset: 3, offsetHex: '0003', isRelocatable: true, bytesText: 'A9 12', byteCount: 2 }],
        [3, { line: 3, offset: 5, offsetHex: '0005', isRelocatable: true, bytesText: 'A9 12 00', byteCount: 3 }],
        [4, { line: 4, offset: 8, offsetHex: '0008', isRelocatable: true, bytesText: '00', byteCount: 1 }],
        [5, { line: 5, offset: 9, offsetHex: '0009', isRelocatable: true, bytesText: '00 00', byteCount: 2 }],
        [6, { line: 6, offset: 11, offsetHex: '000B', isRelocatable: true, bytesText: 'AD rr rr', byteCount: 3 }],
        [7, { line: 7, offset: 14, offsetHex: '000E', isRelocatable: true, bytesText: 'xx xx', byteCount: 2 }],
        [10, { line: 10, offset: 16, offsetHex: '0010', isRelocatable: true, bytesText: '01 02', byteCount: 2 }],
        [11, { line: 11, offset: 18, offsetHex: '0012', isRelocatable: true, bytesText: '03 04 05', byteCount: 3 }],
    ]);

    const resImp = analyzeInstructionRange(lstDoc, Range.create(1, 0, 1, 20), lstSt, lstAllSt, lstIg, false, '6502', true, true, lstMap);
    assert.strictEqual(resImp.usedListing, true);
    assert.strictEqual(resImp.uncertainCount, 0);
    assert.strictEqual(resImp.items[0].mode, 'Absolute');
    assert.strictEqual(resImp.items[0].bytesText, 'AD rr rr');
    assert.strictEqual(resImp.minBytes, 3);
    assert.strictEqual(resImp.maxBytes, 3);
    assert.strictEqual(resImp.minCycles, 4);
    assert.strictEqual(resImp.maxCycles, 4);

    const resImm8 = analyzeInstructionRange(lstDoc, Range.create(2, 0, 2, 12), lstSt, lstAllSt, lstIg, false, '65816', true, true, lstMap);
    assert.strictEqual(resImm8.usedListing, true);
    assert.strictEqual(resImm8.minBytes, 2);
    assert.strictEqual(resImm8.maxBytes, 2);
    assert.strictEqual(resImm8.minCycles, 2);
    assert.strictEqual(resImm8.maxCycles, 2);
    assert.strictEqual(Boolean(resImm8.hasVariableWidth16), false);

    const resImm16 = analyzeInstructionRange(lstDoc, Range.create(3, 0, 3, 12), lstSt, lstAllSt, lstIg, false, '65816', true, true, lstMap);
    assert.strictEqual(resImm16.usedListing, true);
    assert.strictEqual(resImm16.minBytes, 3);
    assert.strictEqual(resImm16.maxBytes, 3);
    assert.strictEqual(resImm16.minCycles, 3);
    assert.strictEqual(resImm16.maxCycles, 3);
    assert.strictEqual(Boolean(resImm16.hasVariableWidth16), false);

    const resBrk = analyzeInstructionRange(lstDoc, Range.create(4, 0, 5, 10), lstSt, lstAllSt, lstIg, false, '65816', true, true, lstMap);
    assert.strictEqual(resBrk.items[0].mode, 'Implied');
    assert.strictEqual(resBrk.items[0].minBytes, 1);
    assert.strictEqual(resBrk.items[1].mode, 'Signature');
    assert.strictEqual(resBrk.items[1].minBytes, 2);

    const resFwdZp = analyzeInstructionRange(lstDoc, Range.create(6, 0, 6, 20), lstSt, lstAllSt, lstIg, false, '6502', true, true, lstMap);
    assert.strictEqual(resFwdZp.items[0].mode, 'Absolute', '.lst should override forward ZP static guess when ca65 emitted AD');
    assert.strictEqual(resFwdZp.minBytes, 3);

    const resFallback = analyzeInstructionRange(lstDoc, Range.create(7, 0, 7, 20), lstSt, lstAllSt, lstIg, false, '6502', true, true, lstMap);
    assert.strictEqual(resFallback.usedListing, undefined, 'Non-hex xx xx listing entry should fall back to static');
    assert.strictEqual(resFallback.items[0].mode, 'Zero page / Absolute');

    const resMultiData = analyzeInstructionRange(lstDoc, Range.create(10, 0, 11, 15), lstSt, lstAllSt, lstIg, false, '6502', true, true, lstMap);
    assert.strictEqual(resMultiData.instructionCount, 0);
    assert.strictEqual(resMultiData.usedListing, true);
    assert.deepStrictEqual(resMultiData.lineListing, {
        bytesText: '',
        byteCount: 5,
    });
    assert.deepStrictEqual(resMultiData.listingLines, [
        { line: 10, bytesText: '01 02', byteCount: 2 },
        { line: 11, bytesText: '03 04 05', byteCount: 3 },
    ]);

    // Mixed selection (instruction + non-instruction .byte lines) includes listingLines in addition to items
    const resMixed = analyzeInstructionRange(lstDoc, Range.create(6, 0, 11, 15), lstSt, lstAllSt, lstIg, false, '6502', true, true, lstMap);
    assert.strictEqual(resMixed.instructionCount, 2);
    assert.deepStrictEqual(resMixed.listingLines, [
        { line: 10, bytesText: '01 02', byteCount: 2 },
        { line: 11, bytesText: '03 04 05', byteCount: 3 },
    ]);
}

// 5. E2E LSP: coalesced didChange -> immediate documentLink & callHierarchy & removal of .include clears diagnostics
class LspClient {
    constructor(serverPath) {
        this.proc = spawn('node', [serverPath, '--stdio'], { stdio: ['pipe', 'pipe', 'pipe'] });
        this.nextId = 1;
        this.pending = new Map();
        this.buf = Buffer.alloc(0);
        this.diags = new Map();
        this.diagWaiters = new Map();
        this.proc.stdout.on('data', (chunk) => {
            this.buf = Buffer.concat([this.buf, chunk]);
            while (true) {
                const headerEnd = this.buf.indexOf('\r\n\r\n');
                if (headerEnd === -1) break;
                const header = this.buf.slice(0, headerEnd).toString('utf8');
                const m = header.match(/Content-Length:\s*(\d+)/i);
                if (!m) break;
                const len = parseInt(m[1], 10);
                const msgStart = headerEnd + 4;
                if (this.buf.length < msgStart + len) break;
                const body = this.buf.slice(msgStart, msgStart + len).toString('utf8');
                this.buf = this.buf.slice(msgStart + len);
                const msg = JSON.parse(body);
                if (msg.id !== undefined && msg.method) {
                    if (msg.method === 'workspace/configuration') {
                        this._send({ jsonrpc: '2.0', id: msg.id, result: msg.params.items.map(() => ({})) });
                    }
                } else if (msg.id !== undefined && this.pending.has(msg.id)) {
                    const { resolve } = this.pending.get(msg.id);
                    this.pending.delete(msg.id);
                    resolve(msg.result);
                } else if (msg.method === 'textDocument/publishDiagnostics') {
                    this.diags.set(msg.params.uri, msg.params.diagnostics);
                    const waiters = this.diagWaiters.get(msg.params.uri);
                    if (waiters) {
                        for (const w of waiters) w(msg.params.diagnostics);
                        this.diagWaiters.delete(msg.params.uri);
                    }
                }
            }
        });
    }
    _send(obj) {
        const str = JSON.stringify(obj);
        this.proc.stdin.write(`Content-Length: ${Buffer.byteLength(str)}\r\n\r\n${str}`);
    }
    request(method, params) {
        const id = this.nextId++;
        return new Promise((resolve) => {
            this.pending.set(id, { resolve });
            this._send({ jsonrpc: '2.0', id, method, params });
        });
    }
    notify(method, params) {
        this._send({ jsonrpc: '2.0', method, params });
    }
    waitForDiags(uri, pred, timeoutMs = 8000) {
        return new Promise((resolve, reject) => {
            const check = (d) => {
                if (pred(d)) resolve(d);
                else {
                    const arr = this.diagWaiters.get(uri) || [];
                    arr.push(check);
                    this.diagWaiters.set(uri, arr);
                }
            };
            const arr = this.diagWaiters.get(uri) || [];
            arr.push(check);
            this.diagWaiters.set(uri, arr);
            setTimeout(() => reject(new Error('Timeout waiting for diagnostics on ' + uri)), timeoutMs);
        });
    }
    async close() {
        await this.request('shutdown', null);
        this.notify('exit', null);
        this.proc.kill();
    }
}

(async () => {
    const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'ca65-edge-e2e-'));
    const mainPath = path.join(tmpDir, 'main.s');
    const hdrPath = path.join(tmpDir, 'hdr.inc');
    const dataPath = path.join(tmpDir, 'gfx.bin');
    fs.writeFileSync(hdrPath, 'UNUSED_HDR_SYM = $1234\n');
    fs.writeFileSync(dataPath, Buffer.from([1, 2, 3, 4]));
    const mainSrc = [
        '.include "hdr.inc"',
        '.incbin "gfx.bin"',
        '.proc Caller',
        '  jsr Callee',
        '  jsr Gfx::init',
        '  rts',
        '.endproc',
        '.proc Callee',
        '  rts',
        '.endproc',
        '.scope Gfx',
        '.proc init',
        '  rts',
        '.endproc',
        '.endscope',
    ].join('\n');
    fs.writeFileSync(mainPath, mainSrc);

    const wsUri = pathToFileURL(tmpDir).toString();
    const mainUri = pathToFileURL(mainPath).toString();
    const hdrUri = pathToFileURL(hdrPath).toString();

    const client = new LspClient(path.resolve(process.cwd(), 'server/out/server.js'));
    try {
        await client.request('initialize', {
            processId: process.pid,
            rootUri: wsUri,
            workspaceFolders: [{ uri: wsUri, name: 'ws' }],
            capabilities: {},
        });
        client.notify('initialized', {});

        client.notify('textDocument/didOpen', {
            textDocument: { uri: mainUri, languageId: 'ca65', version: 1, text: mainSrc },
        });

        const links = await client.request('textDocument/documentLink', { textDocument: { uri: mainUri } });
        assert.strictEqual(links.length, 2, 'Should find both .include and .incbin documentLinks');

        const prep = await client.request('textDocument/prepareCallHierarchy', {
            textDocument: { uri: mainUri },
            position: { line: 2, character: 7 },
        });
        assert(prep && prep.length === 1);
        const outgoing = await client.request('callHierarchy/outgoingCalls', { item: prep[0] });
        // `jsr Gfx::init` calls init only: the Gfx qualifier is not a call to the scope
        assert.deepStrictEqual(outgoing.map(c => c.to.name).sort(), ['Callee', 'Gfx::init'],
            `Expected calls to Callee and Gfx::init only, got: ${outgoing.map(c => c.to.name).join(', ')}`);
        const initCall = outgoing.find(c => c.to.name === 'Gfx::init');
        assert.deepStrictEqual(initCall.fromRanges, [{ start: { line: 4, character: 11 }, end: { line: 4, character: 15 } }]);

        // Rapid edit removing .include "hdr.inc" and immediately checking documentLinks (coalesced flush)
        const editedSrc = mainSrc.replace('.include "hdr.inc"\n', '');
        const clearHdrDiags = client.waitForDiags(hdrUri, (d) => Array.isArray(d));
        client.notify('textDocument/didChange', {
            textDocument: { uri: mainUri, version: 2 },
            contentChanges: [{ text: editedSrc }],
        });
        const newLinks = await client.request('textDocument/documentLink', { textDocument: { uri: mainUri } });
        assert.strictEqual(newLinks.length, 1, 'After immediate edit+documentLink, only .incbin link remains');
        await clearHdrDiags;

        console.log('ALL EDGE CASE CHECKS PASSED!');
    } finally {
        await client.close();
        fs.rmSync(tmpDir, { recursive: true, force: true });
    }
})();
