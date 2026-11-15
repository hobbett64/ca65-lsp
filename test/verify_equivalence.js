const assert = require('assert');
const Module = require('module');
const path = require('path');
const origLoad = Module._load;
Module._load = function (request) {
    if (request === './server') {
        return {
            performanceMonitor: { time: (_k, fn) => fn() },
            getDocumentSettings: async () => ({ includeDirs: ['**/include'] }),
            connection: { console: { log() {} } },
        };
    }
    return origLoad.apply(this, arguments);
};

const { findCommentStart, parseLine, parseQualifiedNames } = require(path.resolve(process.cwd(), 'server/out/documentScanner.js'));
const { Scope, ScopeKind, SymbolKind, ImportKind, SymbolTable } = require(path.resolve(process.cwd(), 'server/out/symbolTable.js'));

function origParseLine(line) {
    function getNextRest(rest, currentOffset, startIndex) {
        const afterStart = rest.slice(startIndex);
        const trimmed = afterStart.trimStart();
        const skipped = afterStart.length - trimmed.length;
        const nextRestOffset = currentOffset + Math.min(startIndex, rest.length) + skipped;
        return [trimmed, nextRestOffset];
    }

    let comment;
    const semicolonIndex = findCommentStart(line);
    if (semicolonIndex >= 0) {
        comment = { text: line.slice(semicolonIndex), index: semicolonIndex };
        line = line.slice(0, semicolonIndex);
    }

    let label;
    let [rest, restOffset] = getNextRest(line, 0, 0);

    const colonIndex = rest.indexOf(':');
    if (colonIndex >= 0) {
        const nextChar = rest.charAt(colonIndex + 1);
        if (!nextChar || !':<>+-'.includes(nextChar)) {
            const labelText = rest.slice(0, colonIndex).trim();
            if (!labelText.match(/\s+/)) {
                label = { text: labelText, index: restOffset };
                [rest, restOffset] = getNextRest(rest, restOffset, colonIndex + 1);
            }
        }
    }

    let command;
    let args;
    const commandText = rest.trim().split(/\s+/)[0];
    if (commandText) {
        command = { text: commandText, index: restOffset };
        [rest, restOffset] = getNextRest(rest, restOffset, commandText.length);
        if (rest.length > 0) {
            args = { text: rest.trimEnd(), index: restOffset };
        }
    }

    return { label, command, args, comment };
}

function origParseQualifiedNames(argsText, argsOffset = 0) {
    if (!argsText) return [];
    const allGroups = [];

    function extractQualifiedGroups(text, baseOffset, context) {
        let currentGroup = [];
        const regex = /(::)?\s*([A-Za-z_@][A-Za-z0-9_]*)|(\S)/g;
        let match;
        while ((match = regex.exec(text))) {
            const hasDoubleColon = !!match[1];
            const identifier = match[2];
            const unexpected = match[3];

            if (unexpected) {
                if (currentGroup.length > 0) allGroups.push(currentGroup);
                currentGroup = [];
                continue;
            }
            if (!identifier) continue;

            const index = baseOffset + match.index + match[0].indexOf(identifier);
            if (!hasDoubleColon) {
                if (currentGroup.length > 0) allGroups.push(currentGroup);
                currentGroup = [{ text: identifier, index, context }];
            } else {
                if (currentGroup.length === 0) {
                    currentGroup.push({ text: '', index: baseOffset + match.index, context });
                }
                currentGroup.push({ text: identifier, index, context });
            }
        }
        if (currentGroup.length > 0) allGroups.push(currentGroup);
    }

    let mutableArgsText = argsText
        .replace(/"([^"]*)"/g, (_m, inner) => `"${' '.repeat(inner.length)}"`)
        .replace(/\$[0-9a-fA-F]+/g, (m) => ' '.repeat(m.length))
        .replace(/'([^']*)'/g, (_m, inner) => `'${' '.repeat(inner.length)}'`);

    const sizeofRegex = /\.sizeof\s*\(([^)]*)\)/g;
    let sizeofMatch;
    while ((sizeofMatch = sizeofRegex.exec(mutableArgsText))) {
        const innerContent = sizeofMatch[1];
        const innerOffset = argsOffset + sizeofMatch.index + sizeofMatch[0].indexOf('(') + 1;
        extractQualifiedGroups(innerContent, innerOffset, 'sizeof');
    }

    mutableArgsText = mutableArgsText.replace(/\.sizeof\s*\(([^)]*)\)/g, (m) => ' '.repeat(m.length));
    extractQualifiedGroups(mutableArgsText, argsOffset, 'symbol');
    return allGroups;
}

