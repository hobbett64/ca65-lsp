const assert = require('assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const which = require('which');
const { spawn } = require('child_process');
const { pathToFileURL } = require('url');

const settingsMod = require(path.resolve(process.cwd(), 'server/out/settings.js'));
const serverEntry = path.resolve(process.cwd(), 'server/out/server.js');
const hasCa65 = Boolean(which.sync('ca65', { nothrow: true }));

function testSettingsUnit() {
    const {
        DEFAULT_FILE_EXTENSIONS,
        DEFAULT_INCLUDE_DIRS,
        normalizeFileExtensions,
        sanitizeAdditionalCa65Args,
        resolveCa65Settings,
    } = settingsMod;

    // 1. Default structured settings when config is empty
    const dflt = resolveCa65Settings({});
    assert.strictEqual(dflt.cpu, '6502');
    assert.deepStrictEqual(dflt.includeDirs, Array.from(DEFAULT_INCLUDE_DIRS));
    assert.deepStrictEqual(dflt.binIncludeDirs, []);
    assert.strictEqual(dflt.implicitImports, false);
    assert.strictEqual(dflt.cComments, true);
    assert.strictEqual(dflt.lineContinuations, true);
    assert.deepStrictEqual(dflt.additionalArgs, []);
    assert.deepStrictEqual(dflt.fileExtensions, Array.from(DEFAULT_FILE_EXTENSIONS));
    assert.strictEqual(dflt.enableStderrDiagnostics, true);
    assert.strictEqual(dflt.enableUnusedSymbolDiagnostics, true);
    assert.strictEqual(dflt.anonymousLabelIndexHints, true);
    assert.strictEqual(dflt.importFromHints, true);
    assert.strictEqual(dflt.enableStatusBarCycleCount, true);
    assert.strictEqual(dflt.enableStatusBarSegment, true);
    assert.strictEqual(dflt.smartFolding, true);
    assert.deepStrictEqual(dflt.autoIncludeExtensions, ['.inc']);

    // 2. Explicit false overrides for boolean feature flags
    const disabledFeatures = resolveCa65Settings({ cComments: false, lineContinuations: false });
    assert.strictEqual(disabledFeatures.cComments, false);
    assert.strictEqual(disabledFeatures.lineContinuations, false);

    // 3. File extension normalization
    assert.deepStrictEqual(normalizeFileExtensions(undefined), ['.s', '.asm', '.inc']);
    assert.deepStrictEqual(normalizeFileExtensions(['.s', 'mac', '*.i', '.s', '']), ['.s', '.mac', '.i']);
    assert.deepStrictEqual(normalizeFileExtensions([]), []);

    // 4. Backwards-compatible fallback for deprecated v2.1 keys (when new keys are unset)
    const legacyFallback = resolveCa65Settings({
        enableCa65StdErrDiagnostics: false,
        additionalExtensions: ['.i', 'mac'],
    });
    assert.strictEqual(legacyFallback.enableStderrDiagnostics, false);
    assert.deepStrictEqual(legacyFallback.fileExtensions, ['.s', '.asm', '.inc', '.i', '.mac']);

    // New keys take precedence over deprecated aliases
    const overrideLegacy = resolveCa65Settings({
        enableStderrDiagnostics: true,
        enableCa65StdErrDiagnostics: false,
        fileExtensions: ['.s', '.a65'],
        additionalExtensions: ['.mac'],
    });
    assert.strictEqual(overrideLegacy.enableStderrDiagnostics, true);
    assert.deepStrictEqual(overrideLegacy.fileExtensions, ['.s', '.a65']);

    // 5. additionalArgs output/listing/dependency flag stripping
    assert.deepStrictEqual(
        sanitizeAdditionalCa65Args([
            '-D', 'FOO=1',
            '-o', 'out.o',
            '-l', 'out.lst',
            '-lout2.lst',
            '--listing=out3.lst',
            '--create-dep', 'dep.d',
            '--create-full-dep=full.d',
            '-s',
        ]),
        ['-D', 'FOO=1', '-s']
    );
}

function createLspHarness(getCa65Config) {
    const proc = spawn(process.execPath, [serverEntry, '--stdio'], {
        cwd: process.cwd(),
        stdio: ['pipe', 'pipe', 'pipe'],
    });
    let buffer = Buffer.alloc(0);
    let nextId = 1;
    const pending = new Map();
    const publishedDiagnostics = new Map();
    const shownMessages = [];

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
            const msg = JSON.parse(buffer.slice(headerEnd + 4, totalLen).toString('utf8'));
            buffer = buffer.slice(totalLen);

            if (msg.id !== undefined && msg.method !== undefined) {
                if (msg.method === 'workspace/configuration') {
                    const items = (msg.params && msg.params.items) || [];
                    sendMessage({
                        jsonrpc: '2.0',
                        id: msg.id,
                        result: items.map(i => i.section === 'ca65' ? getCa65Config() : { associations: {} }),
                    });
                } else if (msg.method === 'window/showMessageRequest' && msg.params) {
                    shownMessages.push(msg.params);
                    sendMessage({ jsonrpc: '2.0', id: msg.id, result: null });
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
            } else if (msg.method === 'textDocument/publishDiagnostics' && msg.params) {
                publishedDiagnostics.set(msg.params.uri, msg.params.diagnostics || []);
            } else if (msg.method === 'window/showMessage' && msg.params) {
                shownMessages.push(msg.params);
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

    return { request, notify, publishedDiagnostics, shownMessages, close };
}

(async () => {
    testSettingsUnit();

    const tmpRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'ca65-settings-e2e-'));
    const defaultIncDir = path.join(tmpRoot, 'include');
    const customIncDir = path.join(tmpRoot, 'custom_inc');
    const customBinDir = path.join(tmpRoot, 'custom_bin');
    fs.mkdirSync(defaultIncDir, { recursive: true });
    fs.mkdirSync(customIncDir, { recursive: true });
    fs.mkdirSync(customBinDir, { recursive: true });

    const defIncPath = path.join(defaultIncDir, 'defs.inc');
    const snesIncPath = path.join(customIncDir, 'snes_hdr.inc');
    const binPath = path.join(customBinDir, 'gfx.bin');
    const extPath = path.join(tmpRoot, 'ext.s');
    const a65Path = path.join(tmpRoot, 'extra.a65');
    const mainPath = path.join(tmpRoot, 'main.s');
    const snesPath = path.join(tmpRoot, 'snes.s');

    fs.writeFileSync(defIncPath, 'DEF_ZP = $42\n');
    fs.writeFileSync(snesIncPath, 'SNES_CONST = $7F\n');
    fs.writeFileSync(binPath, Buffer.from([1, 2, 3, 4]));
    fs.writeFileSync(a65Path, '.export a65_exported_sym\na65_exported_sym:\n  rts\n');

    const extText = [
        '.export implicit_ext',
        'implicit_ext:',
        '  rts',
    ].join('\n') + '\n';
    fs.writeFileSync(extPath, extText);

    const mainText = [
        '.include "defs.inc"',
        '.code',
        '  /* default c_comments enableIfAvailable test */',
        '  lda DEF_ZP',
        '  rts',
    ].join('\n') + '\n';
    fs.writeFileSync(mainPath, mainText);

    const snesText = [
        '.include "snes_hdr.inc"',
        '.code',
        '  jsl $008000',
        '  lda #BUILD_VAL',
        '  lda SNES_CONST',
        '  jsr implicit_ext',
        '  rts',
        '.rodata',
        'gfx_data:',
        '  .incbin "gfx.bin"',
    ].join('\n') + '\n';
    fs.writeFileSync(snesPath, snesText);

    let currentConfig = {
        enableStderrDiagnostics: hasCa65,
        enableUnusedSymbolDiagnostics: false,
        fileExtensions: ['.s', '.asm', '.inc', '.a65'],
    };

    const client = createLspHarness(() => currentConfig);
    try {
        const wsUri = pathToFileURL(tmpRoot).toString();
        const mainUri = pathToFileURL(mainPath).toString();
        const snesUri = pathToFileURL(snesPath).toString();
        const extUri = pathToFileURL(extPath).toString();

        await client.request('initialize', {
            processId: process.pid,
            rootUri: wsUri,
            workspaceFolders: [{ uri: wsUri, name: 'ws' }],
            capabilities: {},
        });
        client.notify('initialized', {});
        client.notify('textDocument/didOpen', { textDocument: { uri: extUri, languageId: 'ca65', version: 1, text: extText } });
        client.notify('textDocument/didOpen', { textDocument: { uri: mainUri, languageId: 'ca65', version: 1, text: mainText } });
        await new Promise(r => setTimeout(r, 700));

        const wsSyms = await client.request('workspace/symbol', { query: 'a65_exported_sym' });
        assert(
            wsSyms && wsSyms.some(s => s.location && s.location.uri === pathToFileURL(a65Path).toString()),
            `fileExtensions should index unopened .a65 workspace files, got: ${JSON.stringify(wsSyms)}`
        );

        // ------------------------------------------------------------------
        // A. Defaults: **/include + cComments/lineContinuations auto-fallback if unsupported
        // ------------------------------------------------------------------
        const defLinks = await client.request('textDocument/documentLink', { textDocument: { uri: mainUri } });
        assert.strictEqual(defLinks.length, 1, 'Default includeDirs should resolve .include "defs.inc"');

        if (hasCa65) {
            const mainDiags = client.publishedDiagnostics.get(mainUri) || [];
            assert.strictEqual(
                mainDiags.length,
                0,
                `Default true cComments/lineContinuations should assemble c_comments cleanly even if line_continuations is unavailable, got: ${JSON.stringify(mainDiags)}`
            );
            const ovl = await client.request('ca65/getOverlayData', { uri: mainUri });
            assert.strictEqual(ovl.source, 'live-lst', 'Default settings should produce live overlay listing');
            assert.strictEqual(client.shownMessages.length, 0, 'Automatic feature fallback must not emit CLI error notifications');
        }

        // ------------------------------------------------------------------
        // B. Structured GUI settings + additionalArgs: [] / custom
        // ------------------------------------------------------------------
        currentConfig = {
            enableStderrDiagnostics: hasCa65,
            enableUnusedSymbolDiagnostics: false,
            cpu: '65816',
            includeDirs: ['custom_inc'],
            binIncludeDirs: ['custom_bin'],
            implicitImports: true,
            cComments: false,
            lineContinuations: false,
            additionalArgs: [
                '-D', 'BUILD_VAL=$3C',
                '-o', 'bad_should_ignore.o',
                '-l', 'bad_should_ignore.lst',
                '--create-dep', 'bad_should_ignore.d',
            ],
        };
        client.publishedDiagnostics.clear();
        client.notify('workspace/didChangeConfiguration', { settings: {} });
        client.notify('textDocument/didOpen', { textDocument: { uri: snesUri, languageId: 'ca65', version: 1, text: snesText } });
        await new Promise(r => setTimeout(r, 800));

        const snesLines = snesText.split('\n');
        const snesLinks = await client.request('textDocument/documentLink', { textDocument: { uri: snesUri } });
        assert.strictEqual(snesLinks.length, 2, 'includeDirs & binIncludeDirs should resolve snes_hdr.inc and gfx.bin');

        const impLine = snesLines.findIndex(l => l.includes('jsr implicit_ext'));
        const impDef = await client.request('textDocument/definition', {
            textDocument: { uri: snesUri },
            position: { line: impLine, character: snesLines[impLine].indexOf('implicit_ext') + 2 },
        });
        const impLoc = Array.isArray(impDef) ? impDef[0] : impDef;
        assert(impLoc && impLoc.uri === extUri, 'implicitImports: true should resolve implicit_ext across files');

        if (hasCa65) {
            const snesDiags = client.publishedDiagnostics.get(snesUri) || [];
            assert.strictEqual(snesDiags.length, 0, `65816 + custom paths + -D should assemble cleanly, got: ${JSON.stringify(snesDiags)}`);

            // With cComments: false and includeDirs: ['custom_inc'], main.s should fail diagnostics
            const mainDisabledDiags = client.publishedDiagnostics.get(mainUri) || [];
            assert(mainDisabledDiags.length > 0, 'cComments: false & overriding includeDirs should fail assembling main.s');

            const snesOvl = await client.request('ca65/getOverlayData', { uri: snesUri });
            assert.strictEqual(snesOvl.source, 'live-lst');
            const byLine = new Map(snesOvl.lines.map(l => [l.line, l]));
            const ldaBuildLine = snesLines.findIndex(l => l.includes('lda #BUILD_VAL'));
            assert.strictEqual(byLine.get(ldaBuildLine).bytesText, 'A9 3C', 'Expected -D BUILD_VAL=$3C in overlay');
            assert(!fs.existsSync(path.join(tmpRoot, 'bad_should_ignore.o')), '-o in additionalArgs should be ignored');
            assert(!fs.existsSync(path.join(tmpRoot, 'bad_should_ignore.lst')), '-l in additionalArgs should be ignored');
            assert(!fs.existsSync(path.join(tmpRoot, 'bad_should_ignore.d')), '--create-dep in additionalArgs should be ignored');

            // ------------------------------------------------------------------
            // C. Invalid CLI flag in additionalArgs surfaces a user notification
            // ------------------------------------------------------------------
            client.shownMessages.length = 0;
            currentConfig = {
                enableStderrDiagnostics: true,
                enableUnusedSymbolDiagnostics: false,
                additionalArgs: ['--bogus-ca65-flag'],
            };
            client.notify('workspace/didChangeConfiguration', { settings: {} });
            await new Promise(r => setTimeout(r, 700));
            assert(
                client.shownMessages.some(m => m.type === 1 && m.message.includes('--bogus-ca65-flag')),
                `Expected window/showMessage error for invalid additionalArgs flag, got: ${JSON.stringify(client.shownMessages)}`
            );
        }

        console.log('ALL STRUCTURED SETTINGS E2E CHECKS PASSED!');
    } finally {
        await client.close();
        fs.rmSync(tmpRoot, { recursive: true, force: true });
    }
})().catch((err) => {
    console.error(err);
    process.exit(1);
});
