const assert = require('assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { spawn } = require('child_process');
const { pathToFileURL } = require('url');

const serverEntry = path.resolve(process.cwd(), 'server/out/server.js');

function makeLspClient(workspaceDir) {
    const proc = spawn(process.execPath, [serverEntry, '--stdio'], {
        cwd: process.cwd(),
        stdio: ['pipe', 'pipe', 'pipe'],
    });

    let buffer = Buffer.alloc(0);
    let nextId = 1;
    const pending = new Map();
    const notifications = [];

    proc.stdout.on('data', (chunk) => {
        buffer = Buffer.concat([buffer, chunk]);
        while (true) {
            const headerEnd = buffer.indexOf('\r\n\r\n');
            if (headerEnd === -1) break;
            const headerStr = buffer.slice(0, headerEnd).toString('utf8');
            const m = headerStr.match(/Content-Length:\s*(\d+)/i);
            if (!m) {
                throw new Error('Malformed LSP header: ' + headerStr);
            }
            const len = parseInt(m[1], 10);
            const totalLen = headerEnd + 4 + len;
            if (buffer.length < totalLen) break;

            const bodyStr = buffer.slice(headerEnd + 4, totalLen).toString('utf8');
            buffer = buffer.slice(totalLen);
            const msg = JSON.parse(bodyStr);

            if (msg.id !== undefined && msg.method !== undefined) {
                // Server -> client request (e.g. workspace/configuration)
                if (msg.method === 'workspace/configuration') {
                    const items = (msg.params && msg.params.items) || [];
                    const results = items.map((item) => {
                        if (item.section === 'ca65') {
                            return {
                                enableCa65StdErrDiagnostics: false,
                                enableUnusedSymbolDiagnostics: true,
                                includeDirs: ['**/include'],
                                binIncludeDirs: [],
                                autoIncludeExtensions: ['.inc', '.s'],
                                anonymousLabelIndexHints: false,
                                importFromHints: true,
                                additionalExtensions: [],
                                smartFolding: true,
                                implicitImports: false,
                                lineContinuations: false,
                                enableStatusBarCycleCount: true,
                            };
                        }
                        if (item.section === 'files') {
                            return { associations: {} };
                        }
                        return {};
                    });
                    sendMessage({ jsonrpc: '2.0', id: msg.id, result: results });
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
            } else {
                notifications.push(msg);
            }
        }
    });

    function sendMessage(obj) {
        const json = JSON.stringify(obj);
        const payload = `Content-Length: ${Buffer.byteLength(json, 'utf8')}\r\n\r\n${json}`;
        proc.stdin.write(payload, 'utf8');
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
        try {
            await request('shutdown', null);
            notify('exit', null);
        } catch {}
        proc.kill();
    }

    return { request, notify, notifications, close, proc };
}

(async () => {
    const tmpRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'ca65-test-'));
    const incDir = path.join(tmpRoot, 'include');
    fs.mkdirSync(incDir, { recursive: true });

    const defsIncPath = path.join(incDir, 'defs.inc');
    const exportsSPath = path.join(tmpRoot, 'exports.s');
    const helperAsmPath = path.join(tmpRoot, 'helper.asm');
    const mainSPath = path.join(tmpRoot, 'main.s');

    const defsIncContent = [
        'INC_CONST = $42',
    ].join('\n');

    const exportsSContent = [
        '.zeropage',
        'zp_shared: .res 1',
        '.exportzp zp_shared',
        '.code',
        '.proc exported_fn',
        '    rts',
        '.endproc',
        '.export exported_fn',
    ].join('\n');

    const helperAsmContent = [
        '.code',
        '.proc unexported_helper',
        '    nop',
        '    rts',
        '.endproc',
        '.segment "DIRECTPAGE"',
        'dp_unexported: .res 1',
    ].join('\n');

    const mainSContent = [
        '.segment "ZEROPAGE"',
        'zp_var: .res 1',
        'ZP_C = $10',
        'ABS_C = $2000',
        '.importzp ext_zp',
        '.import ext_unknown',
        '.code',
        '.proc test_ops',
        '    clc',
        '    asl a',
        '    lda #$1A',
        '    lda zp_var',
        '    lda ZP_C + 2',
        '    lda ABS_C',
        '    lda a:zp_var',
        '    lda (zp_var, x)',
        '    lda (zp_var), y',
        '    lda ABS_C, x',
        '    bne done',
        '    jmp ($FFFC)',
        '    lda ext_zp',
        '    lda ext_unknown',
        'done:',
        '    rts',
        '.endproc',
        '',
        'inline_unused: lda #42 ; comment 99',
        'unused_val = %00001111',
        '    jsr zp_shared',
        '    lda #INC_CONST',
        '    jsr unexported_helper',
        'msg: .byte "123"',
        '    lda dp_unexported',
        '.segment "DP"',
        'dp_unused: .res 1',
    ].join('\n');

    fs.writeFileSync(defsIncPath, defsIncContent);
    fs.writeFileSync(exportsSPath, exportsSContent);
    fs.writeFileSync(helperAsmPath, helperAsmContent);
    fs.writeFileSync(mainSPath, mainSContent);

    const workspaceUri = pathToFileURL(tmpRoot).toString();
    const mainUri = pathToFileURL(mainSPath).toString();

    const client = makeLspClient(tmpRoot);
    try {
        const initRes = await client.request('initialize', {
            processId: process.pid,
            rootUri: workspaceUri,
            workspaceFolders: [{ uri: workspaceUri, name: 'ws' }],
            capabilities: {},
        });
        assert(initRes.capabilities.codeActionProvider, 'codeActionProvider must be registered');

        client.notify('initialized', {});
        client.notify('textDocument/didOpen', {
            textDocument: { uri: mainUri, languageId: 'ca65', version: 1, text: mainSContent },
        });

        // Wait a moment for initialization & indexing
        await new Promise(r => setTimeout(r, 300));

        // --- Test 1: Cycle & Byte Estimator ---
        const lineExpectations = [
            { line: 8,  mnemonic: 'CLC', mode: 'Implied',       minB: 1, maxB: 1, minC: 2, maxC: 2 },
            { line: 9,  mnemonic: 'ASL', mode: 'Accumulator',   minB: 1, maxB: 1, minC: 2, maxC: 2 },
            { line: 10, mnemonic: 'LDA', mode: 'Immediate',     minB: 2, maxB: 2, minC: 2, maxC: 2 },
            { line: 11, mnemonic: 'LDA', mode: 'Zero Page',     minB: 2, maxB: 2, minC: 3, maxC: 3 },
            { line: 12, mnemonic: 'LDA', mode: 'Zero Page',     minB: 2, maxB: 2, minC: 3, maxC: 3 },
            { line: 13, mnemonic: 'LDA', mode: 'Absolute',      minB: 3, maxB: 3, minC: 4, maxC: 4 },
            { line: 14, mnemonic: 'LDA', mode: 'Absolute',      minB: 3, maxB: 3, minC: 4, maxC: 4 },
            { line: 15, mnemonic: 'LDA', mode: '(Indirect, X)', minB: 2, maxB: 2, minC: 6, maxC: 6 },
            { line: 16, mnemonic: 'LDA', mode: '(Indirect), Y', minB: 2, maxB: 2, minC: 5, maxC: 6 },
            { line: 17, mnemonic: 'LDA', mode: 'Absolute, X',   minB: 3, maxB: 3, minC: 4, maxC: 5 },
            { line: 18, mnemonic: 'BNE', mode: 'Relative',      minB: 2, maxB: 2, minC: 2, maxC: 4 },
            { line: 19, mnemonic: 'JMP', mode: 'Indirect',      minB: 3, maxB: 3, minC: 5, maxC: 5 },
            { line: 20, mnemonic: 'LDA', mode: 'Zero Page',     minB: 2, maxB: 2, minC: 3, maxC: 3 },
            { line: 21, mnemonic: 'LDA', mode: 'Zero Page / Absolute', minB: 2, maxB: 3, minC: 3, maxC: 4, uncertain: true },
            { line: 23, mnemonic: 'RTS', mode: 'Implied',       minB: 1, maxB: 1, minC: 6, maxC: 6 },
        ];

        for (const exp of lineExpectations) {
            const res = await client.request('ca65/analyzeSelection', {
                uri: mainUri,
                range: { start: { line: exp.line, character: 0 }, end: { line: exp.line, character: 40 } },
            });
            assert.strictEqual(res.instructionCount, 1, `Line ${exp.line} should yield 1 item`);
            const item = res.items[0];
            assert.strictEqual(item.mnemonic, exp.mnemonic, `Line ${exp.line} mnemonic`);
            assert.strictEqual(item.mode, exp.mode, `Line ${exp.line} mode`);
            assert.strictEqual(res.minBytes, exp.minB, `Line ${exp.line} minBytes`);
            assert.strictEqual(res.maxBytes, exp.maxB, `Line ${exp.line} maxBytes`);
            assert.strictEqual(res.minCycles, exp.minC, `Line ${exp.line} minCycles`);
            assert.strictEqual(res.maxCycles, exp.maxC, `Line ${exp.line} maxCycles`);
            assert.strictEqual(Boolean(item.uncertainMode), Boolean(exp.uncertain), `Line ${exp.line} uncertain`);
        }

        // Test Shift+Down end at char 0 exclusion (lines 8..10 with end=(10,0) => lines 8 and 9 only)
        const multiRes = await client.request('ca65/analyzeSelection', {
            uri: mainUri,
            range: { start: { line: 8, character: 0 }, end: { line: 10, character: 0 } },
        });
        assert.strictEqual(multiRes.instructionCount, 2, 'End at col 0 excludes trailing line');
        assert.strictEqual(multiRes.minBytes, 2);
        assert.strictEqual(multiRes.minCycles, 4);

        // --- Test 2: Code Actions - Unresolved symbols ---
        // Line 28: `    jsr zp_shared` -> exported via .exportzp in exports.s
        const caZpImport = await client.request('textDocument/codeAction', {
            textDocument: { uri: mainUri },
            range: { start: { line: 28, character: 10 }, end: { line: 28, character: 10 } },
            context: {
                diagnostics: [{
                    source: 'ca65',
                    severity: 1,
                    range: { start: { line: 28, character: 8 }, end: { line: 28, character: 17 } },
                    message: "Symbol ‘zp_shared’ is undefined",
                }],
            },
        });
        assert(caZpImport.some(a => a.title.includes(".importzp") && a.title.includes("zp_shared")),
            'Expected .importzp quick fix for zp_shared: ' + JSON.stringify(caZpImport.map(a => a.title)));

        // Line 29: `    lda #INC_CONST` -> in include/defs.inc
        const caInc = await client.request('textDocument/codeAction', {
            textDocument: { uri: mainUri },
            range: { start: { line: 29, character: 12 }, end: { line: 29, character: 12 } },
            context: {
                diagnostics: [{
                    source: 'ca65',
                    severity: 1,
                    range: { start: { line: 29, character: 9 }, end: { line: 29, character: 18 } },
                    message: "Symbol 'INC_CONST' is undefined",
                }],
            },
        });
        assert(caInc.some(a => a.title.includes('Include "defs.inc"')),
            'Expected .include quick fix for INC_CONST: ' + JSON.stringify(caInc.map(a => a.title)));

        // Line 30: `    jsr unexported_helper` -> defined in helper.asm (not auto-includable) without .export
        const caHelper = await client.request('textDocument/codeAction', {
            textDocument: { uri: mainUri },
            range: { start: { line: 30, character: 12 }, end: { line: 30, character: 12 } },
            context: { diagnostics: [] },
        });
        const exportAndImport = caHelper.find(a => a.title.includes("Export 'unexported_helper'") && a.title.includes('import here'));
        assert(exportAndImport, 'Expected multi-file export+import quick fix: ' + JSON.stringify(caHelper.map(a => a.title)));
        assert(exportAndImport.edit.changes[pathToFileURL(helperAsmPath).toString()], 'Edit targets helper.asm');
        assert(exportAndImport.edit.changes[mainUri], 'Edit targets main.s');

        // Line 32: `    lda dp_unexported` -> DIRECTPAGE symbol in helper.asm without .export
        const caDpHelper = await client.request('textDocument/codeAction', {
            textDocument: { uri: mainUri },
            range: { start: { line: 32, character: 10 }, end: { line: 32, character: 10 } },
            context: { diagnostics: [] },
        });
        const exportAndImportDp = caDpHelper.find(a => a.title.includes("Export 'dp_unexported'") && a.title.includes('import here'));
        assert(exportAndImportDp, 'Expected multi-file export+import quick fix for DIRECTPAGE symbol');
        const helperDpEdit = exportAndImportDp.edit.changes[pathToFileURL(helperAsmPath).toString()][0];
        const mainDpEdit = exportAndImportDp.edit.changes[mainUri][0];
        assert(helperDpEdit.newText.includes('.exportzp dp_unexported'), `Expected .exportzp for DIRECTPAGE symbol, got ${helperDpEdit.newText}`);
        assert(mainDpEdit.newText.includes('.importzp dp_unexported'), `Expected .importzp for DIRECTPAGE symbol, got ${mainDpEdit.newText}`);

        // Line 34: `dp_unused: .res 1` in `.segment "DP"` -> Export (.exportzp) quick fix
        const caUnusedDp = await client.request('textDocument/codeAction', {
            textDocument: { uri: mainUri },
            range: { start: { line: 34, character: 2 }, end: { line: 34, character: 2 } },
            context: {
                diagnostics: [{
                    source: 'ca65-lsp',
                    severity: 4,
                    range: { start: { line: 34, character: 0 }, end: { line: 34, character: 9 } },
                    message: "Symbol 'dp_unused' is defined but never used.",
                }],
            },
        });
        assert(
            caUnusedDp.some(a => a.title === "Export 'dp_unused' (.exportzp)"),
            'Expected Export (.exportzp) quick fix for DP symbol: ' + JSON.stringify(caUnusedDp.map(a => a.title))
        );

        // --- Test 3: Unused Symbol Quick Fixes ---
        // Line 26: `inline_unused: lda #42 ; comment 99`
        const caUnusedInline = await client.request('textDocument/codeAction', {
            textDocument: { uri: mainUri },
            range: { start: { line: 26, character: 2 }, end: { line: 26, character: 2 } },
            context: {
                diagnostics: [{
                    source: 'ca65-lsp',
                    severity: 4,
                    range: { start: { line: 26, character: 0 }, end: { line: 26, character: 13 } },
                    message: "Symbol 'inline_unused' is defined but never used.",
                }],
            },
        });
        const removeInline = caUnusedInline.find(a => a.title.startsWith('Remove unused'));
        assert(removeInline, 'Expected Remove unused quick fix');
        const inlineEdit = removeInline.edit.changes[mainUri][0];
        assert.deepStrictEqual(inlineEdit.range, { start: { line: 26, character: 0 }, end: { line: 26, character: 15 } },
            'Inline label removal should preserve `lda #42`');
        assert(caUnusedInline.some(a => a.title.includes("Export 'inline_unused'")),
            'Expected Export quick fix for unused root symbol');

        // --- Test 4: Number Base Conversion ---
        // Line 10: `    lda #$1A` ($1A at chars 9..12)
        const caHex = await client.request('textDocument/codeAction', {
            textDocument: { uri: mainUri },
            range: { start: { line: 10, character: 10 }, end: { line: 10, character: 10 } },
            context: { diagnostics: [] },
        });
        assert(caHex.some(a => a.title === 'Convert to decimal (26)'), 'Hex -> Dec');
        assert(caHex.some(a => a.title === 'Convert to binary (%00011010)'), 'Hex -> Bin');

        // Line 26: `42` is code decimal; `99` is inside `; comment 99`
        const caDecCode = await client.request('textDocument/codeAction', {
            textDocument: { uri: mainUri },
            range: { start: { line: 26, character: 20 }, end: { line: 26, character: 20 } },
            context: { diagnostics: [] },
        });
        assert(caDecCode.some(a => a.title === 'Convert to hex ($2A)'), 'Dec -> Hex');

        const caDecComment = await client.request('textDocument/codeAction', {
            textDocument: { uri: mainUri },
            range: { start: { line: 26, character: 34 }, end: { line: 26, character: 34 } },
            context: { diagnostics: [] },
        });
        assert(!caDecComment.some(a => a.title.startsWith('Convert to')), 'Should not convert numbers in comments');

        // Line 31: `msg: .byte "123"` -> inside string
        const caStrNum = await client.request('textDocument/codeAction', {
            textDocument: { uri: mainUri },
            range: { start: { line: 31, character: 13 }, end: { line: 31, character: 13 } },
            context: { diagnostics: [] },
        });
        assert(!caStrNum.some(a => a.title.startsWith('Convert to')), 'Should not convert numbers inside strings');

        console.log('ALL E2E CHECKS PASSED!');
    } finally {
        await client.close();
        fs.rmSync(tmpRoot, { recursive: true, force: true });
    }
})().catch((err) => {
    console.error(err);
    process.exit(1);
});
