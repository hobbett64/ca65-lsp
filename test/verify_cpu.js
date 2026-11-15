const assert = require('assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const which = require('which');
const { spawn } = require('child_process');
const { pathToFileURL } = require('url');

const serverEntry = path.resolve(process.cwd(), 'server/out/server.js');
const hasCa65 = Boolean(which.sync('ca65', { nothrow: true }));

function createLspHarness(getCpu) {
    const proc = spawn(process.execPath, [serverEntry, '--stdio'], {
        cwd: process.cwd(),
        stdio: ['pipe', 'pipe', 'pipe'],
    });

    let buffer = Buffer.alloc(0);
    let nextId = 1;
    const pending = new Map();
    const publishedDiagnostics = new Map();
    const stderrLogs = [];

    proc.stderr.on('data', (d) => stderrLogs.push(d.toString('utf8')));
    proc.stdout.on('data', (chunk) => {
        buffer = Buffer.concat([buffer, chunk]);
        while (true) {
            const headerEnd = buffer.indexOf('\r\n\r\n');
            if (headerEnd === -1) break;
            const headerStr = buffer.slice(0, headerEnd).toString('utf8');
            const m = headerStr.match(/Content-Length:\s*(\d+)/i);
            assert(m, `Missing Content-Length in header: ${headerStr}`);
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
                            cpu: getCpu(),
                            enableCa65StdErrDiagnostics: hasCa65,
                            enableUnusedSymbolDiagnostics: false,
                            diagnosticsDelay: 50,
                            includeDirs: [],
                            binIncludeDirs: [],
                            autoIncludeExtensions: ['.inc'],
                            anonymousLabelIndexHints: false,
                            importFromHints: false,
                            additionalExtensions: [],
                            smartFolding: true,
                            implicitImports: false,
                            lineContinuations: false,
                            enableStatusBarCycleCount: true,
                            additionalArgs: [],
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
        await request('shutdown', null).catch(() => {});
        notify('exit', null);
        await new Promise(r => setTimeout(r, 80));
        if (!proc.killed) proc.kill();
    }

    return { request, notify, publishedDiagnostics, stderrLogs, close };
}

async function waitForDiagnostics(publishedDiagnostics, uri, predicate, timeoutMs = 4000) {
    const start = Date.now();
    while (Date.now() - start < timeoutMs) {
        if (publishedDiagnostics.has(uri)) {
            const diags = publishedDiagnostics.get(uri);
            if (!predicate || predicate(diags)) return diags;
        }
        await new Promise(r => setTimeout(r, 50));
    }
    return publishedDiagnostics.get(uri) || [];
}

function posOf(lines, needle, offset = 1) {
    const line = lines.findIndex(l => l.includes(needle));
    assert(line !== -1, `Could not find line containing: ${needle}`);
    return { line, character: lines[line].indexOf(needle) + offset };
}

(async () => {
    const tmpRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'ca65-cpu-'));
    let activeCpu = '6502';
    const harness = createLspHarness(() => activeCpu);
    const { request, notify, publishedDiagnostics, stderrLogs } = harness;

    const baseDocPath = path.join(tmpRoot, 'cpu_test.s');
    const unopenedDocPath = path.join(tmpRoot, 'unopened_mod.s');
    const c6502Uri = pathToFileURL(baseDocPath).toString();
    const unopenedUri = pathToFileURL(unopenedDocPath).toString();

    const mainText = [
        '.segment "CODE"',
        '  bra @loop',
        '  stz $10',
        '  jsl HelperProc',
        '  rmb0 $10',
        '  bbr0 $10, @loop',
        '  wai',
        '  stp',
        '  ina',
        '  ina ',
        '  dea',
        '  phx',
        '  jmp ($1234)',
        '  jmp ($1234, x)',
        '  lda ($10)',
        '  bit #$0f',
        '  asl $1234, x',
        '  lda $12, x',
        '  lda #$12',
        '  lda #$1234',
        '  ldx #$1234',
        '  lda $10',
        '  lda $1234, x',
        '  lda [$10], y',
        '  lda $01, s',
        '  lda ($01, s), y',
        '  lda f:far_target',
        '  lda $018000',
        '  stx $10',
        '  brk',
        '  brk $00',
        '  mvn $00, $01',
        '  jml [$1234]',
        '  cpa #$10',
        '  pea $1234',
        '  pei ($10)',
        '  per @loop',
        '@loop:',
        '  rts',
        '.proc Main',
        '  jsl HelperProc',
        '  rts',
        '.endproc',
        '.proc HelperProc',
        '  rtl',
        '.endproc',
        'far_target = $018000',
        '',
    ].join('\n');

    const unopenedText = [
        '.proc RemoteInit',
        '  stz $10',
        '  jsl RemoteHelper',
        '  rtl',
        '.endproc',
        '.proc RemoteHelper',
        '  rtl',
        '.endproc',
        '',
    ].join('\n');

    fs.writeFileSync(baseDocPath, mainText);
    fs.writeFileSync(unopenedDocPath, unopenedText);

    const lines = mainText.split('\n');

    async function switchCpu(cpu) {
        activeCpu = cpu;
        publishedDiagnostics.clear();
        notify('workspace/didChangeConfiguration', { settings: { ca65: { cpu } } });
        await new Promise(r => setTimeout(r, 150));
    }

    async function analyzeLine(needle) {
        const line = lines.findIndex(l => l.includes(needle));
        assert(line !== -1, `Could not find line for analyzeLine: ${needle}`);
        return request('ca65/analyzeSelection', {
            uri: c6502Uri,
            range: {
                start: { line, character: 0 },
                end: { line, character: lines[line].length },
            },
        });
    }

    async function hoverToken(token, needle) {
        const re = needle ? null : new RegExp(`\\b${token}\\b`);
        const line = lines.findIndex(l => needle ? l.includes(needle) : re.test(l));
        assert(line !== -1, `Could not find line for hoverToken: ${needle || token}`);
        const col = needle ? lines[line].indexOf(token) : lines[line].search(re);
        assert(col !== -1, `Could not find token ${token} in ${lines[line]}`);
        return request('textDocument/hover', {
            textDocument: { uri: c6502Uri },
            position: { line, character: col + 1 },
        });
    }

    async function getCommandCompletionLabels() {
        const blankLine = lines.length - 1;
        const result = await request('textDocument/completion', {
            textDocument: { uri: c6502Uri },
            position: { line: blankLine, character: 0 },
        });
        const items = Array.isArray(result) ? result : result.items;
        return new Map(items.map(i => [i.label, i]));
    }

    try {
        const wsUri = pathToFileURL(tmpRoot).toString();
        await request('initialize', {
            processId: process.pid,
            rootUri: wsUri,
            workspaceFolders: [{ uri: wsUri, name: 'ws' }],
            capabilities: {},
        });
        notify('initialized', {});
        notify('textDocument/didOpen', { textDocument: { uri: c6502Uri, languageId: 'ca65', version: 1, text: mainText } });

        // Wait for initial workspace indexing & diagnostics
        await new Promise(r => setTimeout(r, 300));

        // ------------------------------------------------------------------
        // 1. Default '6502': strictly NMOS 6502 (no 65C02/65816 leakage)
        // ------------------------------------------------------------------
        for (const non6502 of ['bra', 'stz', 'jsl', 'rmb0', 'bbr0', 'wai']) {
            const h = await hoverToken(non6502);
            assert.strictEqual(h, null, `6502 mode should not provide mnemonic hover for '${non6502}'`);
        }

        const comp6502 = await getCommandCompletionLabels();
        assert(comp6502.has('lda'), '6502 completions must include lda');
        assert(!comp6502.has('bra') && !comp6502.has('stz') && !comp6502.has('jsl') && !comp6502.has('rmb0') && !comp6502.has('wai'),
            '6502 completions must not include 65C02/65816 opcodes');
        const resolvedLda6502 = await request('completionItem/resolve', comp6502.get('lda'));
        assert(resolvedLda6502.documentation.value.startsWith('`lda` — **Load Accumulator**\n'),
            `6502 hover/completion doc should not carry a CPU tag, got: ${resolvedLda6502.documentation.value}`);

        const jmp6502 = await analyzeLine('jmp ($1234)');
        assert.strictEqual(jmp6502.minCycles, 5);
        assert.strictEqual(jmp6502.maxCycles, 5);
        const asl6502 = await analyzeLine('asl $1234, x');
        assert.strictEqual(asl6502.minCycles, 7);
        assert.strictEqual(asl6502.maxCycles, 7);

        const ref6502 = await request('ca65/getReferenceData', { cpu: '6502' });
        assert.strictEqual(ref6502.cpu, '6502');
        assert(ref6502.mnemonics.LDA && !ref6502.mnemonics.BRA && !ref6502.mnemonics.JSL);

        // ------------------------------------------------------------------
        // 2. '65SC02': core CMOS without Rockwell bit ops or WAI/STP
        // ------------------------------------------------------------------
        await switchCpu('65SC02');

        for (const cmosOp of ['bra', 'stz', 'ina', 'dea', 'phx']) {
            const h = await hoverToken(cmosOp);
            assert(h && h.contents.value.includes('(65SC02)'), `Expected (65SC02) hover for ${cmosOp}`);
        }
        for (const excluded of ['rmb0', 'bbr0', 'wai', 'stp', 'jsl']) {
            const h = await hoverToken(excluded);
            assert.strictEqual(h, null, `65SC02 should not include ${excluded}`);
        }

        const comp65SC02 = await getCommandCompletionLabels();
        assert(comp65SC02.has('bra') && comp65SC02.has('stz') && comp65SC02.has('ina') && comp65SC02.has('trb'));
        assert(!comp65SC02.has('rmb0') && !comp65SC02.has('wai') && !comp65SC02.has('jsl'));

        const inaOperandLine = lines.findIndex(l => l === '  ina ');
        const inaOperandComp = await request('textDocument/completion', {
            textDocument: { uri: c6502Uri },
            position: { line: inaOperandLine, character: lines[inaOperandLine].length },
        });
        const inaItems = Array.isArray(inaOperandComp) ? inaOperandComp : inaOperandComp.items;
        assert.strictEqual(inaItems.length, 0, 'ina (Accumulator-only) should suppress operand completions');

        const jmpSc02 = await analyzeLine('jmp ($1234)');
        assert.strictEqual(jmpSc02.minCycles, 6);
        assert.strictEqual(jmpSc02.maxCycles, 6);
        const jmpIdxSc02 = await analyzeLine('jmp ($1234, x)');
        assert.strictEqual(jmpIdxSc02.minCycles, 6);
        assert.strictEqual(jmpIdxSc02.items[0].mode, '(Absolute, X)');
        const ldaZpIndSc02 = await analyzeLine('lda ($10)');
        assert.strictEqual(ldaZpIndSc02.items[0].mode, '(Zero Page)');
        assert.strictEqual(ldaZpIndSc02.minCycles, 5);
        const aslSc02 = await analyzeLine('asl $1234, x');
        assert.strictEqual(aslSc02.minCycles, 6);
        assert.strictEqual(aslSc02.maxCycles, 7);
        const braSc02 = await analyzeLine('bra @loop');
        assert.strictEqual(braSc02.minCycles, 3);
        assert.strictEqual(braSc02.maxCycles, 4);

        // ------------------------------------------------------------------
        // 3. '65C02': adds Rockwell RMB0-7 / SMB0-7 / BBR0-7 / BBS0-7
        // ------------------------------------------------------------------
        await switchCpu('65C02');

        const rmbHover = await hoverToken('rmb0');
        assert(rmbHover && rmbHover.contents.value.includes('(65C02)') && rmbHover.contents.value.includes('`07`'));
        const bbrHover = await hoverToken('bbr0');
        assert(bbrHover && bbrHover.contents.value.includes('(65C02)') && bbrHover.contents.value.includes('`0F`'));
        assert.strictEqual(await hoverToken('wai'), null, '65C02 should not expose WAI');
        assert.strictEqual(await hoverToken('jsl'), null, '65C02 should not expose JSL');

        const rmbAnalysis = await analyzeLine('rmb0 $10');
        assert.strictEqual(rmbAnalysis.minBytes, 2);
        assert.strictEqual(rmbAnalysis.minCycles, 5);
        assert.strictEqual(rmbAnalysis.maxCycles, 5);
        const bbrAnalysis = await analyzeLine('bbr0 $10, @loop');
        assert.strictEqual(bbrAnalysis.minBytes, 3);
        assert.strictEqual(bbrAnalysis.minCycles, 5);
        assert.strictEqual(bbrAnalysis.maxCycles, 7);

        // ------------------------------------------------------------------
        // 4. 'W65C02': adds WAI / STP cleanly
        // ------------------------------------------------------------------
        await switchCpu('W65C02');

        const waiHover = await hoverToken('wai');
        assert(waiHover && waiHover.contents.value.includes('(W65C02)') && waiHover.contents.value.includes('`CB`'));
        const stpHover = await hoverToken('stp');
        assert(stpHover && stpHover.contents.value.includes('(W65C02)') && stpHover.contents.value.includes('`DB`'));
        assert(await hoverToken('rmb0'), 'W65C02 should retain Rockwell bit ops');
        assert.strictEqual(await hoverToken('jsl'), null, 'W65C02 should not include JSL');

        // ------------------------------------------------------------------
        // 5. '65816': SNES / IIgs 16-bit addressing, M/X ranges, Call Hierarchy
        // ------------------------------------------------------------------
        await switchCpu('65816');

        for (const op816 of ['jsl', 'jml', 'mvn', 'wai', 'cpa', 'pea', 'pei', 'per']) {
            const h = await hoverToken(op816);
            assert(h && h.contents.value.includes('(65816)'), `Expected (65816) hover for ${op816}`);
        }
        assert.strictEqual(await hoverToken('rmb0'), null, '65816 must exclude Rockwell RMB0');
        assert.strictEqual(await hoverToken('bbr0'), null, '65816 must exclude Rockwell BBR0');

        const comp65816 = await getCommandCompletionLabels();
        assert(comp65816.has('jsl') && comp65816.has('mvn') && comp65816.has('xce') && comp65816.has('cpa'));
        assert(!comp65816.has('rmb0') && !comp65816.has('bbs0'));
        const resolvedLda816 = await request('completionItem/resolve', comp65816.get('lda'));
        assert(resolvedLda816.documentation.value.includes('Direct Page') && resolvedLda816.documentation.value.includes('2–3 (M)'),
            '65816 LDA resolve doc should show Direct Page and variable M bytes');

        const ref65816 = await request('ca65/getReferenceData', { cpu: '65816' });
        assert.strictEqual(ref65816.cpu, '65816');
        assert(ref65816.mnemonics.JSL && ref65816.mnemonics.CPA && !ref65816.mnemonics.RMB0);

        const checks816 = [
            ['lda #$12', 'Immediate', 2, 3, 2, 3, true],
            ['lda #$1234', 'Immediate', 3, 3, 3, 3, false],
            ['ldx #$1234', 'Immediate', 3, 3, 3, 3, false],
            ['lda $10', 'Direct Page', 2, 2, 3, 4, true],
            ['lda $1234, x', 'Absolute, X', 3, 3, 4, 6, true],
            ['lda [$10], y', '[Direct Page], Y', 2, 2, 6, 7, true],
            ['lda $01, s', 'Stack Relative', 2, 2, 4, 5, true],
            ['lda ($01, s), y', '(Stack Relative, S), Y', 2, 2, 7, 8, true],
            ['lda f:far_target', 'Absolute Long', 4, 4, 4, 5, true],
            ['lda $018000', 'Absolute Long', 4, 4, 4, 5, true],
            ['stx $10', 'Direct Page', 2, 2, 3, 4, true],
            ['asl $1234, x', 'Absolute, X', 3, 3, 7, 9, true],
            ['ina', 'Accumulator', 1, 1, 2, 2, false],
            ['brk $00', 'Signature', 2, 2, 7, 8, false],
            ['mvn $00, $01', 'Block Move', 3, 3, 7, 7, false],
            ['jml [$1234]', '[Indirect Long]', 3, 3, 6, 6, false],
            ['bra @loop', 'Relative', 2, 2, 3, 3, false],
        ];
        for (const [needle, expMode, expMinB, expMaxB, expMinC, expMaxC, expVar16] of checks816) {
            const res = await analyzeLine(needle);
            assert.strictEqual(res.cpu, '65816', `cpu field for ${needle}`);
            assert.strictEqual(res.instructionCount, 1, `count for ${needle}`);
            const item = res.items[0];
            assert.strictEqual(item.mode, expMode, `Mode mismatch for ${needle}`);
            assert.strictEqual(item.minBytes, expMinB, `minBytes mismatch for ${needle}`);
            assert.strictEqual(item.maxBytes, expMaxB, `maxBytes mismatch for ${needle}`);
            assert.strictEqual(item.minCycles, expMinC, `minCycles mismatch for ${needle}`);
            assert.strictEqual(item.maxCycles, expMaxC, `maxCycles mismatch for ${needle}`);
            assert.strictEqual(Boolean(item.hasVariableWidth16), expVar16, `hasVariableWidth16 mismatch for ${needle}`);
        }

        // Exact line check for operandless `brk`
        const brkBareLine = lines.findIndex(l => l.trim() === 'brk');
        const brkBare = await request('ca65/analyzeSelection', {
            uri: c6502Uri,
            range: { start: { line: brkBareLine, character: 0 }, end: { line: brkBareLine, character: lines[brkBareLine].length } },
        });
        assert.strictEqual(brkBare.items[0].mode, 'Implied');
        assert.strictEqual(brkBare.minBytes, 1);
        assert.strictEqual(brkBare.minCycles, 7);
        assert.strictEqual(brkBare.maxCycles, 8);

        // Call Hierarchy on JSL in 65816 mode
        const helperPos = posOf(lines, '.proc HelperProc', 7);
        const callItems = await request('textDocument/prepareCallHierarchy', {
            textDocument: { uri: c6502Uri },
            position: helperPos,
        });
        assert(Array.isArray(callItems) && callItems.length > 0, 'Expected prepareCallHierarchy on HelperProc');
        const incoming = await request('callHierarchy/incomingCalls', { item: callItems[0] });
        assert(incoming.some(c => c.from.name === 'Main'),
            `Expected Main -> HelperProc via JSL in call hierarchy, got: ${JSON.stringify(incoming)}`);

        // Verify unopened workspace file rescanned on CPU change (`jsl RemoteHelper` is resolved, not a macro)
        const remoteDocLines = unopenedText.split('\n');
        notify('textDocument/didOpen', { textDocument: { uri: unopenedUri, languageId: 'ca65', version: 1, text: unopenedText } });
        const remoteHelperCalls = await request('textDocument/prepareCallHierarchy', {
            textDocument: { uri: unopenedUri },
            position: posOf(remoteDocLines, '.proc RemoteHelper', 7),
        });
        const remoteIncoming = await request('callHierarchy/incomingCalls', { item: remoteHelperCalls[0] });
        assert(remoteIncoming.some(c => c.from.name === 'RemoteInit'),
            'Expected unopened file jsl call edge after switching to 65816');

        // ------------------------------------------------------------------
        // 6. Live ca65 --cpu diagnostics & .lst overlay checks (when ca65 present)
        // ------------------------------------------------------------------
        if (hasCa65) {
            const validPath = path.join(tmpRoot, 'live_valid.s');
            const validUri = pathToFileURL(validPath).toString();
            const valid816 = [
                '.segment "CODE"',
                '  sep #$20',
                '  lda #$12',
                '  rep #$20',
                '  .a16',
                '  lda #$1234',
                '  jsl far_sub',
                '  mvn $00, $01',
                '  wai',
                'far_sub:',
                '  rtl',
                '',
            ].join('\n');
            fs.writeFileSync(validPath, valid816);
            notify('textDocument/didOpen', { textDocument: { uri: validUri, languageId: 'ca65', version: 1, text: valid816 } });
            const diags816 = await waitForDiagnostics(publishedDiagnostics, validUri, d => d.length === 0);
            assert.strictEqual(diags816.length, 0, `Expected 0 errors assembling 65816, got: ${JSON.stringify(diags816)}`);

            const overlay816 = await request('ca65/getOverlayData', { uri: validUri });
            assert.strictEqual(overlay816.source, 'live-lst', 'Expected live-lst overlay for 65816 file');
            assert(overlay816.lines.some(i => (i.bytesText || '').includes('A9 34 12')),
                `Expected 16-bit LDA #$1234 bytes in 65816 overlay, got: ${JSON.stringify(overlay816.lines)}`);
            assert(overlay816.lines.some(i => (i.bytesText || '').startsWith('22 ')),
                `Expected 4-byte JSL opcode in 65816 overlay, got: ${JSON.stringify(overlay816.lines)}`);
            assert(overlay816.lines.some(i => (i.bytesText || '').startsWith('54 ')),
                `Expected MVN opcode in 65816 overlay, got: ${JSON.stringify(overlay816.lines)}`);

            // Test W65C02 diagnostics compile cleanly (`wai`, `stp`, `rmb0`)
            await switchCpu('W65C02');
            const w65Text = ['.segment "CODE"', '  rmb0 $10', '  wai', '  stp', ''].join('\n');
            fs.writeFileSync(validPath, w65Text);
            publishedDiagnostics.delete(validUri);
            notify('textDocument/didChange', {
                textDocument: { uri: validUri, version: 2 },
                contentChanges: [{ text: w65Text }],
            });
            const diagsW65 = await waitForDiagnostics(publishedDiagnostics, validUri);
            assert.strictEqual(diagsW65.length, 0, `Expected 0 errors for W65C02 wai/stp/rmb0, got: ${JSON.stringify(diagsW65)}`);

            // Verify switching back to 6502 fails assembling W65C02 instructions
            await switchCpu('6502');
            const diagsFail6502 = await waitForDiagnostics(publishedDiagnostics, validUri, d => d.length > 0);
            assert(diagsFail6502.length > 0, 'Expected ca65 errors when assembling WAI/STP under 6502 CPU');
        }

        const fatalErrors = stderrLogs.filter(s => s.includes('Unhandled') || s.includes('TypeError'));
        assert.strictEqual(fatalErrors.length, 0, `Unexpected server errors: ${fatalErrors.join('\n')}`);

        console.log('ALL MULTI-CPU E2E CHECKS PASSED!');
    } finally {
        await harness.close();
        fs.rmSync(tmpRoot, { recursive: true, force: true });
    }
})();
