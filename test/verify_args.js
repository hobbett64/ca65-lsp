const assert = require('assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { spawn } = require('child_process');
const { pathToFileURL } = require('url');

const serverEntry = path.resolve(process.cwd(), 'server/out/server.js');

(async () => {
    const tmpRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'ca65-args-'));
    const srcPath = path.join(tmpRoot, 'test.s');
    const srcText = '.code\n  lda #TEST_VAL\n  rts\n';
    fs.writeFileSync(srcPath, srcText);

    const proc = spawn(process.execPath, [serverEntry, '--stdio'], {
        cwd: process.cwd(),
        stdio: ['pipe', 'pipe', 'pipe'],
    });
    let buffer = Buffer.alloc(0);
    let nextId = 1;
    const pending = new Map();
    const diagnostics = [];

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
                            enableStderrDiagnostics: true,
                            enableUnusedSymbolDiagnostics: false,
                            fileExtensions: ['.s', '.asm', '.inc'],
                            includeDirs: ['**/include'],
                            binIncludeDirs: [],
                            autoIncludeExtensions: ['.inc'],
                            anonymousLabelIndexHints: false,
                            importFromHints: true,
                            smartFolding: true,
                            implicitImports: false,
                            enableStatusBarCycleCount: true,
                            additionalArgs: ['-D', 'TEST_VAL=$2A', '-o', 'should_be_ignored.o', '-l', 'should_be_ignored.lst', '--create-dep', 'should_be_ignored.d'],
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
            } else if (msg.method === 'textDocument/publishDiagnostics') {
                diagnostics.push(msg.params);
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
        const srcUri = pathToFileURL(srcPath).toString();
        await request('initialize', {
            processId: process.pid,
            rootUri: wsUri,
            workspaceFolders: [{ uri: wsUri, name: 'ws' }],
            capabilities: {},
        });
        notify('initialized', {});
        notify('textDocument/didOpen', {
            textDocument: { uri: srcUri, languageId: 'ca65', version: 1, text: srcText },
        });
        await new Promise(r => setTimeout(r, 700));

        const latest = diagnostics.filter(d => d.uri === srcUri).pop();
        assert(latest && latest.diagnostics.length === 0, 'Expected 0 diagnostics when -D TEST_VAL=$2A is passed');

        const ovl = await request('ca65/getOverlayData', { uri: srcUri });
        assert.strictEqual(ovl.source, 'live-lst');
        const byLine = new Map(ovl.lines.map(l => [l.line, l]));
        assert.strictEqual(byLine.get(1).bytesText, 'A9 2A', 'Expected lda #TEST_VAL -> A9 2A');
        assert(!fs.existsSync(path.join(tmpRoot, 'should_be_ignored.o')), '-o flag should be ignored');
        assert(!fs.existsSync(path.join(tmpRoot, 'should_be_ignored.lst')), '-l flag should be ignored');
        assert(!fs.existsSync(path.join(tmpRoot, 'should_be_ignored.d')), '--create-dep flag should be ignored');

        console.log('ADDITIONAL ARGS E2E CHECK PASSED!');
    } finally {
        try { await request('shutdown', null); notify('exit', null); } catch {}
        proc.kill();
        fs.rmSync(tmpRoot, { recursive: true, force: true });
    }
})().catch((err) => {
    console.error(err);
    process.exit(1);
});
