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

const { findPreviousCheapLocalBoundary, getCheapLocalLabelDefinitions, findAllCheapLocalLabelReferences } =
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

// 4. instructionAnalyzer: char-code tokenizeExpr
{
    const asm = [
        'ZP_VAL = ($1_0 << 1) + %0010_0000 - 0x10',
        "  lda #'A'",
        '  lda ZP_VAL,x',
        '  jmp $1234',
    ].join('\n');
    const doc = TextDocument.create('file:///test/ia.s', 'ca65', 1, asm);
    const res = analyzeInstructionRange(
        doc,
        { start: { line: 0, character: 0 }, end: { line: 3, character: 10 } },
        undefined,
        new Map(),
        new IncludesGraph(),
        false
    );
    assert.strictEqual(res.instructionCount, 3);
    assert.strictEqual(res.items[0].mode, 'Immediate');
    assert.strictEqual(res.items[2].mode, 'Absolute');
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
        '  rts',
        '.endproc',
        '.proc Callee',
        '  rts',
        '.endproc',
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
        assert.strictEqual(outgoing.length, 1);
        assert.strictEqual(outgoing[0].to.name, 'Callee');

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
