const assert = require('assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { spawn } = require('child_process');
const { pathToFileURL } = require('url');

const serverEntry = path.resolve(process.cwd(), 'server/out/server.js');

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
                            enableCa65StdErrDiagnostics: false,
                            enableUnusedSymbolDiagnostics: false,
                            includeDirs: ['**/include'],
                            binIncludeDirs: [],
                            autoIncludeExtensions: ['.inc', '.s'],
                            anonymousLabelIndexHints: false,
                            importFromHints: true,
                            additionalExtensions: [],
                            smartFolding: true,
                            implicitImports: false,
                            lineContinuations: true,
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
    const tmpRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'ca65-scan-'));
    const defsPath = path.join(tmpRoot, 'defs.inc');
    const mainPath = path.join(tmpRoot, 'main.s');

    const defsText = [
        '.export EXP_VAL = 42',
        '.struct Vec2',
        '  x .byte',
        '  y .byte',
        '.endstruct',
        '.enum Color',
        '  Red',
        '  Blue',
        '.endenum',
        '.macro MY_MAC arg',
        '  lda arg',
        '.endmacro',
        '.define DOUBLE(v) ((v)*2)',
    ].join('\n') + '\n';

    const mainText = [
        '.include "defs.inc"',
        '.import helper',
        '.zeropage',
        'buf: .res 4',
        '.code',
        'CONST_A = 10',
        'VAR_B .set CONST_A + 1',
        '.scope Outer',
        '  .proc do_work',
        '    entity: .tag Vec2',
        '  :',
        '    lda #Color::Red',
        '    MY_MAC #DOUBLE(CONST_A)',
        '    bne :-',
        '    jsr helper',
        '    rts',
        '  .endproc',
        '.endscope',
        'tbl: .byte 1, 2, 3',
        'msg: .byte "hi"',
        'expr = CONST_A + \\',
        '  VAR_B',
    ].join('\n') + '\n';

    fs.writeFileSync(defsPath, defsText);
    fs.writeFileSync(mainPath, mainText);

    const wsUri = pathToFileURL(tmpRoot).toString();
    const defsUri = pathToFileURL(defsPath).toString();
    const mainUri = pathToFileURL(mainPath).toString();

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
        await new Promise(r => setTimeout(r, 300));

        // Document symbols: Outer -> do_work -> entity, plus CONST_A, VAR_B, tbl, msg, expr
        const syms = await client.request('textDocument/documentSymbol', { textDocument: { uri: mainUri } });
        const symNames = syms.map(s => s.name);
        assert(symNames.includes('Outer'), 'Expected Outer scope');
        assert(symNames.includes('CONST_A'), 'Expected CONST_A');
        assert(symNames.includes('VAR_B'), 'Expected VAR_B');
        assert(symNames.includes('tbl'), 'Expected tbl');
        assert(symNames.includes('msg'), 'Expected msg');
        assert(symNames.includes('expr'), 'Expected expr');

        // Go-to-definition from `Vec2` in `entity: .tag Vec2` (line 9) -> Vec2 in defs.inc (line 1)
        const tagLine = mainText.split('\n')[9];
        const vecCol = tagLine.indexOf('Vec2');
        const vecDef = await client.request('textDocument/definition', {
            textDocument: { uri: mainUri },
            position: { line: 9, character: vecCol },
        });
        assert(vecDef && (Array.isArray(vecDef) ? vecDef.length > 0 : vecDef.uri === defsUri), 'Vec2 .tag should resolve to defs.inc');

        // Go-to-definition on `Red` in `Color::Red` (line 11) -> Color.Red in defs.inc
        const colorLine = mainText.split('\n')[11];
        const redCol = colorLine.indexOf('Red');
        const redDef = await client.request('textDocument/definition', {
            textDocument: { uri: mainUri },
            position: { line: 11, character: redCol },
        });
        assert(redDef && (Array.isArray(redDef) ? redDef.length > 0 : redDef.uri === defsUri), 'Color::Red should resolve to defs.inc');

        // Go-to-definition on anonymous `bne :-` (line 13) -> `:` at line 10
        const bneLine = mainText.split('\n')[13];
        const anonCol = bneLine.indexOf(':-');
        const anonDef = await client.request('textDocument/definition', {
            textDocument: { uri: mainUri },
            position: { line: 13, character: anonCol },
        });
        const anonLoc = Array.isArray(anonDef) ? anonDef[0] : anonDef;
        assert(anonLoc && anonLoc.range.start.line === 10, 'Anonymous :- should jump to line 10');

        // References on CONST_A (definition line 5) should include line 5, line 6, line 12, and line 20
        const constRefs = await client.request('textDocument/references', {
            textDocument: { uri: mainUri },
            position: { line: 5, character: 1 },
            context: { includeDeclaration: true },
        });
        const refLines = new Set(constRefs.map(r => r.range.start.line));
        assert(refLines.has(5) && refLines.has(6) && refLines.has(12) && refLines.has(20), 'Expected CONST_A refs on lines 5, 6, 12, 20');

        console.log('ALL DOCUMENT SCANNER REGRESSION CHECKS PASSED!');
    } finally {
        await client.close();
        fs.rmSync(tmpRoot, { recursive: true, force: true });
    }
})().catch((err) => {
    console.error(err);
    process.exit(1);
});
