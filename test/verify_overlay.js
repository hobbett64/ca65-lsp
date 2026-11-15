const assert = require('assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { spawn } = require('child_process');
const { pathToFileURL } = require('url');

const serverEntry = path.resolve(process.cwd(), 'server/out/server.js');

function makeLspClient(extraSettings = {}) {
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
                    const results = items.map((item) => {
                        if (item.section === 'ca65') {
                            return {
                                enableCa65StdErrDiagnostics: true,
                                enableUnusedSymbolDiagnostics: false,
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
                                ...extraSettings,
                            };
                        }
                        if (item.section === 'files') return { associations: {} };
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
        try {
            await request('shutdown', null);
            notify('exit', null);
        } catch {}
        proc.kill();
    }

    return { request, notify, close };
}

(async () => {
    const tmpRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'ca65-lst-only-'));
    const incPath = path.join(tmpRoot, 'inc.inc');
    const mainPath = path.join(tmpRoot, 'main.s');
    const badPath = path.join(tmpRoot, 'bad.s');

    const incText = [
        'ZP_FOO = $12',
        '.byte $AA, $BB',
    ].join('\n') + '\n';

    const mainText = [
        '.include "inc.inc"',
        '.import sub_fn',
        '.zeropage',
        'zp_v: .res 2',
        '.code',
        'start:',
        '  lda zp_v',
        '  jsr sub_fn',
        '  .byte 1,2,3,4,5,6,7,8',
        '  rts',
    ].join('\n') + '\n';

    const badText = [
        '.code',
        '  lda NO_SUCH_SYMBOL_EVER',
    ].join('\n') + '\n';

    fs.writeFileSync(incPath, incText);
    fs.writeFileSync(mainPath, mainText);
    fs.writeFileSync(badPath, badText);

    const wsUri = pathToFileURL(tmpRoot).toString();
    const mainUri = pathToFileURL(mainPath).toString();
    const incUri = pathToFileURL(incPath).toString();
    const badUri = pathToFileURL(badPath).toString();

    const client = makeLspClient();
    try {
        await client.request('initialize', {
            processId: process.pid,
            rootUri: wsUri,
            workspaceFolders: [{ uri: wsUri, name: 'ws' }],
            capabilities: {},
        });
        client.notify('initialized', {});
        client.notify('textDocument/didOpen', {
            textDocument: { uri: mainUri, languageId: 'ca65', version: 1, text: mainText },
        });
        client.notify('textDocument/didOpen', {
            textDocument: { uri: incUri, languageId: 'ca65', version: 1, text: incText },
        });
        client.notify('textDocument/didOpen', {
            textDocument: { uri: badUri, languageId: 'ca65', version: 1, text: badText },
        });
        await new Promise(r => setTimeout(r, 300));

        // 1. Valid ca65 -l listing on main.s
        const lst1 = await client.request('ca65/getOverlayData', { uri: mainUri });
        assert.strictEqual(lst1.source, 'live-lst');
        assert.strictEqual(lst1.stale, false);
        assert(!lst1.error);
        const byLine1 = new Map(lst1.lines.map(l => [l.line, l]));

        assert.strictEqual(byLine1.get(3).bytesText, 'res 2B');
        assert.strictEqual(byLine1.get(3).byteCount, 2);
        assert.strictEqual(byLine1.get(6).byteCount, 2);
        assert.strictEqual(byLine1.get(7).bytesText, '20 rr rr');
        assert.strictEqual(byLine1.get(8).bytesText, '01 02 03 04 05 06 07 08');
        assert.strictEqual(byLine1.get(8).byteCount, 8);
        assert.strictEqual(byLine1.get(9).bytesText, '60');

        // 2. Depth-2 included file inc.inc from cache
        const incLst = await client.request('ca65/getOverlayData', { uri: incUri });
        assert.strictEqual(incLst.source, 'live-lst');
        assert.strictEqual(incLst.stale, false);
        const incByLine = new Map(incLst.lines.map(l => [l.line, l]));
        assert.strictEqual(incByLine.get(1).bytesText, 'AA BB');

        // 3. Introduce assembly error -> keep last valid lines, marked stale & error
        const brokenMainText = mainText.replace('  rts\n', '  lda NONEXISTENT_LABEL\n');
        client.notify('textDocument/didChange', {
            textDocument: { uri: mainUri, version: 2 },
            contentChanges: [{ text: brokenMainText }],
        });
        await new Promise(r => setTimeout(r, 150));

        const errLst = await client.request('ca65/getOverlayData', { uri: mainUri });
        assert.strictEqual(errLst.source, 'live-lst', 'Should preserve last valid listing on error');
        assert.strictEqual(errLst.stale, true, 'Listing should be marked stale when error occurs');
        assert.strictEqual(errLst.error, true, 'Error flag should be set');
        const byLineErr = new Map(errLst.lines.map(l => [l.line, l]));
        assert.strictEqual(byLineErr.get(9).bytesText, '60', 'Preserved last valid line bytes');

        // 4. Fix error -> updates and clears stale/error
        const fixedMainText = mainText.replace('  rts\n', '  nop\n  rts\n');
        client.notify('textDocument/didChange', {
            textDocument: { uri: mainUri, version: 3 },
            contentChanges: [{ text: fixedMainText }],
        });
        await new Promise(r => setTimeout(r, 150));

        const fixedLst = await client.request('ca65/getOverlayData', { uri: mainUri });
        assert.strictEqual(fixedLst.source, 'live-lst');
        assert.strictEqual(fixedLst.stale, false);
        assert(!fixedLst.error);
        const byLineFixed = new Map(fixedLst.lines.map(l => [l.line, l]));
        assert.strictEqual(byLineFixed.get(9).bytesText, 'EA');
        assert.strictEqual(byLineFixed.get(10).bytesText, '60');

        // 5. File with error and no prior valid listing -> source: 'none', error: true
        const badLst = await client.request('ca65/getOverlayData', { uri: badUri });
        assert.strictEqual(badLst.source, 'none');
        assert.strictEqual(badLst.error, true);
        assert.deepStrictEqual(badLst.lines, []);

        console.log('ALL OVERLAY E2E CHECKS PASSED!');
    } finally {
        await client.close();
        fs.rmSync(tmpRoot, { recursive: true, force: true });
    }
})().catch((err) => {
    console.error(err);
    process.exit(1);
});
