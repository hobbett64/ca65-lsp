const assert = require('assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { spawn } = require('child_process');
const { pathToFileURL } = require('url');

const serverEntry = path.resolve(process.cwd(), 'server/out/server.js');

(async () => {
    const tmpRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'ca65-mac-'));
    const macPath = path.join(tmpRoot, 'macros.inc');
    const mainPath = path.join(tmpRoot, 'main.s');

    const macText = [
        '; Copies count bytes from src to dst',
        '.macro MEMCOPY dst, src, count',
        '  nop',
        '.endmacro',
        '; Computes linear offset',
        '.define OFFSET(row, col) (((row) * 32) + (col))',
        '.define CONST_OBJ (1 + 2)',
    ].join('\n') + '\n';

    const mainText = [
        '.include "macros.inc"',
        '.code',
        '  MEMCOPY $0200, ',
        '  MEMCOPY $0200, OFFSET(4, ',
        '  MEMCOPY $0200, OFFSET(4, 2), ',
        '  lda #CONST_OBJ',
        '  lda #$00 ; MEMCOPY comment_arg, ',
    ].join('\n') + '\n';

    fs.writeFileSync(macPath, macText);
    fs.writeFileSync(mainPath, mainText);

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
            const len = parseInt(m[1], 10);
            const totalLen = headerEnd + 4 + len;
            if (buffer.length < totalLen) break;
            const msg = JSON.parse(buffer.slice(headerEnd + 4, totalLen).toString('utf8'));
            buffer = buffer.slice(totalLen);

            if (msg.id !== undefined && msg.method !== undefined) {
                if (msg.method === 'workspace/configuration') {
                    const items = (msg.params && msg.params.items) || [];
                    sendMessage({
                        jsonrpc: '2.0',
                        id: msg.id,
                        result: items.map(i => i.section === 'ca65' ? {
                            enableStderrDiagnostics: false,
                            enableUnusedSymbolDiagnostics: false,
                            autoIncludeExtensions: ['.inc'],
                            anonymousLabelIndexHints: false,
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

    try {
        const wsUri = pathToFileURL(tmpRoot).toString();
        const macUri = pathToFileURL(macPath).toString();
        const mainUri = pathToFileURL(mainPath).toString();

        const initResult = await request('initialize', {
            processId: process.pid,
            rootUri: wsUri,
            workspaceFolders: [{ uri: wsUri, name: 'ws' }],
            capabilities: {},
        });
        assert(initResult.capabilities.signatureHelpProvider, 'signatureHelpProvider capability should be advertised');

        notify('initialized', {});
        notify('textDocument/didOpen', { textDocument: { uri: macUri, languageId: 'ca65', version: 1, text: macText } });
        notify('textDocument/didOpen', { textDocument: { uri: mainUri, languageId: 'ca65', version: 1, text: mainText } });
        await new Promise(r => setTimeout(r, 300));

        const lines = mainText.split('\n');

        // 1. Macro 2nd param (`MEMCOPY $0200, `)
        const sig1 = await request('textDocument/signatureHelp', {
            textDocument: { uri: mainUri },
            position: { line: 2, character: lines[2].length },
        });
        assert(sig1 && sig1.signatures.length === 1);
        assert.strictEqual(sig1.signatures[0].label, 'MEMCOPY dst, src, count');
        assert.strictEqual(sig1.activeParameter, 1);
        assert(sig1.signatures[0].documentation.value.includes('Copies count bytes'));
        assert.deepStrictEqual(sig1.signatures[0].parameters.map(p => p.label), [[8, 11], [13, 16], [18, 23]]);

        // 2. Nested .define inside macro arg (`MEMCOPY $0200, OFFSET(4, `)
        const sig2 = await request('textDocument/signatureHelp', {
            textDocument: { uri: mainUri },
            position: { line: 3, character: lines[3].length },
        });
        assert(sig2 && sig2.signatures[0].label === 'OFFSET(row, col)');
        assert.strictEqual(sig2.activeParameter, 1);
        assert(sig2.signatures[0].documentation.value.includes('Computes linear offset'));

        // 3. After closing OFFSET(4, 2), back to MEMCOPY 3rd param (`MEMCOPY $0200, OFFSET(4, 2), `)
        const sig3 = await request('textDocument/signatureHelp', {
            textDocument: { uri: mainUri },
            position: { line: 4, character: lines[4].length },
        });
        assert(sig3 && sig3.signatures[0].label === 'MEMCOPY dst, src, count');
        assert.strictEqual(sig3.activeParameter, 2);

        // 4. Inside comment -> null
        const sigComment = await request('textDocument/signatureHelp', {
            textDocument: { uri: mainUri },
            position: { line: 6, character: lines[6].length },
        });
        assert.strictEqual(sigComment, null);

        // 5. Completion detail includes macro args
        const compCmd = await request('textDocument/completion', {
            textDocument: { uri: mainUri },
            position: { line: 2, character: 5 }, // `  MEM`
        });
        const items = Array.isArray(compCmd) ? compCmd : compCmd.items;
        const memItem = items.find(i => i.label === 'MEMCOPY');
        assert(memItem && memItem.detail === '.macro dst, src, count', 'Expected macro params in completion detail');

        const compVal = await request('textDocument/completion', {
            textDocument: { uri: mainUri },
            position: { line: 5, character: 9 }, // `  lda #CO`
        });
        const valItems = Array.isArray(compVal) ? compVal : compVal.items;
        const offItem = valItems.find(i => i.label === 'OFFSET');
        const objItem = valItems.find(i => i.label === 'CONST_OBJ');
        assert(offItem && offItem.detail === '.define (row, col)', 'Expected .define params in completion detail');
        assert(objItem && objItem.detail === 'define', 'Object-like .define with space before ( should not treat expr as params');

        console.log('MACRO SIGNATURE HELP & COMPLETION CHECKS PASSED!');
    } finally {
        try { await request('shutdown', null); notify('exit', null); } catch {}
        proc.kill();
        fs.rmSync(tmpRoot, { recursive: true, force: true });
    }
})().catch((err) => {
    console.error(err);
    process.exit(1);
});
