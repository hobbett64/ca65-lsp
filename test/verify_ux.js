const assert = require('assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { spawn } = require('child_process');
const { pathToFileURL } = require('url');

const serverEntry = path.resolve(process.cwd(), 'server/out/server.js');

(async () => {
    const tmpRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'ca65-ux-'));
    const incDir = path.join(tmpRoot, 'inc');
    fs.mkdirSync(incDir, { recursive: true });

    const defsPath = path.join(incDir, 'defs.inc');
    const varsPath = path.join(tmpRoot, 'vars.s');
    const mainPath = path.join(tmpRoot, 'main.s');

    const defsText = [
        '; Maximum player hit points',
        '; -------------------------',
        '.exportzp ZP_MAX_HP = 16',
        '; Player namespace',
        '.scope Player',
        '  ; Initializes player state',
        '  .proc init',
        '    lda #$00',
        '    rts',
        '  .endproc',
        '  hp = $42',
        '.endscope',
        '.enum GameState',
        '  STATE_IDLE',
        '.endenum',
        'counter_var .set 1',
    ].join('\n') + '\n';

    const varsText = [
        '.segment "ZEROPAGE"',
        '.export zp_counter',
        'zp_counter: .res 1',
        'zp_plain:',
        '',
        '.segment "BSS"',
        '.export bss_var',
        'bss_var: .res 1',
        '',
        '.segment "RODATA"',
        'ro_incbin:',
        '  .repeat 4',
        '    .byte 0',
        '  .endrepeat',
        '',
        '.segment "BANK01"',
        'bank_plain:',
        '  lda #$00',
        'bank_table:',
        '  .byte $01, $02',
    ].join('\n') + '\n';

    const mainText = [
        '.include "inc/defs.inc"',
        '.import zp_counter',
        '.importzp bss_var',
        '.macro FILL val',
        '  lda #val',
        '.endmacro',
        '.segment "ZEROPAGE"',
        'zp_local: .res 1',
        '.segment "CODE"',
        '; Updates player per frame',
        '.proc PlayerUpdate',
        '  lda #10',
        '  sta $2000',
        '@loop:',
        '  ; Loop delay target',
        '  dex',
        '  bne @loop',
        ':',
        '  ; Anon target',
        '  jsr Player::init',
        '  bne :-',
        '  beq :+',
        ':',
        '  rts',
        '.endproc',
        'main:',
        '  FILL $00',
        '  jsr PlayerUpdate',
        '  jmp PlayerUpdate',
        '  lda #ZP_MAX_HP',
        '  lda #GameState::STATE_IDLE',
        '  lda #counter_var',
        '  jsr Player::init',
        '.include "inc/',
    ].join('\n') + '\n';

    fs.writeFileSync(defsPath, defsText);
    fs.writeFileSync(varsPath, varsText);
    fs.writeFileSync(mainPath, mainText);

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
                            enableCa65StdErrDiagnostics: false,
                            enableUnusedSymbolDiagnostics: false,
                            includeDirs: ['inc'],
                            binIncludeDirs: [],
                            autoIncludeExtensions: ['.inc'],
                            anonymousLabelIndexHints: false,
                            importFromHints: true,
                            additionalExtensions: [],
                            smartFolding: true,
                            implicitImports: false,
                            lineContinuations: false,
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
            } else if (msg.method === 'textDocument/publishDiagnostics') {
                publishedDiagnostics.set(msg.params.uri, msg.params.diagnostics);
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
        const defsUri = pathToFileURL(defsPath).toString();
        const varsUri = pathToFileURL(varsPath).toString();
        const mainUri = pathToFileURL(mainPath).toString();

        const initResult = await request('initialize', {
            processId: process.pid,
            rootUri: wsUri,
            workspaceFolders: [{ uri: wsUri, name: 'ws' }],
            capabilities: {},
        });

        assert.deepStrictEqual(
            initResult.capabilities.completionProvider.triggerCharacters,
            ['.', '@', ':', '"', '/'],
            'Completion triggerCharacters should include ., @, :, ", /'
        );
        assert(!initResult.capabilities.codeLensProvider, 'codeLensProvider should not be advertised');
        assert(initResult.capabilities.semanticTokensProvider, 'semanticTokensProvider should be advertised');

        notify('initialized', {});
        notify('textDocument/didOpen', { textDocument: { uri: defsUri, languageId: 'ca65', version: 1, text: defsText } });
        notify('textDocument/didOpen', { textDocument: { uri: varsUri, languageId: 'ca65', version: 1, text: varsText } });
        notify('textDocument/didOpen', { textDocument: { uri: mainUri, languageId: 'ca65', version: 1, text: mainText } });

        // Wait for initial validation & publishDiagnostics debounce (500ms default)
        for (let i = 0; i < 30; i++) {
            if ((publishedDiagnostics.get(mainUri) || []).length >= 2) break;
            await new Promise(r => setTimeout(r, 100));
        }

        const lines = mainText.split('\n');

        // 1. Hover: clean symbol header `name \`SEGMENT\` = value` + verbatim doc comment + source link
        const constLine = lines.findIndex(l => l.includes('lda #ZP_MAX_HP'));
        const constHover = await request('textDocument/hover', {
            textDocument: { uri: mainUri },
            position: { line: constLine, character: lines[constLine].indexOf('ZP_MAX_HP') + 2 },
        });
        assert(constHover && constHover.contents && constHover.contents.value, 'Expected constant hover');
        const chVal = constHover.contents.value;
        assert(chVal.startsWith('`CONST` ZP\\_MAX\\_HP = `$10` (16)'), `Expected CONST constant header, got:\n${chVal}`);
        assert(chVal.includes('; Maximum player hit points\n; -------------------------'), 'Doc comment should stay verbatim in ca65 block');
        assert(chVal.includes(`Defined in [inc/defs.inc:3](${defsUri}#L3)`), `Expected clickable source link in hover, got:\n${chVal}`);

        // Hover enum member shows `ENUM` badge
        const enumLine = lines.findIndex(l => l.includes('GameState::STATE_IDLE'));
        const enumHover = await request('textDocument/hover', {
            textDocument: { uri: mainUri },
            position: { line: enumLine, character: lines[enumLine].indexOf('STATE_IDLE') + 2 },
        });
        assert(enumHover && enumHover.contents.value.startsWith('`ENUM` STATE\\_IDLE'), `Expected ENUM badge header, got:\n${enumHover && enumHover.contents.value}`);

        // Hover `.set` variable shows `VAR` badge
        const varLine = lines.findIndex(l => l.includes('counter_var'));
        const varHover = await request('textDocument/hover', {
            textDocument: { uri: mainUri },
            position: { line: varLine, character: lines[varLine].indexOf('counter_var') + 2 },
        });
        assert(varHover && varHover.contents.value.startsWith('`VAR` counter\\_var'), `Expected VAR badge header, got:\n${varHover && varHover.contents.value}`);

        // Hover imported ZP label shows `ZEROPAGE` badge to the left of symbol name
        const importZpLine = lines.findIndex(l => l.includes('.import zp_counter'));
        const importZpHover = await request('textDocument/hover', {
            textDocument: { uri: mainUri },
            position: { line: importZpLine, character: lines[importZpLine].indexOf('zp_counter') + 2 },
        });
        assert(importZpHover && importZpHover.contents.value.startsWith('`ZEROPAGE` zp\\_counter'), `Expected left ZEROPAGE badge, got:\n${importZpHover && importZpHover.contents.value}`);

        // Hover macro invocation shows `MACRO` badge to the left + args without dumping macro body
        const macroCallLine = lines.findIndex(l => l.includes('FILL $00'));
        const macroHover = await request('textDocument/hover', {
            textDocument: { uri: mainUri },
            position: { line: macroCallLine, character: lines[macroCallLine].indexOf('FILL') + 1 },
        });
        assert(macroHover && macroHover.contents.value.startsWith('`MACRO` FILL val'), `Expected MACRO badge + args, got:\n${macroHover && macroHover.contents.value}`);
        assert(!macroHover.contents.value.includes('lda #val'), 'Macro hover should not dump macro body');

        // Hover proc reference shows left segment pill without extra metadata line
        const jsrUpdateLine = lines.findIndex(l => l.includes('jsr PlayerUpdate'));
        const updateHover = await request('textDocument/hover', {
            textDocument: { uri: mainUri },
            position: { line: jsrUpdateLine, character: lines[jsrUpdateLine].indexOf('PlayerUpdate') + 2 },
        });
        assert(updateHover && updateHover.contents.value.includes('`CODE` .proc PlayerUpdate'), `Expected \`CODE\` .proc PlayerUpdate header, got:\n${updateHover && updateHover.contents.value}`);
        assert(!updateHover.contents.value.includes('*\\.proc*'), 'Should not include old metadata line underneath');

        // 2. Hover: cheap local label (@loop) & anonymous label (:+)
        const bneLocalLine = lines.findIndex(l => l.includes('bne @loop'));
        const localHover = await request('textDocument/hover', {
            textDocument: { uri: mainUri },
            position: { line: bneLocalLine, character: lines[bneLocalLine].indexOf('@loop') + 2 },
        });
        assert(localHover && localHover.contents.value.includes('`CODE` @loop'), `Expected \`CODE\` @loop header, got:\n${localHover && localHover.contents.value}`);

        const beqAnonLine = lines.findIndex(l => l.includes('beq :+'));
        const anonHover = await request('textDocument/hover', {
            textDocument: { uri: mainUri },
            position: { line: beqAnonLine, character: lines[beqAnonLine].indexOf(':+') + 1 },
        });
        assert(anonHover && anonHover.contents.value.includes('main.s:23'), `Expected resolved anon line in hover, got:\n${anonHover.contents.value}`);

        // 3. Hover: mnemonic table + seeAlso & directive type badge
        const ldaLine = lines.findIndex(l => l.includes('lda #10'));
        const ldaHover = await request('textDocument/hover', {
            textDocument: { uri: mainUri },
            position: { line: ldaLine, character: lines[ldaLine].indexOf('lda') + 1 },
        });
        assert(ldaHover && ldaHover.contents.value.includes('| Mode | Opcode | Bytes | Cycles |'), 'Expected mnemonic addressing-mode table');
        assert(ldaHover.contents.value.includes('**See also:**'), 'Expected seeAlso on mnemonic hover');

        const procLine = lines.findIndex(l => l.includes('.proc PlayerUpdate'));
        const procHover = await request('textDocument/hover', {
            textDocument: { uri: mainUri },
            position: { line: procLine, character: lines[procLine].indexOf('.proc') + 1 },
        });
        assert(procHover && procHover.contents.value.includes('*control command*'), 'Expected directive type badge');

        // 4. Outline: simplified (zp) and (macro) annotations, source order
        const symbols = await request('textDocument/documentSymbol', { textDocument: { uri: mainUri } });
        assert(Array.isArray(symbols) && symbols.length > 0, 'Expected document symbols');
        const zpSym = symbols.find(s => s.name === 'zp_local');
        assert(zpSym && zpSym.detail === '(zp)', `Expected detail (zp), got ${zpSym && zpSym.detail}`);
        const fillSym = symbols.find(s => s.name === 'FILL');
        assert(fillSym && fillSym.detail === '(macro)', `Expected (macro) outline detail, got ${fillSym && fillSym.detail}`);
        const updateSym = symbols.find(s => s.name === 'PlayerUpdate');
        assert(updateSym && updateSym.detail === undefined, `Expected no detail on CODE proc, got ${updateSym && updateSym.detail}`);
        for (let i = 1; i < symbols.length; i++) {
            assert(symbols[i].range.start.line >= symbols[i - 1].range.start.line, 'Root outline symbols must be in source order');
        }

        // Check vars.s Outline SymbolKind fallback by segment + directive override
        const varsSymbols = await request('textDocument/documentSymbol', { textDocument: { uri: varsUri } });
        const byName = new Map(varsSymbols.map(s => [s.name, s]));
        assert.strictEqual(byName.get('zp_plain').kind, 13, 'Plain label in ZEROPAGE should use Variable (13)');
        assert.strictEqual(byName.get('zp_plain').detail, '(zp)', 'ZEROPAGE label should have (zp) outline detail');
        assert.strictEqual(byName.get('ro_incbin').kind, 18, 'Plain label in RODATA without direct .byte should fall back to Array (18)');
        assert.strictEqual(byName.get('ro_incbin').detail, undefined, 'RODATA label should not repeat segment detail');
        assert.strictEqual(byName.get('bank_plain').kind, 15, 'Plain label in custom segment should fall back to String/abc (15)');
        assert.strictEqual(byName.get('bank_plain').detail, undefined, 'Custom segment label should not show segment detail');
        assert.strictEqual(byName.get('bank_table').kind, 18, 'Data directive in custom segment should still use Array (18)');

        // Check defs.inc child segment dedup (Player CODE -> init inherits CODE, no duplicate detail)
        const defsSymbols = await request('textDocument/documentSymbol', { textDocument: { uri: defsUri } });
        const playerOutline = defsSymbols.find(s => s.name === 'Player');
        assert(playerOutline && playerOutline.children.length >= 2, 'Expected Player children in outline');
        const initOutline = playerOutline.children.find(c => c.name === 'init');
        assert(initOutline && initOutline.detail === undefined, 'Child matching parent segment should not duplicate detail');

        // 5. Completions: Scope::, .include path, segment detail, lazy resolve
        const scopeLine = lines.findIndex(l => l.includes('jsr Player::init'));
        const scopeComp = await request('textDocument/completion', {
            textDocument: { uri: mainUri },
            position: { line: scopeLine, character: lines[scopeLine].indexOf('Player::') + 'Player::'.length },
        });
        const scopeItems = Array.isArray(scopeComp) ? scopeComp : scopeComp.items;
        assert(scopeItems.some(i => i.label === 'init') && scopeItems.some(i => i.label === 'hp'), 'Expected Player:: members');
        assert(!scopeItems.some(i => i.label === 'zp_counter'), 'Scope:: completion should not leak outer globals');
        const initItem = scopeItems.find(i => i.label === 'init');
        const resolvedInit = await request('completionItem/resolve', initItem);
        assert(resolvedInit.documentation && resolvedInit.documentation.value.includes('Initializes player state'), 'Expected lazy documentation on Scope:: item resolve');

        // Block-snippet directives should emit Snippet item ahead of non-snippet directives and demote fallback keyword
        const cmdComp = await request('textDocument/completion', {
            textDocument: { uri: mainUri },
            position: { line: procLine, character: lines[procLine].indexOf('.proc') + 2 },
        });
        const cmdItems = Array.isArray(cmdComp) ? cmdComp : cmdComp.items;
        const procSnippetItem = cmdItems.find(i => i.label === '.proc' && i.kind === 15);
        const procDirItem = cmdItems.find(i => i.label === '.proc' && i.kind === 14);
        const segDirItem = cmdItems.find(i => i.label === '.segment');
        assert(procSnippetItem && procSnippetItem.insertTextFormat === 2 && procSnippetItem.sortText.startsWith('2'), `Expected .proc snippet sortText 2..., got ${JSON.stringify(procSnippetItem)}`);
        assert(procSnippetItem.textEdit.newText.includes('.endproc'), 'Expected .proc snippet to include .endproc');
        assert(procDirItem && procDirItem.sortText.startsWith('9'), `Expected .proc directive sortText to be demoted (9...), got ${procDirItem && procDirItem.sortText}`);
        assert(segDirItem && segDirItem.sortText.startsWith('3'), `Expected .segment directive sortText 3..., got ${segDirItem && segDirItem.sortText}`);

        const incLine = lines.findIndex(l => l === '.include "inc/');
        const incComp = await request('textDocument/completion', {
            textDocument: { uri: mainUri },
            position: { line: incLine, character: lines[incLine].length },
        });
        const incItems = Array.isArray(incComp) ? incComp : incComp.items;
        assert(incItems.some(i => i.label === 'defs.inc'), `Expected defs.inc path completion inside .include "inc/, got ${incItems.map(i => i.label).join(', ')}`);

        const opLine = lines.findIndex(l => l.includes('lda #ZP_MAX_HP'));
        const symComp = await request('textDocument/completion', {
            textDocument: { uri: mainUri },
            position: { line: opLine, character: lines[opLine].indexOf('ZP_MAX_HP') },
        });
        const symItems = Array.isArray(symComp) ? symComp : symComp.items;
        const zpItem = symItems.find(i => i.label === 'zp_local');
        assert(zpItem && zpItem.detail === 'res label · ZEROPAGE', `Expected segment detail on symbol completion, got ${zpItem && zpItem.detail}`);
        const resolvedZpItem = await request('completionItem/resolve', zpItem);
        assert(resolvedZpItem.documentation && resolvedZpItem.documentation.value.includes('Defined in'), 'Expected lazy doc resolution on symbol completion');

        // Suppressed noisy completion contexts
        const declNameComp = await request('textDocument/completion', {
            textDocument: { uri: mainUri },
            position: { line: procLine, character: lines[procLine].indexOf('PlayerUpdate') + 4 },
        });
        assert.strictEqual((Array.isArray(declNameComp) ? declNameComp : declNameComp.items).length, 0, 'Should suppress completions while naming .proc');

        const commentLineIdx = lines.findIndex(l => l.includes('; Updates player per frame'));
        const commentComp = await request('textDocument/completion', {
            textDocument: { uri: mainUri },
            position: { line: commentLineIdx, character: lines[commentLineIdx].length },
        });
        assert.strictEqual((Array.isArray(commentComp) ? commentComp : commentComp.items).length, 0, 'Should suppress completions inside comments');

        const hexLineIdx = lines.findIndex(l => l.includes('sta $2000'));
        const hexComp = await request('textDocument/completion', {
            textDocument: { uri: mainUri },
            position: { line: hexLineIdx, character: lines[hexLineIdx].indexOf('2000') + 2 },
        });
        assert.strictEqual((Array.isArray(hexComp) ? hexComp : hexComp.items).length, 0, 'Should suppress completions inside numeric literals');

        const labelLineIdx = lines.findIndex(l => l === 'main:');
        const labelComp = await request('textDocument/completion', {
            textDocument: { uri: mainUri },
            position: { line: labelLineIdx, character: lines[labelLineIdx].length },
        });
        assert.strictEqual((Array.isArray(labelComp) ? labelComp : labelComp.items).length, 0, 'Should suppress completions right after label colon');

        // 6. .import / .export ZP mismatch diagnostics + Quick Fixes
        const mainDiags = publishedDiagnostics.get(mainUri) || [];
        const zpExpectedDiag = mainDiags.find(d => d.code === 'import-zp-expected');
        const absExpectedDiag = mainDiags.find(d => d.code === 'import-abs-expected');
        assert(zpExpectedDiag && zpExpectedDiag.source === 'ca65-lsp' && zpExpectedDiag.severity === 2, 'Expected import-zp-expected warning on .import zp_counter');
        assert(absExpectedDiag && absExpectedDiag.source === 'ca65-lsp' && absExpectedDiag.severity === 2, 'Expected import-abs-expected warning on .importzp bss_var');

        const fixesZp = await request('textDocument/codeAction', {
            textDocument: { uri: mainUri },
            range: zpExpectedDiag.range,
            context: { diagnostics: [zpExpectedDiag], only: ['quickfix'] },
        });
        assert(
            fixesZp.some(a => a.isPreferred && a.title.includes('.importzp') && a.edit.changes[mainUri][0].newText === '.importzp'),
            'Expected preferred Quick Fix changing .import to .importzp'
        );

        const fixesAbs = await request('textDocument/codeAction', {
            textDocument: { uri: mainUri },
            range: absExpectedDiag.range,
            context: { diagnostics: [absExpectedDiag], only: ['quickfix'] },
        });
        assert(
            fixesAbs.some(a => a.isPreferred && a.title.includes('.import') && a.edit.changes[mainUri][0].newText === '.import'),
            'Expected preferred Quick Fix changing .importzp to .import'
        );

        // 7. Semantic Tokens
        const semTokens = await request('textDocument/semanticTokens/full', { textDocument: { uri: mainUri } });
        assert(semTokens && Array.isArray(semTokens.data) && semTokens.data.length > 0 && semTokens.data.length % 5 === 0, 'Expected valid semantic tokens');

        // 8. prepareRename & cheap local rename normalization
        const prepValid = await request('textDocument/prepareRename', {
            textDocument: { uri: mainUri },
            position: { line: procLine, character: lines[procLine].indexOf('PlayerUpdate') + 2 },
        });
        assert(prepValid && prepValid.placeholder === 'PlayerUpdate', `Expected prepareRename placeholder PlayerUpdate, got ${JSON.stringify(prepValid)}`);

        const bneLoopLine = lines.findIndex(l => l.includes('bne @loop'));
        const prepCheap = await request('textDocument/prepareRename', {
            textDocument: { uri: mainUri },
            position: { line: bneLoopLine, character: lines[bneLoopLine].indexOf('@loop') + 2 },
        });
        assert(prepCheap && prepCheap.placeholder === '@loop', `Expected prepareRename placeholder @loop, got ${JSON.stringify(prepCheap)}`);

        const renameCheap = await request('textDocument/rename', {
            textDocument: { uri: mainUri },
            position: { line: bneLoopLine, character: lines[bneLoopLine].indexOf('@loop') + 2 },
            newName: 'retry',
        });
        assert(
            renameCheap && renameCheap.changes[mainUri].length === 2 && renameCheap.changes[mainUri].every(e => e.newText === '@retry'),
            `Expected cheap local rename without @ to normalize to @retry, got ${JSON.stringify(renameCheap)}`
        );

        const prepMnemonic = await request('textDocument/prepareRename', {
            textDocument: { uri: mainUri },
            position: { line: hexLineIdx, character: lines[hexLineIdx].indexOf('sta') + 1 },
        });
        assert.strictEqual(prepMnemonic, null, 'prepareRename on mnemonic should return null');

        const prepComment = await request('textDocument/prepareRename', {
            textDocument: { uri: mainUri },
            position: { line: commentLineIdx, character: lines[commentLineIdx].length - 2 },
        });
        assert.strictEqual(prepComment, null, 'prepareRename inside comment should return null');

        console.log('ALL UX IMPROVEMENT E2E CHECKS PASSED!');
    } finally {
        try { await request('shutdown', null); notify('exit', null); } catch {}
        proc.kill();
        fs.rmSync(tmpRoot, { recursive: true, force: true });
    }
})().catch((err) => {
    console.error(err);
    process.exit(1);
});
