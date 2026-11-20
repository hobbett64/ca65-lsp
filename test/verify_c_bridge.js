// End-to-end checks for the ca65 <-> C bridge requests (ca65/globalSymbolAt, ca65/lookupGlobal,
// ca65/globalReferences, ca65/renameGlobal) used by the client's clangd integration.
const assert = require('assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { spawn } = require('child_process');
const { pathToFileURL } = require('url');

const serverEntry = path.resolve(process.cwd(), 'server/out/server.js');

(async () => {
    const tmpRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'ca65-cbridge-'));
    const drawPath = path.join(tmpRoot, 'draw.s');
    const mainPath = path.join(tmpRoot, 'main.s');
    const otherPath = path.join(tmpRoot, 'other.s');

    const drawText = [
        '.export _draw',
        '.import _counter',
        '',
        '/** Draws the thing. See {_draw}. */',
        '.proc _draw',
        '  lda _counter',
        '  jsr helper',
        '  rts',
        '.endproc',
        '',
        '.proc helper',
        '  rts',
        '.endproc',
    ].join('\n') + '\n';

    const mainText = [
        '.import _draw',
        '.import _counter',
        '',
        'start:',
        '  jsr _draw',
        '  inc _counter',
        '  rts',
    ].join('\n') + '\n';

    // A scoped import of the same name must not be treated as the global one.
    const otherText = [
        '.global _draw',
        'loop:',
        '  jsr _draw',
        '  jmp loop',
    ].join('\n') + '\n';

    fs.writeFileSync(drawPath, drawText);
    fs.writeFileSync(mainPath, mainText);
    fs.writeFileSync(otherPath, otherText);

    const proc = spawn(process.execPath, [serverEntry, '--stdio'], {
        cwd: process.cwd(),
        stdio: ['pipe', 'pipe', 'pipe'],
    });

    let buffer = Buffer.alloc(0);
    let nextId = 1;
    const pending = new Map();
    const diagnosticUris = new Set();
    const ca65ClientConfig = {
        enableStderrDiagnostics: false,
        enableUnusedSymbolDiagnostics: false,
        includeDirs: [],
        binIncludeDirs: [],
        fileExtensions: ['.s', '.asm', '.inc'],
    };

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
                        result: items.map(i => i.section === 'ca65' ? ca65ClientConfig : { associations: {} }),
                    });
                } else {
                    sendMessage({ jsonrpc: '2.0', id: msg.id, result: null });
                }
            } else if (msg.method === 'textDocument/publishDiagnostics') {
                diagnosticUris.add(msg.params.uri);
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
    const fmt = (locs) => JSON.stringify((locs || []).map(l => `${path.basename(l.uri)}:${l.range.start.line}:${l.range.start.character}`).sort());

    try {
        const wsUri = pathToFileURL(tmpRoot).toString();
        const drawUri = pathToFileURL(drawPath).toString();
        const mainUri = pathToFileURL(mainPath).toString();

        await request('initialize', {
            processId: process.pid,
            rootUri: wsUri,
            workspaceFolders: [{ uri: wsUri, name: 'ws' }],
            capabilities: {},
        });
        notify('initialized', {});
        notify('textDocument/didOpen', { textDocument: { uri: mainUri, languageId: 'ca65', version: 1, text: mainText } });

        const mainLines = mainText.split('\n');
        const drawLines = drawText.split('\n');

        // --- globalSymbolAt ---
        const atDrawCall = await request('ca65/globalSymbolAt', {
            uri: mainUri,
            position: { line: 4, character: mainLines[4].indexOf('_draw') + 1 },
        });
        assert.deepStrictEqual(atDrawCall, { name: '_draw', hasAsmDefinition: true }, `globalSymbolAt(_draw) = ${JSON.stringify(atDrawCall)}`);

        const atCounter = await request('ca65/globalSymbolAt', {
            uri: mainUri,
            position: { line: 5, character: mainLines[5].indexOf('_counter') + 1 },
        });
        assert.deepStrictEqual(atCounter, { name: '_counter', hasAsmDefinition: false }, `globalSymbolAt(_counter) = ${JSON.stringify(atCounter)}`);

        // On the definition itself (not a reference), e.g. Ctrl+click on `.proc _draw`.
        const atDefinition = await request('ca65/globalSymbolAt', {
            uri: drawUri,
            position: { line: 4, character: drawLines[4].indexOf('_draw') + 1 },
        });
        assert.deepStrictEqual(atDefinition, { name: '_draw', hasAsmDefinition: true }, `globalSymbolAt(.proc _draw) = ${JSON.stringify(atDefinition)}`);
        const atLocalDefinition = await request('ca65/globalSymbolAt', {
            uri: drawUri,
            position: { line: 10, character: drawLines[10].indexOf('helper') + 1 },
        });
        assert.strictEqual(atLocalDefinition, null, 'Non-exported definition should not be global');
        const atLabelDefinition = await request('ca65/globalSymbolAt', {
            uri: pathToFileURL(otherPath).toString(),
            position: { line: 1, character: 1 },
        });
        assert.strictEqual(atLabelDefinition, null, 'Non-exported label definition should not be global');

        const atLocal = await request('ca65/globalSymbolAt', {
            uri: drawUri,
            position: { line: 6, character: drawLines[6].indexOf('helper') + 1 },
        });
        assert.strictEqual(atLocal, null, `Non-exported symbol should not be global, got ${JSON.stringify(atLocal)}`);

        // --- lookupGlobal ---
        const drawInfo = await request('ca65/lookupGlobal', { name: '_draw' });
        assert(drawInfo, 'lookupGlobal(_draw) should resolve');
        assert.strictEqual(drawInfo.definitions.length, 1);
        assert.strictEqual(drawInfo.definitions[0].uri, drawUri);
        assert.strictEqual(drawInfo.definitions[0].range.start.line, 4);
        assert(drawInfo.imported, '_draw is imported by main.s');
        assert(drawInfo.hoverMarkdown && drawInfo.hoverMarkdown.includes('Draws the thing'), `Hover should include doc comment, got:\n${drawInfo.hoverMarkdown}`);

        const counterInfo = await request('ca65/lookupGlobal', { name: '_counter' });
        assert(counterInfo && counterInfo.definitions.length === 0 && counterInfo.imported, `lookupGlobal(_counter) = ${JSON.stringify(counterInfo)}`);

        assert.strictEqual(await request('ca65/lookupGlobal', { name: 'helper' }), null, 'Non-exported symbol has no global entry');
        assert.strictEqual(await request('ca65/lookupGlobal', { name: '_nope' }), null, 'Unknown symbol has no global entry');

        // --- globalReferences ---
        const drawRefs = await request('ca65/globalReferences', { name: '_draw' });
        const drawRefKeys = fmt(drawRefs);
        for (const expected of ['draw.s:0:8', 'draw.s:3:26', 'draw.s:4:6', 'main.s:0:8', 'main.s:4:6', 'other.s:0:8', 'other.s:2:6']) {
            assert(drawRefKeys.includes(expected), `Expected ${expected} in _draw refs, got ${drawRefKeys}`);
        }

        const counterRefs = await request('ca65/globalReferences', { name: '_counter' });
        const counterKeys = fmt(counterRefs);
        for (const expected of ['draw.s:1:8', 'draw.s:5:6', 'main.s:1:8', 'main.s:5:6']) {
            assert(counterKeys.includes(expected), `Expected ${expected} in _counter refs, got ${counterKeys}`);
        }

        // --- renameGlobal ---
        const rename = await request('ca65/renameGlobal', { name: '_counter', newName: '_score' });
        const renamed = [];
        for (const [uri, edits] of Object.entries(rename.changes)) {
            for (const e of edits) {
                assert.strictEqual(e.newText, '_score');
                renamed.push({ uri, range: e.range });
            }
        }
        assert.strictEqual(fmt(renamed), counterKeys, 'renameGlobal edits should cover every global reference');
        assert.strictEqual(await request('ca65/renameGlobal', { name: '_nope', newName: '_x' }), null);

        // --- Embedded inline-asm documents (built by the client from C sources) ---
        const hostPath = path.join(tmpRoot, 'game.c');
        const embeddedUri = `ca65-inline:${pathToFileURL(hostPath).pathname}.inline.s`;
        const embeddedText = [
            '',
            '    jsr _draw',
            '    lda _counter',
            '    jsr _c_only',
            'inline_label: nop',
        ].join('\n') + '\n';
        const embLines = embeddedText.split('\n');
        notify('textDocument/didOpen', { textDocument: { uri: embeddedUri, languageId: 'ca65', version: 1, text: embeddedText } });
        const embPos = (line, word) => ({ line, character: embLines[line].indexOf(word) + 1 });

        const embDef = await request('textDocument/definition', { textDocument: { uri: embeddedUri }, position: embPos(1, '_draw') });
        const embDefLocs = Array.isArray(embDef) ? embDef : [embDef];
        assert(embDefLocs.some(l => l.uri === drawUri && l.range.start.line === 4), `inline jsr _draw should resolve to draw.s without .import, got ${JSON.stringify(embDef)}`);

        const embHover = await request('textDocument/hover', { textDocument: { uri: embeddedUri }, position: embPos(1, '_draw') });
        assert(embHover && embHover.contents.value.includes('Draws the thing'), `inline hover should show the asm hovercard, got ${JSON.stringify(embHover)}`);
        const mnemonicHover = await request('textDocument/hover', { textDocument: { uri: embeddedUri }, position: embPos(2, 'lda') });
        assert(mnemonicHover && /LDA/i.test(mnemonicHover.contents.value), 'inline mnemonic hover should work');

        assert.deepStrictEqual(
            await request('ca65/globalSymbolAt', { uri: embeddedUri, position: embPos(2, '_counter') }),
            { name: '_counter', hasAsmDefinition: false }
        );
        assert.deepStrictEqual(
            await request('ca65/globalSymbolAt', { uri: embeddedUri, position: embPos(3, '_c_only') }),
            { name: '_c_only', hasAsmDefinition: false },
            'symbols used only from inline asm are implicitly imported'
        );

        const drawRefsWithInline = await request('ca65/globalReferences', { name: '_draw' });
        assert(drawRefsWithInline.some(l => l.uri === embeddedUri && l.range.start.line === 1), 'global references should include inline asm uses');
        notify('textDocument/didOpen', { textDocument: { uri: drawUri, languageId: 'ca65', version: 1, text: drawText } });
        const asmRefs = await request('textDocument/references', {
            textDocument: { uri: drawUri }, position: { line: 4, character: drawLines[4].indexOf('_draw') + 1 }, context: { includeDeclaration: true },
        });
        assert(asmRefs.some(l => l.uri === embeddedUri), `references from draw.s should include inline asm uses, got ${fmt(asmRefs)}`);
        const renameWithInline = await request('ca65/renameGlobal', { name: '_draw', newName: '_render' });
        assert(renameWithInline.changes[embeddedUri] && renameWithInline.changes[embeddedUri].length === 1, 'rename should edit inline asm uses');

        // C-defined symbols used only from inline asm (no `.import` anywhere) are still linked.
        const cOnlyInfo = await request('ca65/lookupGlobal', { name: '_c_only' });
        assert(cOnlyInfo && cOnlyInfo.imported && cOnlyInfo.definitions.length === 0, `lookupGlobal(_c_only) = ${JSON.stringify(cOnlyInfo)}`);
        const cOnlyRefs = await request('ca65/globalReferences', { name: '_c_only' });
        assert.deepStrictEqual(cOnlyRefs.map(l => `${l.uri === embeddedUri}:${l.range.start.line}`), ['true:3']);
        const counterRefsWithInline = await request('ca65/globalReferences', { name: '_counter' });
        assert(counterRefsWithInline.some(l => l.uri === embeddedUri && l.range.start.line === 2), 'inline uses of C-defined symbols are global references');
        const renameCounter = await request('ca65/renameGlobal', { name: '_counter', newName: '_score' });
        assert(renameCounter.changes[embeddedUri], 'renaming a C-defined symbol edits inline asm uses');

        const wsSymbols = await request('workspace/symbol', { query: 'inline_label' });
        assert(!wsSymbols.some(s => s.location.uri === embeddedUri), 'embedded documents are excluded from workspace symbols');

        await new Promise(r => setTimeout(r, 800));
        assert(!diagnosticUris.has(embeddedUri), 'embedded documents never get diagnostics');

        notify('textDocument/didClose', { textDocument: { uri: embeddedUri } });
        const drawRefsAfterClose = await request('ca65/globalReferences', { name: '_draw' });
        assert(!drawRefsAfterClose.some(l => l.uri === embeddedUri), 'closing the embedded document drops its references');

        // --- cc65 runtime imports are tagged in hovers ---
        const rtPath = path.join(tmpRoot, 'rt.s');
        const rtText = [
            '.import pusha, not_a_runtime_symbol',
            '.importzp sp',
            '  jsr pusha',
            '  lda sp',
            '  jsr not_a_runtime_symbol',
        ].join('\n') + '\n';
        fs.writeFileSync(rtPath, rtText);
        const rtUri = pathToFileURL(rtPath).toString();
        notify('textDocument/didOpen', { textDocument: { uri: rtUri, languageId: 'ca65', version: 1, text: rtText } });
        const rtLines = rtText.split('\n');
        const rtHover = async (line, word) => (await request('textDocument/hover', {
            textDocument: { uri: rtUri }, position: { line, character: rtLines[line].indexOf(word) + 1 },
        }))?.contents?.value || '';
        assert((await rtHover(2, 'pusha')).startsWith('cc65 runtime **pusha**'), `pusha hover: ${await rtHover(2, 'pusha')}`);
        assert((await rtHover(3, 'sp')).includes('cc65 runtime'), 'zero-page runtime symbols are tagged too');
        assert(!(await rtHover(4, 'not_a_runtime_symbol')).includes('cc65 runtime'), 'other unresolved imports are not tagged');
        // A workspace symbol that happens to share a runtime name resolves to the workspace definition.
        const ownPath = path.join(tmpRoot, 'own.s');
        const ownText = '.export popa\n.proc popa\n  rts\n.endproc\n';
        const useText = '.import popa\n  jsr popa\n';
        fs.writeFileSync(ownPath, ownText);
        const usePath = path.join(tmpRoot, 'use.s');
        fs.writeFileSync(usePath, useText);
        notify('textDocument/didOpen', { textDocument: { uri: pathToFileURL(ownPath).toString(), languageId: 'ca65', version: 1, text: ownText } });
        notify('textDocument/didOpen', { textDocument: { uri: pathToFileURL(usePath).toString(), languageId: 'ca65', version: 1, text: useText } });
        const ownHover = (await request('textDocument/hover', {
            textDocument: { uri: pathToFileURL(usePath).toString() }, position: { line: 1, character: 7 },
        }))?.contents?.value || '';
        assert(!ownHover.includes('cc65 runtime') && ownHover.includes('proc'), `workspace definition wins: ${ownHover}`);

        // --- ca65/parseListing (address/bytes columns of the C generated-assembly view) ---
        const row = (addr, depth, bytes, src) => `${addr}r ${depth}  ${bytes.padEnd(13)}${src}`;
        const listing = [
            'ca65 V2.18 - Debian 2.19-2',
            'Main file   : view.s',
            'Current file: view.s',
            '',
            row('000000', 1, '', ';'),                      // view.s line 0
            row('000000', 1, '', '\t.macpack\tlongbranch'),  // line 1
            row('000000', 2, '', '.macro  jeq     Target'), //   (macpack contents, not source lines)
            row('000000', 2, '', '.endmacro'),
            row('000000', 1, '', '.segment\t"CODE"'),       // line 2
            row('000000', 1, 'A2 00', '\tldx     #$00'),     // line 3
            row('000002', 1, 'D0 03 4C rr', '\tjeq     L0002'), // line 4 (bytes continue below)
            row('000006', 1, 'rr', ''),
            row('000007', 1, '', ';'),                      // line 5
        ].join('\n') + '\n';
        const parsed = await request('ca65/parseListing', { content: listing });
        assert.deepStrictEqual(parsed, [
            { line: 3, address: '+$00r', bytes: 'A2 00', byteCount: 2 },
            { line: 4, address: '+$02r', bytes: 'D0 03 4C rr rr', byteCount: 5 },
        ], `parseListing = ${JSON.stringify(parsed)}`);

        console.log('ALL C BRIDGE CHECKS PASSED!');
    } finally {
        try { await request('shutdown', null); notify('exit', null); } catch {}
        proc.kill();
        fs.rmSync(tmpRoot, { recursive: true, force: true });
    }
})().catch((err) => {
    console.error(err);
    process.exit(1);
});
