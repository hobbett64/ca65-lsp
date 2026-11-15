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
    const binPath = path.join(tmpRoot, 'asset.bin');
    fs.writeFileSync(binPath, Buffer.alloc(12, 0xAA));

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
        '.struct OneByte',
        '  bits .byte',
        '.endstruct',
        '.union OneUnion',
        '  flag .res 1',
        '.endunion',
        '.struct Vec2',
        '  x .byte',
        '  y .byte',
        '.endstruct',
        '.struct Entity',
        '  pos .tag Vec2',
        '  hp .word',
        '  words .word 2',
        '  buf .res 4',
        '.endstruct',
        '.union Variant',
        '  bytes .byte 4',
        '  word_val .word',
        '.endunion',
    ].join('\n') + '\n';

    const varsText = [
        '.segment "ZEROPAGE"',
        '@zp_top: .res 1',
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
        '',
        '.segment "DIRECTPAGE"',
        'dp_plain:',
        '',
        '.segment "RODATA"',
        'lo_ptrs:',
        '  .lobytes zp_counter, bss_var, \\',
        '           ro_incbin, bank_table',
        'hi_ptrs:',
        '  .hibytes zp_counter, bss_var, ro_incbin',
        'bank_ptrs:',
        '  .bankbytes zp_counter, bss_var',
        'word_tbl:',
        '  .word $1000, $2000',
        'addr_tbl:',
        '  .addr ro_incbin, bank_table',
        'dbyt_tbl:',
        '  .dbyt $1234, $5678',
        'far_tbl:',
        '  .faraddr ro_incbin, bank_table',
        'dw_tbl:',
        '  .dword $11223344, $55667788',
        'msg_z:',
        '  .asciiz "Hi"',
        'msg_lit:',
        '  .literal "ABC"',
        'single_b:',
        '  .byte $FF',
        'bin_full:',
        '  .incbin "asset.bin"',
        'bin_slice:',
        '  .incbin "asset.bin", 2, 5',
    ].join('\n') + '\n';

    const mainText = [
        '.include "inc/defs.inc"',
        '.import zp_counter',
        '.importzp bss_var',
        '.macro FILL val',
        '  lda #val',
        '.endmacro',
        '.segment "ZEROPAGE"',
        'zp_local: .res ZP_MAX_HP',
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
        '  jsr helper_sub',
        'helper_sub:',
        '  rts',
        '.segment "BSS"',
        'ent_one: .tag Entity',
        'ent_arr: .res .sizeof(Entity) * 2',
        'flag_one: .tag OneByte',
        '.segment "CODE"',
        '.scope myscope',
        'mylabel:',
        '  lda #1',
        '@mylocallabel:',
        '  bne @mylocallabel',
        '  rts',
        '.endscope',
        '.segment "ZEROPAGE"',
        'zp_parent:',
        '@zp_byte: .res 1',
        '@zp_pair: .res 2',
        '.segment "RODATA"',
        'ro_parent:',
        '@ro_bytes:',
        '  .byte $10, $20, $30',
        '.segment "CODE"',
        '.pushseg',
        '.segment "RODATA"',
        'pushed_ro:',
        '@temp_ro: .byte $AA',
        '.popseg',
        'after_popseg:',
        '  lda #1',
        '@back_to_code:',
        '  bne @back_to_code',
        '.proc NestedProc',
        'inner_proc_lbl:',
        '  lda #$ADC',
        '  ora #%10010000',
        '  cmp #$41',
        '  rts',
        '.endproc',
        '.include "inc/',
        'tag_incomplete: .tag ',
        'sizeof_incomplete: .res .sizeof(Ent',
        '.segment "',
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
        assert(chVal.startsWith('const **ZP\\_MAX\\_HP** = `$10` (16)'), `Expected const constant header, got:\n${chVal}`);
        assert(chVal.includes('; Maximum player hit points\n; -------------------------'), 'Doc comment should stay verbatim in ca65 block');
        assert(chVal.includes(`Defined in [inc/defs.inc:3](${defsUri}#L3)`), `Expected clickable source link in hover, got:\n${chVal}`);

        // Hover enum member shows enum badge and qualified name with bold leaf
        const enumLine = lines.findIndex(l => l.includes('GameState::STATE_IDLE'));
        const enumHover = await request('textDocument/hover', {
            textDocument: { uri: mainUri },
            position: { line: enumLine, character: lines[enumLine].indexOf('STATE_IDLE') + 2 },
        });
        assert(enumHover && enumHover.contents.value.startsWith('enum GameState::**STATE\\_IDLE**'), `Expected enum badge header, got:\n${enumHover && enumHover.contents.value}`);

        // Hover `.set` variable shows var badge
        const varLine = lines.findIndex(l => l.includes('counter_var'));
        const varHover = await request('textDocument/hover', {
            textDocument: { uri: mainUri },
            position: { line: varLine, character: lines[varLine].indexOf('counter_var') + 2 },
        });
        assert(varHover && varHover.contents.value.startsWith('var **counter\\_var**'), `Expected var badge header, got:\n${varHover && varHover.contents.value}`);

        // Hover imported ZP label with `.res 1` includes ZEROPAGE, label badge, and `[1]` size suffix
        const importZpLine = lines.findIndex(l => l.includes('.import zp_counter'));
        const importZpHover = await request('textDocument/hover', {
            textDocument: { uri: mainUri },
            position: { line: importZpLine, character: lines[importZpLine].indexOf('zp_counter') + 2 },
        });
        assert(importZpHover && importZpHover.contents.value.startsWith('`ZEROPAGE` label **zp\\_counter** [1]\n'), `Expected ZEROPAGE label badge with [1] for size 1, got:\n${importZpHover && importZpHover.contents.value}`);

        // Hover `.res <CONSTANT>` label resolves constant from included file (`ZP_MAX_HP = 16`)
        const zpLocalLine = lines.findIndex(l => l.includes('zp_local: .res ZP_MAX_HP'));
        const zpLocalHover = await request('textDocument/hover', {
            textDocument: { uri: mainUri },
            position: { line: zpLocalLine, character: lines[zpLocalLine].indexOf('zp_local') + 2 },
        });
        assert(zpLocalHover && zpLocalHover.contents.value.startsWith('`ZEROPAGE` label **zp\\_local** [16]'), `Expected [16] after symbol from constant ZP_MAX_HP, got:\n${zpLocalHover && zpLocalHover.contents.value}`);

        // Hover RODATA / data array labels shows evaluated byte count `[N]`
        const varsLines = varsText.split('\n');
        const roIncbinLine = varsLines.findIndex(l => l.startsWith('ro_incbin:'));
        const roIncbinHover = await request('textDocument/hover', {
            textDocument: { uri: varsUri },
            position: { line: roIncbinLine, character: 2 },
        });
        assert(roIncbinHover && roIncbinHover.contents.value.startsWith('`RODATA` label **ro\\_incbin** [4]'), `Expected [4] on .repeat 4 .byte 0 label, got:\n${roIncbinHover && roIncbinHover.contents.value}`);

        const bankTableLine = varsLines.findIndex(l => l.startsWith('bank_table:'));
        const bankTableHover = await request('textDocument/hover', {
            textDocument: { uri: varsUri },
            position: { line: bankTableLine, character: 2 },
        });
        assert(bankTableHover && bankTableHover.contents.value.startsWith('`BANK01` label **bank\\_table** [2]'), `Expected [2] on .byte $01, $02 label, got:\n${bankTableHover && bankTableHover.contents.value}`);

        const expectedVarsSizes = [
            ['lo_ptrs:', '`RODATA` label **lo\\_ptrs** [4]'],
            ['hi_ptrs:', '`RODATA` label **hi\\_ptrs** [3]'],
            ['bank_ptrs:', '`RODATA` label **bank\\_ptrs** [2]'],
            ['word_tbl:', '`RODATA` label **word\\_tbl** [4]'],
            ['addr_tbl:', '`RODATA` label **addr\\_tbl** [4]'],
            ['dbyt_tbl:', '`RODATA` label **dbyt\\_tbl** [4]'],
            ['far_tbl:', '`RODATA` label **far\\_tbl** [6]'],
            ['dw_tbl:', '`RODATA` label **dw\\_tbl** [8]'],
            ['msg_z:', '`RODATA` label **msg\\_z** [3]'],
            ['msg_lit:', '`RODATA` label **msg\\_lit** [3]'],
            ['single_b:', '`RODATA` label **single\\_b** [1]\n'],
            ['bin_full:', '`RODATA` label **bin\\_full** [12]'],
            ['bin_slice:', '`RODATA` label **bin\\_slice** [5]'],
            ['bank_plain:', '`BANK01` label **bank\\_plain**\n'],
        ];
        for (const [labelPrefix, expectedStart] of expectedVarsSizes) {
            const ln = varsLines.findIndex(l => l.startsWith(labelPrefix));
            const hv = await request('textDocument/hover', {
                textDocument: { uri: varsUri },
                position: { line: ln, character: 2 },
            });
            assert(hv && hv.contents.value.startsWith(expectedStart), `Expected ${JSON.stringify(expectedStart)} for ${labelPrefix}, got:\n${hv && hv.contents.value}`);
        }

        // Hover `.tag Entity`, `.tag OneByte`, `.res .sizeof(Entity) * 2`, `.struct`/`.union`, and struct fields
        const entOneLine = lines.findIndex(l => l.startsWith('ent_one:'));
        const entOneHover = await request('textDocument/hover', {
            textDocument: { uri: mainUri },
            position: { line: entOneLine, character: 2 },
        });
        assert(entOneHover && entOneHover.contents.value.startsWith('`BSS` label **ent\\_one** [12]'), `Expected [12] for .tag Entity, got:\n${entOneHover && entOneHover.contents.value}`);

        const entityStructHover = await request('textDocument/hover', {
            textDocument: { uri: mainUri },
            position: { line: entOneLine, character: lines[entOneLine].indexOf('Entity') + 2 },
        });
        assert(entityStructHover && entityStructHover.contents.value.startsWith('struct **Entity** [12]'), `Expected [12] for struct Entity, got:\n${entityStructHover && entityStructHover.contents.value}`);

        const defsLines = defsText.split('\n');
        const variantLine = defsLines.findIndex(l => l.includes('.union Variant'));
        const variantHover = await request('textDocument/hover', {
            textDocument: { uri: defsUri },
            position: { line: variantLine, character: defsLines[variantLine].indexOf('Variant') + 2 },
        });
        assert(variantHover && variantHover.contents.value.startsWith('union **Variant** [4]'), `Expected [4] for union Variant, got:\n${variantHover && variantHover.contents.value}`);

        const oneByteLine = defsLines.findIndex(l => l.includes('.struct OneByte'));
        const oneByteHover = await request('textDocument/hover', {
            textDocument: { uri: defsUri },
            position: { line: oneByteLine, character: defsLines[oneByteLine].indexOf('OneByte') + 2 },
        });
        assert(oneByteHover && oneByteHover.contents.value.startsWith('struct **OneByte** [1]'), `Expected [1] for struct OneByte, got:\n${oneByteHover && oneByteHover.contents.value}`);

        const oneUnionLine = defsLines.findIndex(l => l.includes('.union OneUnion'));
        const oneUnionHover = await request('textDocument/hover', {
            textDocument: { uri: defsUri },
            position: { line: oneUnionLine, character: defsLines[oneUnionLine].indexOf('OneUnion') + 2 },
        });
        assert(oneUnionHover && oneUnionHover.contents.value.startsWith('union **OneUnion** [1]'), `Expected [1] for union OneUnion, got:\n${oneUnionHover && oneUnionHover.contents.value}`);

        const expectedDefFieldSizes = [
            ['bits .byte', 'bits', 'field byte OneByte::**bits** [1]'],
            ['flag .res 1', 'flag', 'field OneUnion::**flag** [1]'],
            ['pos .tag Vec2', 'pos', 'field tag Vec2 Entity::**pos** [2]'],
            ['hp .word', 'hp', 'field word Entity::**hp** [2]'],
            ['words .word 2', 'words', 'field word Entity::**words** [4]'],
            ['buf .res 4', 'buf', 'field Entity::**buf** [4]'],
        ];
        for (const [needle, ident, expectedStart] of expectedDefFieldSizes) {
            const ln = defsLines.findIndex(l => l.includes(needle));
            const hv = await request('textDocument/hover', {
                textDocument: { uri: defsUri },
                position: { line: ln, character: defsLines[ln].indexOf(ident) + 1 },
            });
            assert(hv && hv.contents.value.startsWith(expectedStart), `Expected ${JSON.stringify(expectedStart)} for field ${ident}, got:\n${hv && hv.contents.value}`);
        }

        const flagOneLine = lines.findIndex(l => l.startsWith('flag_one:'));
        const flagOneHover = await request('textDocument/hover', {
            textDocument: { uri: mainUri },
            position: { line: flagOneLine, character: 2 },
        });
        assert(flagOneHover && flagOneHover.contents.value.startsWith('`BSS` label **flag\\_one** [1]'), `Expected [1] for .tag OneByte, got:\n${flagOneHover && flagOneHover.contents.value}`);

        const entArrLine = lines.findIndex(l => l.startsWith('ent_arr:'));
        const entArrHover = await request('textDocument/hover', {
            textDocument: { uri: mainUri },
            position: { line: entArrLine, character: 2 },
        });
        assert(entArrHover && entArrHover.contents.value.startsWith('`BSS` label **ent\\_arr** [24]'), `Expected [24] for .res .sizeof(Entity) * 2, got:\n${entArrHover && entArrHover.contents.value}`);

        // Hover macro invocation shows macro badge to the left + args without dumping macro body
        const macroCallLine = lines.findIndex(l => l.includes('FILL $00'));
        const macroHover = await request('textDocument/hover', {
            textDocument: { uri: mainUri },
            position: { line: macroCallLine, character: lines[macroCallLine].indexOf('FILL') + 1 },
        });
        assert(macroHover && macroHover.contents.value.startsWith('macro **FILL** val'), `Expected macro badge + args, got:\n${macroHover && macroHover.contents.value}`);
        assert(!macroHover.contents.value.includes('lda #val'), 'Macro hover should not dump macro body');

        // Hover proc & regular label references show left segment pill and proc/label badge
        const jsrUpdateLine = lines.findIndex(l => l.includes('jsr PlayerUpdate'));
        const updateHover = await request('textDocument/hover', {
            textDocument: { uri: mainUri },
            position: { line: jsrUpdateLine, character: lines[jsrUpdateLine].indexOf('PlayerUpdate') + 2 },
        });
        assert(updateHover && updateHover.contents.value.includes('`CODE` proc **PlayerUpdate**'), `Expected \`CODE\` proc **PlayerUpdate** header, got:\n${updateHover && updateHover.contents.value}`);
        assert(!updateHover.contents.value.includes('*\\.proc*'), 'Should not include old metadata line underneath');

        const jsrHelperLine = lines.findIndex(l => l.includes('jsr helper_sub'));
        const helperHover = await request('textDocument/hover', {
            textDocument: { uri: mainUri },
            position: { line: jsrHelperLine, character: lines[jsrHelperLine].indexOf('helper_sub') + 2 },
        });
        assert(helperHover && helperHover.contents.value.startsWith('`CODE` label **helper\\_sub**\n'), `Expected \`CODE\` label **helper\\_sub** header, got:\n${helperHover && helperHover.contents.value}`);

        // Hover scope and enum references show unstyled scope and enum badges
        const jsrPlayerInitLine = lines.findIndex(l => l.includes('jsr Player::init'));
        const scopeHover = await request('textDocument/hover', {
            textDocument: { uri: mainUri },
            position: { line: jsrPlayerInitLine, character: lines[jsrPlayerInitLine].indexOf('Player') + 2 },
        });
        assert(scopeHover && scopeHover.contents.value.startsWith('scope **Player**'), `Expected scope **Player** header, got:\n${scopeHover && scopeHover.contents.value}`);

        const enumScopeHover = await request('textDocument/hover', {
            textDocument: { uri: mainUri },
            position: { line: enumLine, character: lines[enumLine].indexOf('GameState') + 2 },
        });
        assert(enumScopeHover && enumScopeHover.contents.value.startsWith('enum **GameState**'), `Expected enum **GameState** header, got:\n${enumScopeHover && enumScopeHover.contents.value}`);

        // 2. Hover: cheap local labels (@loop, scoped myscope::mylabel@mylocallabel, root @zp_top, ZEROPAGE/RODATA/[size], pushseg/popseg) & anonymous label (:+)
        const bneLocalLine = lines.findIndex(l => l.includes('bne @loop'));
        const localHover = await request('textDocument/hover', {
            textDocument: { uri: mainUri },
            position: { line: bneLocalLine, character: lines[bneLocalLine].indexOf('@loop') + 2 },
        });
        assert(localHover && localHover.contents.value.includes('`CODE` label PlayerUpdate**\u2060@loop**\n'), `Expected \`CODE\` label PlayerUpdate**\u2060@loop** header, got:\n${localHover && localHover.contents.value}`);

        const zpTopLine = varsLines.findIndex(l => l.startsWith('@zp_top:'));
        const zpTopHover = await request('textDocument/hover', {
            textDocument: { uri: varsUri },
            position: { line: zpTopLine, character: 2 },
        });
        assert(zpTopHover && zpTopHover.contents.value.startsWith('`ZEROPAGE` label **@zp\\_top** [1]\n'), `Expected root cheap local bolding @, got:\n${zpTopHover && zpTopHover.contents.value}`);

        const expectedCheapLocalHovers = [
            ['bne @mylocallabel', '@mylocallabel', '`CODE` label myscope::mylabel**\u2060@mylocallabel**\n'],
            ['@zp_byte: .res 1', '@zp_byte', '`ZEROPAGE` label zp\\_parent**\u2060@zp\\_byte** [1]\n'],
            ['@zp_pair: .res 2', '@zp_pair', '`ZEROPAGE` label zp\\_parent**\u2060@zp\\_pair** [2]\n'],
            ['@ro_bytes:', '@ro_bytes', '`RODATA` label ro\\_parent**\u2060@ro\\_bytes** [3]\n'],
            ['@temp_ro: .byte $AA', '@temp_ro', '`RODATA` label pushed\\_ro**\u2060@temp\\_ro** [1]\n'],
            ['bne @back_to_code', '@back_to_code', '`CODE` label after\\_popseg**\u2060@back\\_to\\_code**\n'],
        ];
        for (const [needle, ident, expectedStart] of expectedCheapLocalHovers) {
            const ln = lines.findIndex(l => l.includes(needle));
            const hv = await request('textDocument/hover', {
                textDocument: { uri: mainUri },
                position: { line: ln, character: lines[ln].indexOf(ident) + 2 },
            });
            assert(hv && hv.contents.value.startsWith(expectedStart), `Expected ${JSON.stringify(expectedStart)} for ${ident}, got:\n${hv && hv.contents.value}`);
        }

        const bneAnonLine = lines.findIndex(l => l.includes('bne :-'));
        const prevAnonHover = await request('textDocument/hover', {
            textDocument: { uri: mainUri },
            position: { line: bneAnonLine, character: lines[bneAnonLine].indexOf(':-') + 1 },
        });
        assert(prevAnonHover && prevAnonHover.contents.value.startsWith('`CODE` anonymous label **1**\n'), `Expected CODE anonymous label 1 header, got:\n${prevAnonHover && prevAnonHover.contents.value}`);

        const beqAnonLine = lines.findIndex(l => l.includes('beq :+'));
        const anonHover = await request('textDocument/hover', {
            textDocument: { uri: mainUri },
            position: { line: beqAnonLine, character: lines[beqAnonLine].indexOf(':+') + 1 },
        });
        assert(anonHover && anonHover.contents.value.startsWith('`CODE` anonymous label **2**\n'), `Expected CODE anonymous label 2 header, got:\n${anonHover && anonHover.contents.value}`);
        assert(anonHover && anonHover.contents.value.includes('main.s:23'), `Expected resolved anon line in hover, got:\n${anonHover.contents.value}`);

        // 3. Hover: mnemonic table & directive type badge
        const ldaLine = lines.findIndex(l => l.includes('lda #10'));
        const ldaHover = await request('textDocument/hover', {
            textDocument: { uri: mainUri },
            position: { line: ldaLine, character: lines[ldaLine].indexOf('lda') + 1 },
        });
        assert(ldaHover && ldaHover.contents.value.includes('| Mode | Opcode | Bytes | Cycles |'), 'Expected mnemonic addressing-mode table');
        assert(!ldaHover.contents.value.includes('**See also:**'), 'Should not include seeAlso on mnemonic hover');

        // 3b. Number literal hovers (dec, hex with mnemonic-like digits $ADC, bin)
        const decLitHover = await request('textDocument/hover', {
            textDocument: { uri: mainUri },
            position: { line: ldaLine, character: lines[ldaLine].indexOf('10') },
        });
        assert(
            decLitHover && decLitHover.contents.value === 'number **10**\n\nHex: `$0A` · Dec: `10` · Bin: `%00001010`',
            `Unexpected dec number hover: ${decLitHover && decLitHover.contents.value}`
        );

        const hexAdcLine = lines.findIndex(l => l.includes('lda #$ADC'));
        const hexAdcHover = await request('textDocument/hover', {
            textDocument: { uri: mainUri },
            position: { line: hexAdcLine, character: lines[hexAdcLine].indexOf('ADC') + 1 },
        });
        assert(
            hexAdcHover && hexAdcHover.contents.value === 'number **$ADC**\n\nHex: `$0ADC` · Dec: `2780` · Bin: `%0000101011011100`',
            `Expected $ADC to hover as hex number rather than mnemonic, got: ${hexAdcHover && hexAdcHover.contents.value}`
        );

        const binLine = lines.findIndex(l => l.includes('ora #%10010000'));
        const binHover = await request('textDocument/hover', {
            textDocument: { uri: mainUri },
            position: { line: binLine, character: lines[binLine].indexOf('%10010000') + 2 },
        });
        assert(
            binHover && binHover.contents.value === 'number **%10010000**\n\nHex: `$90` · Dec: `144` · Bin: `%10010000`',
            `Unexpected binary number hover: ${binHover && binHover.contents.value}`
        );

        const procLine = lines.findIndex(l => l.includes('.proc PlayerUpdate'));
        const procHover = await request('textDocument/hover', {
            textDocument: { uri: mainUri },
            position: { line: procLine, character: lines[procLine].indexOf('.proc') + 1 },
        });
        assert(procHover && procHover.contents.value.includes('*control command*'), 'Expected directive type badge');

        // 4. Outline: non-CODE (<SEGMENT>) and (macro) annotations, source order, and CODE suppression
        const symbols = await request('textDocument/documentSymbol', { textDocument: { uri: mainUri } });
        assert(Array.isArray(symbols) && symbols.length > 0, 'Expected document symbols');
        const zpSym = symbols.find(s => s.name === 'zp_local');
        assert(zpSym && zpSym.detail === '(ZEROPAGE)', `Expected detail (ZEROPAGE), got ${zpSym && zpSym.detail}`);
        const fillSym = symbols.find(s => s.name === 'FILL');
        assert(fillSym && fillSym.detail === '(macro)', `Expected (macro) outline detail, got ${fillSym && fillSym.detail}`);
        const updateSym = symbols.find(s => s.name === 'PlayerUpdate');
        assert(updateSym && updateSym.detail === undefined, `Expected no detail on CODE proc, got ${updateSym && updateSym.detail}`);
        const helperOutline = symbols.find(s => s.name === 'helper_sub');
        assert(helperOutline && helperOutline.detail === undefined, `Expected no detail on CODE label, got ${helperOutline && helperOutline.detail}`);
        const nestedProc = symbols.find(s => s.name === 'NestedProc');
        assert(nestedProc && nestedProc.detail === undefined && nestedProc.children && nestedProc.children.length > 0, 'Expected NestedProc in CODE with children');
        const innerProcLabel = nestedProc.children.find(c => c.name === 'inner_proc_lbl');
        assert(innerProcLabel && innerProcLabel.detail === undefined, `Child in CODE should not show detail, got ${innerProcLabel && innerProcLabel.detail}`);
        for (let i = 1; i < symbols.length; i++) {
            assert(symbols[i].range.start.line >= symbols[i - 1].range.start.line, 'Root outline symbols must be in source order');
        }

        // Check vars.s Outline SymbolKind fallback by segment + actual segment name detail
        const varsSymbols = await request('textDocument/documentSymbol', { textDocument: { uri: varsUri } });
        const byName = new Map(varsSymbols.map(s => [s.name, s]));
        assert.strictEqual(byName.get('zp_plain').kind, 13, 'Plain label in ZEROPAGE should use Variable (13)');
        assert.strictEqual(byName.get('zp_plain').detail, '(ZEROPAGE)', 'ZEROPAGE label should have (ZEROPAGE) outline detail');
        assert.strictEqual(byName.get('dp_plain').kind, 13, 'Plain label in DIRECTPAGE should use Variable (13)');
        assert.strictEqual(byName.get('dp_plain').detail, '(DIRECTPAGE)', 'DIRECTPAGE label should have (DIRECTPAGE) outline detail');
        assert.strictEqual(byName.get('ro_incbin').kind, 18, 'Plain label in RODATA without direct .byte should fall back to Array (18)');
        assert.strictEqual(byName.get('ro_incbin').detail, '(RODATA)', 'RODATA label should have (RODATA) outline detail');
        assert.strictEqual(byName.get('bank_plain').kind, 15, 'Plain label in custom segment should fall back to String/abc (15)');
        assert.strictEqual(byName.get('bank_plain').detail, '(BANK01)', 'Custom segment label should have (BANK01) outline detail');
        assert.strictEqual(byName.get('bank_table').kind, 18, 'Data directive in custom segment should still use Array (18)');

        // Check defs.inc .scope -> child .proc in CODE keeps detail suppressed
        const defsSymbols = await request('textDocument/documentSymbol', { textDocument: { uri: defsUri } });
        const playerOutline = defsSymbols.find(s => s.name === 'Player');
        assert(playerOutline && playerOutline.children.length >= 2, 'Expected Player children in outline');
        const initOutline = playerOutline.children.find(c => c.name === 'init');
        assert(initOutline && initOutline.detail === undefined, `Expected child .proc init in CODE to omit detail, got ${initOutline && initOutline.detail}`);

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

        const tagCompLine = lines.findIndex(l => l === 'tag_incomplete: .tag ');
        const tagComp = await request('textDocument/completion', {
            textDocument: { uri: mainUri },
            position: { line: tagCompLine, character: lines[tagCompLine].length },
        });
        const tagItems = Array.isArray(tagComp) ? tagComp : tagComp.items;
        assert(
            tagItems.some(i => i.label === 'Entity') && tagItems.some(i => i.label === 'Vec2') && tagItems.some(i => i.label === 'Variant'),
            `Expected struct/union completions after .tag, got ${tagItems.map(i => i.label).join(', ')}`
        );
        assert(!tagItems.some(i => i.label === 'PlayerUpdate' || i.label === 'ZP_MAX_HP'), '.tag should omit non-struct/union symbols');

        const sizeofCompLine = lines.findIndex(l => l === 'sizeof_incomplete: .res .sizeof(Ent');
        const sizeofComp = await request('textDocument/completion', {
            textDocument: { uri: mainUri },
            position: { line: sizeofCompLine, character: lines[sizeofCompLine].length },
        });
        const sizeofItems = Array.isArray(sizeofComp) ? sizeofComp : sizeofComp.items;
        const sizeofEntity = sizeofItems.find(i => i.label === 'Entity');
        assert(sizeofEntity && sizeofEntity.textEdit && sizeofEntity.textEdit.range.start.character === lines[sizeofCompLine].indexOf('Ent'), 'Expected .sizeof( completion with accurate replacement range');
        assert(!sizeofItems.some(i => i.label === 'PlayerUpdate' || i.label === 'helper_sub'), '.sizeof( should omit plain labels/procs');

        const segCompLine = lines.findIndex(l => l === '.segment "');
        const segComp = await request('textDocument/completion', {
            textDocument: { uri: mainUri },
            position: { line: segCompLine, character: lines[segCompLine].length },
        });
        const segItems = Array.isArray(segComp) ? segComp : segComp.items;
        for (const expectedSeg of ['CODE', 'ZEROPAGE', 'RODATA', 'BSS', 'DATA', 'BANK01', 'DIRECTPAGE']) {
            assert(segItems.some(i => i.label === expectedSeg), `Expected segment completion ${expectedSeg}, got ${segItems.map(i => i.label).join(', ')}`);
        }

        const opLine = lines.findIndex(l => l.includes('lda #ZP_MAX_HP'));
        const symComp = await request('textDocument/completion', {
            textDocument: { uri: mainUri },
            position: { line: opLine, character: lines[opLine].indexOf('ZP_MAX_HP') },
        });
        const symItems = Array.isArray(symComp) ? symComp : symComp.items;
        const zpItem = symItems.find(i => i.label === 'zp_local');
        assert(zpItem && zpItem.detail === 'res label · zeropage', `Expected segment detail on symbol completion, got ${zpItem && zpItem.detail}`);
        const resolvedZpItem = await request('completionItem/resolve', zpItem);
        assert(resolvedZpItem.documentation && resolvedZpItem.documentation.value.includes('Defined in'), 'Expected lazy doc resolution on symbol completion');

        const myLocalRefLine = lines.findIndex(l => l.includes('bne @mylocallabel'));
        const localComp = await request('textDocument/completion', {
            textDocument: { uri: mainUri },
            position: { line: myLocalRefLine, character: lines[myLocalRefLine].indexOf('@mylocallabel') + 3 },
        });
        const localItems = Array.isArray(localComp) ? localComp : localComp.items;
        const myLocalItem = localItems.find(i => i.label === '@mylocallabel');
        assert(myLocalItem, 'Expected cheap local completion item @mylocallabel');
        const resolvedLocalItem = await request('completionItem/resolve', myLocalItem);
        assert(
            resolvedLocalItem.documentation && resolvedLocalItem.documentation.value.startsWith('`CODE` label myscope::mylabel**\u2060@mylocallabel**\n'),
            `Expected cheap local resolve preview with segment, label badge, and qualified name, got:\n${resolvedLocalItem.documentation && resolvedLocalItem.documentation.value}`
        );

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
        const semLegend = initResult.capabilities.semanticTokensProvider.legend;
        const decodeSemanticTokens = (data) => {
            const out = [];
            let line = 0;
            let char = 0;
            for (let i = 0; i < data.length; i += 5) {
                const deltaLine = data[i];
                const deltaStart = data[i + 1];
                const length = data[i + 2];
                const typeIdx = data[i + 3];
                const modMask = data[i + 4];
                line += deltaLine;
                char = deltaLine === 0 ? char + deltaStart : deltaStart;
                const mods = semLegend.tokenModifiers.filter((_, bit) => (modMask & (1 << bit)) !== 0);
                out.push({ line, char, length, type: semLegend.tokenTypes[typeIdx], mods });
            }
            return out;
        };

        const semTokens = await request('textDocument/semanticTokens/full', { textDocument: { uri: mainUri } });
        assert(semTokens && Array.isArray(semTokens.data) && semTokens.data.length > 0 && semTokens.data.length % 5 === 0, 'Expected valid semantic tokens');
        const mainDecoded = decodeSemanticTokens(semTokens.data);
        const findTok = (decoded, textLines, needle, ident) => {
            const ln = textLines.findIndex(l => l.includes(needle));
            const ch = textLines[ln].indexOf(ident);
            return decoded.find(t => t.line === ln && t.char === ch && t.length === ident.length);
        };

        assert.deepStrictEqual(findTok(mainDecoded, lines, '.proc PlayerUpdate', 'PlayerUpdate'), {
            line: procLine, char: lines[procLine].indexOf('PlayerUpdate'), length: 'PlayerUpdate'.length, type: 'function', mods: ['declaration'],
        });
        assert.strictEqual(findTok(mainDecoded, lines, 'jsr PlayerUpdate', 'PlayerUpdate').type, 'function');
        assert.strictEqual(findTok(mainDecoded, lines, 'helper_sub:', 'helper_sub').type, 'function');
        assert(findTok(mainDecoded, lines, 'helper_sub:', 'helper_sub').mods.includes('declaration'));
        assert.deepStrictEqual(
            { type: findTok(mainDecoded, lines, 'jsr helper_sub', 'helper_sub').type, mods: findTok(mainDecoded, lines, 'jsr helper_sub', 'helper_sub').mods },
            { type: 'function', mods: [] }
        );
        assert.deepStrictEqual(
            { type: findTok(mainDecoded, lines, 'zp_local: .res ZP_MAX_HP', 'zp_local').type, mods: findTok(mainDecoded, lines, 'zp_local: .res ZP_MAX_HP', 'zp_local').mods },
            { type: 'variable', mods: ['declaration'] }
        );
        assert.deepStrictEqual(
            { type: findTok(mainDecoded, lines, '.import zp_counter', 'zp_counter').type, mods: findTok(mainDecoded, lines, '.import zp_counter', 'zp_counter').mods },
            { type: 'variable', mods: [] }
        );
        assert.strictEqual(findTok(mainDecoded, lines, 'ent_one: .tag Entity', 'ent_one').type, 'variable');
        assert.deepStrictEqual(
            { type: findTok(mainDecoded, lines, 'lda #ZP_MAX_HP', 'ZP_MAX_HP').type, mods: findTok(mainDecoded, lines, 'lda #ZP_MAX_HP', 'ZP_MAX_HP').mods },
            { type: 'variable', mods: ['readonly'] }
        );

        const varsSemTokens = await request('textDocument/semanticTokens/full', { textDocument: { uri: varsUri } });
        const varsDecoded = decodeSemanticTokens(varsSemTokens.data);
        assert.deepStrictEqual(
            { type: findTok(varsDecoded, varsLines, 'zp_counter: .res 1', 'zp_counter').type, mods: findTok(varsDecoded, varsLines, 'zp_counter: .res 1', 'zp_counter').mods },
            { type: 'variable', mods: ['declaration'] }
        );
        assert.deepStrictEqual(
            { type: findTok(varsDecoded, varsLines, 'zp_plain:', 'zp_plain').type, mods: findTok(varsDecoded, varsLines, 'zp_plain:', 'zp_plain').mods },
            { type: 'variable', mods: ['declaration'] }
        );
        assert.deepStrictEqual(
            { type: findTok(varsDecoded, varsLines, 'ro_incbin:', 'ro_incbin').type, mods: findTok(varsDecoded, varsLines, 'ro_incbin:', 'ro_incbin').mods },
            { type: 'variable', mods: ['declaration', 'readonly'] }
        );
        assert.deepStrictEqual(
            { type: findTok(varsDecoded, varsLines, 'lo_ptrs:', 'lo_ptrs').type, mods: findTok(varsDecoded, varsLines, 'lo_ptrs:', 'lo_ptrs').mods },
            { type: 'variable', mods: ['declaration', 'readonly'] }
        );
        assert.deepStrictEqual(
            { type: findTok(varsDecoded, varsLines, 'msg_z:', 'msg_z').type, mods: findTok(varsDecoded, varsLines, 'msg_z:', 'msg_z').mods },
            { type: 'variable', mods: ['declaration', 'readonly'] }
        );
        assert.deepStrictEqual(
            { type: findTok(varsDecoded, varsLines, 'bank_table:', 'bank_table').type, mods: findTok(varsDecoded, varsLines, 'bank_table:', 'bank_table').mods },
            { type: 'variable', mods: ['declaration', 'readonly'] }
        );
        assert.strictEqual(findTok(varsDecoded, varsLines, 'bank_plain:', 'bank_plain'), undefined);

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

        // 9. Active Segment at Cursor Line (status bar query `ca65/getSegmentAtPosition`)
        const pushSegIdx = lines.findIndex(l => l === '.pushseg');
        const popSegIdx = lines.findIndex(l => l === '.popseg');
        const pushRoSegIdx = lines.indexOf('.segment "RODATA"', pushSegIdx);
        const tempRoLineIdx = lines.findIndex(l => l.includes('@temp_ro:'));
        const afterPopLineIdx = lines.findIndex(l => l.includes('bne @back_to_code'));
        const bankTableLineIdx = varsLines.findIndex(l => l.startsWith('bank_table:'));
        const bank01SegIdx = varsLines.findIndex(l => l === '.segment "BANK01"');

        const segChecks = [
            [mainUri, lines.findIndex(l => l.includes('zp_local: .res ZP_MAX_HP')), 'ZEROPAGE', lines.findIndex(l => l === '.segment "ZEROPAGE"'), true],
            [mainUri, lines.findIndex(l => l.includes('jsr PlayerUpdate')), 'CODE', lines.findIndex(l => l === '.segment "CODE"'), true],
            [mainUri, lines.findIndex(l => l.startsWith('ent_one:')), 'BSS', lines.findIndex(l => l === '.segment "BSS"'), true],
            [mainUri, tempRoLineIdx, 'RODATA', pushRoSegIdx, true],
            [mainUri, afterPopLineIdx, 'CODE', popSegIdx, true],
            [varsUri, bankTableLineIdx, 'BANK01', bank01SegIdx, true],
            [defsUri, 4, 'CODE', 0, false],
        ];
        for (const [uri, targetLine, expectedSeg, expectedDefLine, expectedExplicit] of segChecks) {
            const res = await request('ca65/getSegmentAtPosition', { uri, line: targetLine });
            assert.deepStrictEqual(res, {
                segment: expectedSeg,
                definitionLine: expectedDefLine,
                explicit: expectedExplicit,
                line: targetLine,
            });
        }

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