const lineCases = [
    '',
    '   \t  ',
    '; full comment',
    '  ; indented comment',
    'label:',
    '  label:   ; with comment',
    'label : lda #$42 ; trailing comment',
    ':',
    '  : lda #0',
    ':+ rts',
    ':- beq :--',
    ':< bne :>',
    '  foo::bar baz',
    '  lda #"a:b;c" ; real comment',
    "  lda #':' + ';' ; end",
    '  .asciiz "hello"',
    '  not a label: lda #0',
    '  label:command arg1, arg2',
    '  @local: nop',
    '  FOO := 1',
    '  .byte "x:y", \'z\'',
    '  lda #123   ',
    '\tlda\tfoo,\tx\t',
    'label_only   ',
];

for (const c of lineCases) {
    assert.deepStrictEqual(parseLine(c), origParseLine(c), `parseLine mismatch for ${JSON.stringify(c)}`);
}

const qualCases = [
    '',
    '   ',
    '#$FF',
    '$12ab',
    '$12foo',
    '#$00 + $CAFE, x',
    '"hello world"',
    "'a' + 'B'",
    '"unclosed foo',
    "'unclosed bar",
    '"closed foo" + bar',
    'Color::Red',
    '::GlobalSym',
    ':: Foo :: Bar + Baz',
    ':::Foo',
    '::123 + Foo',
    '.sizeof(MyStruct)',
    '.sizeof ( Outer :: Inner ) + extra',
    'first + .sizeof(Vec2::x) + last',
    '.sizeof("ignored)" + StructA) + StructB',
    '.sizeof_not_keyword',
    'lda (ptr),y',
    '@loop + _temp123 - foo::@local',
    'foo::$12',
    '123abc + 456',
];

for (const c of qualCases) {
    assert.deepStrictEqual(parseQualifiedNames(c, 5), origParseQualifiedNames(c, 5), `parseQualifiedNames mismatch for ${JSON.stringify(c)}`);
    assert.deepStrictEqual(parseQualifiedNames(c, 0), origParseQualifiedNames(c, 0), `parseQualifiedNames(0) mismatch for ${JSON.stringify(c)}`);
}

// Verify SymbolTable cache invalidation, duplicate symbols/imports, and binary search scope lookup
const table = new SymbolTable('file:///test.s');
const root = table.getRootScope();
const r = (sl, sc, el, ec) => ({ start: { line: sl, character: sc }, end: { line: el, character: ec } });
root.range = r(0, 0, 100, 0);

const s1 = root.addChildScope('Alpha', r(2, 0, 10, 0), ScopeKind.Proc);
const s2 = root.addChildScope('Beta', r(12, 0, 20, 0), ScopeKind.Scope);
const s2Nested = s2.addChildScope('Inner', r(14, 2, 18, 0), ScopeKind.Proc);
const s3 = root.addChildScope('Gamma', r(25, 0, 30, 0), ScopeKind.Proc);

assert.strictEqual(table.getAllDefinedEntities().length, 4);
const dupSym1 = root.addSymbol('dup', r(0, 0, 0, 3), SymbolKind.Variable);
const dupSym2 = root.addSymbol('dup', r(1, 0, 1, 3), SymbolKind.Variable);
assert.strictEqual([...root.getSymbols()].length, 2);
assert.strictEqual(root.getSymbol('dup'), dupSym1);
assert.strictEqual(table.getAllDefinedEntities().length, 6);

root.addImport('imp', r(0, 0, 0, 3), ImportKind.Import);
root.addImport('imp', r(1, 0, 1, 3), ImportKind.Import);
assert.strictEqual([...root.getImports()].length, 2);

assert.strictEqual(table.getScopeAtPosition({ line: 1, character: 0 }), root);
assert.strictEqual(table.getScopeAtPosition({ line: 2, character: 0 }), s1);
assert.strictEqual(table.getScopeAtPosition({ line: 6, character: 5 }), s1);
assert.strictEqual(table.getScopeAtPosition({ line: 10, character: 0 }), s1);
assert.strictEqual(table.getScopeAtPosition({ line: 10, character: 1 }), root);
assert.strictEqual(table.getScopeAtPosition({ line: 11, character: 0 }), root);
assert.strictEqual(table.getScopeAtPosition({ line: 13, character: 0 }), s2);
assert.strictEqual(table.getScopeAtPosition({ line: 15, character: 5 }), s2Nested);
assert.strictEqual(table.getScopeAtPosition({ line: 25, character: 0 }), s3);
assert.strictEqual(table.getScopeAtPosition({ line: 50, character: 0 }), root);
assert.strictEqual(dupSym2.name, 'dup');

console.log('ALL EQUIVALENCE & TREE INVARIANT CHECKS PASSED!');
