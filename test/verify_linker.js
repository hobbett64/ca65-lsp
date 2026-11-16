const assert = require('assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { spawn } = require('child_process');
const { pathToFileURL } = require('url');

const settingsMod = require(path.resolve(process.cwd(), 'server/out/settings.js'));
const serverEntry = path.resolve(process.cwd(), 'server/out/server.js');

function testSettingsLinkerUnit() {
    assert.strictEqual(settingsMod.resolveCa65Settings({}).linkerConfig, '');
    assert.strictEqual(settingsMod.resolveCa65Settings({ linkerConfig: '  nes.cfg  ' }).linkerConfig, 'nes.cfg');
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

    return { request, notify, publishedDiagnostics, close };
}

async function waitFor(fn, timeoutMs = 6000) {
    const start = Date.now();
    while (Date.now() - start < timeoutMs) {
        const val = fn();
        if (val) return val;
        await new Promise(r => setTimeout(r, 40));
    }
    throw new Error('Timed out waiting for LSP condition');
}

function decodeSemanticTokens(data, lineTextArr, legend) {
    const tokens = [];
    let line = 0;
    let char = 0;
    for (let i = 0; i < data.length; i += 5) {
        const dLine = data[i];
        const dChar = data[i + 1];
        const len = data[i + 2];
        const typeIdx = data[i + 3];
        const modMask = data[i + 4];
        if (dLine > 0) {
            line += dLine;
            char = dChar;
        } else {
            char += dChar;
        }
        const modNames = [];
        for (let b = 0; b < legend.tokenModifiers.length; b++) {
            if (modMask & (1 << b)) modNames.push(legend.tokenModifiers[b]);
        }
        tokens.push({
            line,
            char,
            name: lineTextArr[line].slice(char, char + len),
            type: legend.tokenTypes[typeIdx],
            modifiers: modNames,
        });
    }
    return tokens;
}

(async () => {
    testSettingsLinkerUnit();

    const tmpRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'ca65-linker-e2e-'));
    const cfgPath = path.join(tmpRoot, 'nes.cfg');
    const defsPath = path.join(tmpRoot, 'defs.s');
    const mainPath = path.join(tmpRoot, 'main.s');

    const cfgInitial = [
        '# ld65 config with FEATURES & comments',
        'FEATURES {',
        '    CONDES: type = constructor, label = __CONSTRUCTOR_TABLE__;',
        '}',
        'MEMORY {',
        '    ZP:   start = $0000, size = $0100, type = rw, file = "";',
        '    RAM:  start = $0200, size = $0600, type = rw, file = "";',
        '    PRG0: start = $8000, size = $8000, type = ro, file = %O, fill = yes;',
        '}',
        'SEGMENTS {',
        '    ZP_VARS:   load = ZP,   type = zp;',
        '    OAM_BUF:   load = RAM,  type = rw, align = $100;',
        '    BSS_EXTRA: load = RAM,  type = bss, optional = yes;',
        '    RO_TABLES: load = PRG0, type = ro;',
        '    BANK00:    load = PRG0, type = ro;',
        '    VECTORS:   load = PRG0, type = ro, start = $FFFA;',
        '    ZEROPAGE:  load = ZP,   type = zp;',
        '    BSS:       load = RAM,  type = bss;',
        '    CODE:      load = PRG0, type = ro;',
        '    RODATA:    load = PRG0, type = ro;',
        '    DATA:      load = RAM,  type = rw;',
        '}',
    ].join('\n') + '\n';
    fs.writeFileSync(cfgPath, cfgInitial);

    const defsText = [
        '.export zp_cfg_var',
        '.export oam_page',
        '.segment "ZP_VARS"',
        'zp_cfg_var: .res 1',
        '.segment "OAM_BUF"',
        'oam_page: .res 256',
    ].join('\n') + '\n';
    fs.writeFileSync(defsPath, defsText);

    const mainLines = [
        '.import zp_cfg_var',
        '.importzp oam_page',
        '.segment "BANK00"',
        'main:',
        '    lda zp_cfg_var',
        '    sta oam_page',
        '.segment "TYPO_SEG"',
        '.segment ""',
        '.segment "OAM_BUF"',
        'oam_label:',
        'rw_bytes: .byte $01',
        '.segment "BSS_EXTRA"',
        'bss_slot:',
        '.segment "RO_TABLES"',
        'ro_tbl: .byte $02, $03',
        '; .segment "COMMENTED_OUT_SEG"',
        '    .zeropage',
        '  lbl_b: .bss',
        '  .CODE',
        '  .rodata',
        '  .data',
        '  .asciiz ".code"',
        '.segment "BANK00"',
        'bank_alias:',
        'bank_entry:',
        '    rts',
    ];
    const mainText = mainLines.join('\n') + '\n';
    fs.writeFileSync(mainPath, mainText);

    const cfgUri = pathToFileURL(cfgPath).toString();
    const defsUri = pathToFileURL(defsPath).toString();
    const mainUri = pathToFileURL(mainPath).toString();

    let currentConfig = {
        enableStderrDiagnostics: false,
        enableUnusedSymbolDiagnostics: false,
        linkerConfig: '',
    };

    const lsp = createLspHarness(() => currentConfig);
    try {
        const initRes = await lsp.request('initialize', {
            processId: process.pid,
            rootUri: pathToFileURL(tmpRoot).toString(),
            capabilities: {
                workspace: { configuration: true },
                textDocument: {
                    semanticTokens: { requests: { full: true } },
                },
            },
        });
        const legend = initRes.capabilities.semanticTokensProvider.legend;
        lsp.notify('initialized', {});

        lsp.notify('textDocument/didOpen', {
            textDocument: { uri: defsUri, languageId: 'ca65', version: 1, text: defsText },
        });
        lsp.notify('textDocument/didOpen', {
            textDocument: { uri: mainUri, languageId: 'ca65', version: 1, text: mainText },
        });

        await waitFor(() => lsp.publishedDiagnostics.has(mainUri));

        // 1. When linkerConfig is empty (default), no linker diagnostics, no cfg hover, no cfg definition
        const defaultDiags = lsp.publishedDiagnostics.get(mainUri) || [];
        assert.strictEqual(
            defaultDiags.some(d => d.code === 'unknown-linker-segment' || d.code === 'import-zp-expected'),
            false,
            `Unexpected linker diagnostics when linkerConfig is empty: ${JSON.stringify(defaultDiags)}`
        );

        const bankPos = { line: 2, character: 12 }; // inside "BANK00"
        const defBefore = await lsp.request('textDocument/definition', {
            textDocument: { uri: mainUri },
            position: bankPos,
        });
        assert.strictEqual(defBefore, null, 'Expected no definition before enabling linkerConfig');

        const hoverBefore = await lsp.request('textDocument/hover', {
            textDocument: { uri: mainUri },
            position: bankPos,
        });
        assert.strictEqual(hoverBefore, null, 'Expected no segment-name hover before enabling linkerConfig');

        // 2. Enable linkerConfig = 'nes.cfg'
        currentConfig = {
            enableStderrDiagnostics: false,
            enableUnusedSymbolDiagnostics: false,
            linkerConfig: 'nes.cfg',
        };
        lsp.publishedDiagnostics.delete(mainUri);
        lsp.notify('workspace/didChangeConfiguration', { settings: { ca65: currentConfig } });

        const linkerDiags = await waitFor(() => {
            const d = lsp.publishedDiagnostics.get(mainUri);
            return d && d.some(x => x.code === 'unknown-linker-segment') ? d : null;
        });

        const unknownSegDiags = linkerDiags.filter(d => d.code === 'unknown-linker-segment');
        assert.strictEqual(unknownSegDiags.length, 1, `Expected exactly 1 unknown-linker-segment warning, got: ${JSON.stringify(unknownSegDiags)}`);
        const unknownSegDiag = unknownSegDiags[0];
        assert.strictEqual(unknownSegDiag.range.start.line, 6);
        assert.strictEqual(unknownSegDiag.range.start.character, 10);
        assert.strictEqual(unknownSegDiag.range.end.character, 18);

        assert.ok(
            linkerDiags.some(d => d.code === 'import-zp-expected' && d.range.start.line === 0),
            `Expected import-zp-expected for ZP_VARS symbol: ${JSON.stringify(linkerDiags)}`
        );
        assert.ok(
            linkerDiags.some(d => d.code === 'import-abs-expected' && d.range.start.line === 1),
            `Expected import-abs-expected for OAM_BUF symbol: ${JSON.stringify(linkerDiags)}`
        );

        // 3. Go to Definition on .segment "BANK00" and built-in segment directives
        const defAfter = await lsp.request('textDocument/definition', {
            textDocument: { uri: mainUri },
            position: bankPos,
        });
        assert.ok(defAfter && defAfter.uri === cfgUri, `Expected definition in nes.cfg, got: ${JSON.stringify(defAfter)}`);
        assert.strictEqual(defAfter.range.start.line, 14);

        const builtinChecks = [
            { label: '.zeropage', pos: { line: 16, character: 6 }, cfgLine: 16 },
            { label: '.bss', pos: { line: 17, character: 10 }, cfgLine: 17 },
            { label: '.CODE', pos: { line: 18, character: 4 }, cfgLine: 18 },
            { label: '.rodata', pos: { line: 19, character: 5 }, cfgLine: 19 },
            { label: '.data', pos: { line: 20, character: 4 }, cfgLine: 20 },
        ];
        for (const check of builtinChecks) {
            const loc = await lsp.request('textDocument/definition', {
                textDocument: { uri: mainUri },
                position: check.pos,
            });
            assert.ok(loc && loc.uri === cfgUri, `Expected definition in nes.cfg for ${check.label}, got: ${JSON.stringify(loc)}`);
            assert.strictEqual(loc.range.start.line, check.cfgLine, `Wrong nes.cfg line for ${check.label}`);
        }

        const strDef = await lsp.request('textDocument/definition', {
            textDocument: { uri: mainUri },
            position: { line: 21, character: 12 }, // inside .asciiz ".code"
        });
        assert.strictEqual(strDef, null, 'String literal ".code" must not resolve as built-in segment directive');

        // 4. Hover on .segment "OAM_BUF"
        const hoverAfter = await lsp.request('textDocument/hover', {
            textDocument: { uri: mainUri },
            position: { line: 8, character: 12 },
        });
        assert.ok(hoverAfter && hoverAfter.contents && hoverAfter.contents.value, 'Expected segment hover markdown');
        const hoverText = hoverAfter.contents.value;
        assert.ok(hoverText.includes('`OAM_BUF` segment'), hoverText);
        assert.ok(hoverText.includes('type: `rw`') && hoverText.includes('align: `$100`'), hoverText);
        assert.ok(hoverText.includes('Memory `RAM`: start `$0200`, size `$0600`'), hoverText);

        // 5. Completion inside .segment ""
        const completionRes = await lsp.request('textDocument/completion', {
            textDocument: { uri: mainUri },
            position: { line: 7, character: 10 },
        });
        const items = Array.isArray(completionRes) ? completionRes : (completionRes && completionRes.items) || [];
        const vectorsItem = items.find(i => i.label === 'VECTORS');
        const zpItem = items.find(i => i.label === 'ZP_VARS');
        assert.ok(vectorsItem, 'Expected unused segment VECTORS from nes.cfg in completions');
        assert.ok(vectorsItem.sortText.startsWith('0'), `Expected linker segments sorted first: ${vectorsItem.sortText}`);
        assert.ok(zpItem && zpItem.detail && zpItem.detail.includes('type=zp'), `Expected rich cfg detail: ${JSON.stringify(zpItem)}`);

        // 6. Semantic tokens classification using linkerConfig segment types
        const semRes = await lsp.request('textDocument/semanticTokens/full', {
            textDocument: { uri: mainUri },
        });
        const decoded = decodeSemanticTokens(semRes.data, mainLines, legend);
        const byName = new Map(decoded.map(t => [t.name, t]));
        assert.strictEqual(byName.get('oam_label')?.type, 'variable', 'Label in type=rw segment should be variable');
        assert.strictEqual(byName.get('oam_label')?.modifiers.includes('readonly'), false, 'type=rw label should not be readonly');
        assert.strictEqual(byName.get('bss_slot')?.type, 'variable', 'Label in type=bss segment should be variable');
        assert.strictEqual(byName.get('bss_slot')?.modifiers.includes('readonly'), false, 'type=bss label should not be readonly');
        assert.strictEqual(byName.get('rw_bytes')?.type, 'variable');
        assert.strictEqual(byName.get('rw_bytes')?.modifiers.includes('readonly'), false, 'DataLabel in type=rw should not be readonly');
        assert.strictEqual(byName.get('ro_tbl')?.type, 'variable');
        assert.strictEqual(byName.get('ro_tbl')?.modifiers.includes('readonly'), true, 'DataLabel in type=ro should be readonly');
        assert.strictEqual(byName.get('main')?.type, 'function', 'Code label followed by instruction in custom segment should be function');
        assert.strictEqual(byName.get('bank_alias')?.type, 'function', 'Stacked code label alias should also be function');
        assert.strictEqual(byName.get('bank_entry')?.type, 'function', 'Stacked target code label should be function');

        // 7. Modifying nes.cfg on disk + watched file change clears unknown-linker-segment diagnostic
        fs.writeFileSync(cfgPath, cfgInitial.replace('    VECTORS:', '    TYPO_SEG:  load = PRG0, type = ro;\n    VECTORS:'));
        const future = new Date(Date.now() + 2000);
        fs.utimesSync(cfgPath, future, future);
        lsp.publishedDiagnostics.delete(mainUri);
        lsp.notify('workspace/didChangeWatchedFiles', {
            changes: [{ uri: cfgUri, type: 2 }],
        });

        const updatedDiags = await waitFor(() => lsp.publishedDiagnostics.get(mainUri));
        assert.strictEqual(
            updatedDiags.some(d => d.code === 'unknown-linker-segment'),
            false,
            `Expected unknown-linker-segment to clear after nes.cfg edit: ${JSON.stringify(updatedDiags)}`
        );

        console.log('verify_linker: all linker config unit and E2E tests passed!');
    } finally {
        await lsp.close();
        fs.rmSync(tmpRoot, { recursive: true, force: true });
    }
})();
