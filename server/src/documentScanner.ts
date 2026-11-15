import {
    Range,
} from 'vscode-languageserver-types';
import { TextDocument } from 'vscode-languageserver-textdocument';
import {
    Export,
    ExportKind,
    ImportKind,
    Macro,
    MacroKind,
    ReferenceInfo,
    Scope,
    ScopeKind,
    Symbol,
    SymbolKind,
    SymbolTable,
    SymbolTableEntity,
} from './symbolTable';
import { getAnonLabelRefOffsetFromPreviousLabel } from './anonymousLabelUtils';
import { getDocumentSettings, performanceMonitor } from './server';
import { resolveIncludeUri } from './pathUtils';
import { getMnemonicInfo } from './dataManager';
import { Ca65Settings } from './settings';

type LineItem = {
    text: string;
    index: number;
};

type ParsedLine = {
    label?: LineItem;
    command?: LineItem;
    args?: LineItem; // the raw text + index for "everything to the right of the command"
    comment?: LineItem;
};

interface ParsedQualifiedName extends LineItem {
    context: ReferenceInfo['context'];
}

export interface ParsedImportExportArgs {
    identifier?: LineItem;
    addressSpecification?: LineItem;
    assignmentOp?: LineItem; // = or :=
    value?: LineItem;
}

const OPEN_SCOPE_KINDS: Record<string, ScopeKind> = {
    '.proc': ScopeKind.Proc,
    '.scope': ScopeKind.Scope,
    '.struct': ScopeKind.Struct,
    '.union': ScopeKind.Union,
    '.enum': ScopeKind.Enum,
};

const CLOSE_SCOPE_KINDS: Record<string, ScopeKind> = {
    '.endproc': ScopeKind.Proc,
    '.endscope': ScopeKind.Scope,
    '.endstruct': ScopeKind.Struct,
    '.endunion': ScopeKind.Union,
    '.endenum': ScopeKind.Enum,
};

const SEGMENT_DIRECTIVES = new Set([
    '.segment',
    '.code',
    '.data',
    '.bss',
    '.zeropage',
    '.rodata',
]);

const IMPORT_EXPORT_DIRECTIVES = new Set([
    '.import',
    '.importzp',
    '.export',
    '.exportzp',
    '.global',
    '.globalzp',
]);

const DATA_LABEL_DIRECTIVES = new Set([
    '.addr',
    '.bankbytes',
    '.dbyt',
    '.dword',
    '.faraddr',
    '.hibytes',
    '.incbin',
    '.lobytes',
    '.word',
]);

const STRING_LABEL_DIRECTIVES = new Set(['.asciiz', '.literal']);

const CONSTANT_ASSIGNMENT_RE = /^\s*(?<name>[a-zA-Z_@.][a-zA-Z0-9_]*)\s*(?:=|:=)/;
const VARIABLE_ASSIGNMENT_RE = /^\s*(?<name>[a-zA-Z_@.][a-zA-Z0-9_]*)\s*\.set\s*(?<value>[^;]*?)(?:\s*;.*)?$/;
const ANON_REF_RE = /:([-+<>]+)/g;
const EMPTY_QUALIFIERS: readonly string[] = Object.freeze([]);

function isWhitespaceCode(code: number): boolean {
    if (code === 32 || code === 9) return true;
    if (code < 10 || (code > 13 && code < 0xa0)) return false;
    return code <= 13 || code === 0xa0 || code === 0xfeff || /\s/.test(String.fromCharCode(code));
}

function skipWhitespace(text: string, pos: number, end: number): number {
    while (pos < end && isWhitespaceCode(text.charCodeAt(pos))) {
        pos++;
    }
    return pos;
}

function trimEndIndex(text: string, start: number, end: number): number {
    while (end > start && isWhitespaceCode(text.charCodeAt(end - 1))) {
        end--;
    }
    return end;
}

function findNextWhitespace(text: string, pos: number, end: number): number {
    while (pos < end && !isWhitespaceCode(text.charCodeAt(pos))) {
        pos++;
    }
    return pos;
}

function firstWord(text: string): string {
    const end = text.length;
    const start = skipWhitespace(text, 0, end);
    if (start >= end) return '';
    return text.slice(start, findNextWhitespace(text, start, end));
}

function isIdentStartCode(code: number): boolean {
    return (code >= 65 && code <= 90)
        || (code >= 97 && code <= 122)
        || code === 95
        || code === 64;
}

function isIdentContinueCode(code: number): boolean {
    return (code >= 65 && code <= 90)
        || (code >= 97 && code <= 122)
        || (code >= 48 && code <= 57)
        || code === 95;
}

function isHexDigitCode(code: number): boolean {
    return (code >= 48 && code <= 57)
        || (code >= 65 && code <= 70)
        || (code >= 97 && code <= 102);
}

function scanIdentEnd(text: string, start: number, end: number): number {
    let pos = start + 1;
    while (pos < end && isIdentContinueCode(text.charCodeAt(pos))) {
        pos++;
    }
    return pos;
}

function findCommentStartInRange(line: string, start: number, end: number): number {
    let quote = 0;
    for (let i = start; i < end; i++) {
        const code = line.charCodeAt(i);
        if (quote !== 0) {
            if (code === quote) {
                quote = 0;
            }
        } else if (code === 34 /* " */ || code === 39 /* ' */) {
            quote = code;
        } else if (code === 59 /* ; */) {
            return i;
        }
    }
    return -1;
}

/**
 * Returns the index of the first `;` comment delimiter outside of quotes, or -1 if none.
 */
export function findCommentStart(line: string): number {
    return findCommentStartInRange(line, 0, line.length);
}

function parseLineCore(line: string, codeEnd: number, comment?: LineItem): ParsedLine {
    let label: LineItem | undefined;
    let pos = skipWhitespace(line, 0, codeEnd);

    // Get the label to the left of the colon, if any.
    const colonIndex = line.indexOf(':', pos);
    if (colonIndex >= 0 && colonIndex < codeEnd) {
        const nextCode = colonIndex + 1 < codeEnd ? line.charCodeAt(colonIndex + 1) : 0;
        // Skip ::, :<, :>, :+, :- (qualified names and anonymous label references)
        if (nextCode !== 58 && nextCode !== 60 && nextCode !== 62 && nextCode !== 43 && nextCode !== 45) {
            const labelEnd = trimEndIndex(line, pos, colonIndex);
            if (findNextWhitespace(line, pos, labelEnd) === labelEnd) {
                label = {
                    text: labelEnd === pos ? '' : line.slice(pos, labelEnd),
                    index: pos,
                };
                pos = skipWhitespace(line, colonIndex + 1, codeEnd);
            }
        }
    }

    // Get the command and args
    let command: LineItem | undefined;
    let args: LineItem | undefined;
    if (pos < codeEnd) {
        const cmdEnd = findNextWhitespace(line, pos, codeEnd);
        command = { text: line.slice(pos, cmdEnd), index: pos };
        pos = skipWhitespace(line, cmdEnd, codeEnd);
        if (pos < codeEnd) {
            const argsEnd = trimEndIndex(line, pos, codeEnd);
            args = { text: line.slice(pos, argsEnd), index: pos };
        }
    }

    return { label, command, args, comment };
}

function parseCodeLine(text: string): ParsedLine {
    return parseLineCore(text, text.length);
}

/**
 * Splits a single line of ca65 source into label, command, args, and comment tokens with offsets.
 */
export function parseLine(line: string): ParsedLine {
    const semicolonIndex = findCommentStartInRange(line, 0, line.length);
    if (semicolonIndex >= 0) {
        const comment: LineItem = { text: line.slice(semicolonIndex), index: semicolonIndex };
        return parseLineCore(line, semicolonIndex, comment);
    }
    return parseLineCore(line, line.length);
}

function findClosingParenOutsideQuotes(text: string, start: number, end: number): number {
    let i = start;
    while (i < end) {
        const code = text.charCodeAt(i);
        if (code === 34 /* " */) {
            const close = text.indexOf('"', i + 1);
            i = (close >= 0 && close < end) ? close + 1 : i + 1;
        } else if (code === 39 /* ' */) {
            const close = text.indexOf("'", i + 1);
            i = (close >= 0 && close < end) ? close + 1 : i + 1;
        } else if (code === 41 /* ) */) {
            return i;
        } else {
            i++;
        }
    }
    return -1;
}

function scanQualifiedRange(
    text: string,
    start: number,
    end: number,
    baseOffset: number,
    context: ReferenceInfo['context'],
    allowSizeof: boolean,
    onGroup: (group: ParsedQualifiedName[]) => void,
    onSizeofRange?: (innerStart: number, innerEnd: number) => void
): void {
    let currentGroup: ParsedQualifiedName[] | null = null;
    let i = start;

    const flushGroup = () => {
        if (currentGroup) {
            onGroup(currentGroup);
            currentGroup = null;
        }
    };

    while (i < end) {
        const code = text.charCodeAt(i);
        if (isWhitespaceCode(code)) {
            i++;
            continue;
        }

        // Ignore identifiers inside closed string or character literals
        if (code === 34 /* " */ || code === 39 /* ' */) {
            flushGroup();
            const closeQuote = text.indexOf(code === 34 ? '"' : "'", i + 1);
            i = (closeQuote >= 0 && closeQuote < end) ? closeQuote + 1 : i + 1;
            continue;
        }

        // Ignore $hex literals without breaking surrounding whitespace state
        if (code === 36 /* $ */) {
            let hexEnd = i + 1;
            while (hexEnd < end && isHexDigitCode(text.charCodeAt(hexEnd))) {
                hexEnd++;
            }
            if (hexEnd > i + 1) {
                i = hexEnd;
            } else {
                flushGroup();
                i++;
            }
            continue;
        }

        // Parse .sizeof(...) arguments under 'sizeof' context and skip their span
        if (allowSizeof && code === 46 /* . */ && i + 7 <= end && text.startsWith('.sizeof', i)) {
            const parenPos = skipWhitespace(text, i + 7, end);
            if (parenPos < end && text.charCodeAt(parenPos) === 40 /* ( */) {
                const closeParen = findClosingParenOutsideQuotes(text, parenPos + 1, end);
                if (closeParen >= 0) {
                    if (onSizeofRange) {
                        onSizeofRange(parenPos + 1, closeParen);
                    }
                    i = closeParen + 1;
                    continue;
                }
            }
        }

        // Qualified separator :: followed by optional whitespace and identifier start
        if (code === 58 /* : */ && i + 1 < end && text.charCodeAt(i + 1) === 58 /* : */) {
            const identStart = skipWhitespace(text, i + 2, end);
            if (identStart < end && isIdentStartCode(text.charCodeAt(identStart))) {
                const identEnd = scanIdentEnd(text, identStart, end);
                const item: ParsedQualifiedName = {
                    text: text.slice(identStart, identEnd),
                    index: baseOffset + identStart,
                    context,
                };
                if (!currentGroup) {
                    currentGroup = [{ text: '', index: baseOffset + i, context }, item];
                } else {
                    currentGroup.push(item);
                }
                i = identEnd;
                continue;
            }
            flushGroup();
            i++;
            continue;
        }

        if (isIdentStartCode(code)) {
            flushGroup();
            const identEnd = scanIdentEnd(text, i, end);
            currentGroup = [{
                text: text.slice(i, identEnd),
                index: baseOffset + i,
                context,
            }];
            i = identEnd;
            continue;
        }

        flushGroup();
        i++;
    }

    flushGroup();
}

function visitQualifiedGroups(
    argsText: string,
    argsOffset: number,
    onGroup: (group: ParsedQualifiedName[]) => void
): void {
    if (!argsText) return;
    scanQualifiedRange(
        argsText,
        0,
        argsText.length,
        argsOffset,
        'symbol',
        true,
        onGroup,
        (innerStart, innerEnd) => {
            scanQualifiedRange(argsText, innerStart, innerEnd, argsOffset, 'sizeof', false, onGroup);
        }
    );
}

/**
 * Extracts simple and `::`-qualified identifier groups from an operand/argument string.
 */
export function parseQualifiedNames(argsText: string, argsOffset: number = 0): ParsedQualifiedName[][] {
    if (!argsText) return [];

    let sizeofGroups: ParsedQualifiedName[][] | undefined;
    const symbolGroups: ParsedQualifiedName[][] = [];

    scanQualifiedRange(
        argsText,
        0,
        argsText.length,
        argsOffset,
        'symbol',
        true,
        group => symbolGroups.push(group),
        (innerStart, innerEnd) => {
            const target = (sizeofGroups ??= []);
            scanQualifiedRange(
                argsText,
                innerStart,
                innerEnd,
                argsOffset,
                'sizeof',
                false,
                group => target.push(group)
            );
        }
    );

    if (!sizeofGroups) return symbolGroups;
    sizeofGroups.push(...symbolGroups);
    return sizeofGroups;
}

/**
 * Parses comma-separated `.import` / `.export` / `.global` argument groups.
 */
export function parseImportExportArgs(text: string, offset: number): ParsedImportExportArgs[] {
    function trimWithOffset(str: string, baseOffset: number): [string, number] {
        const trimmed = str.trimStart();
        return [trimmed, baseOffset + (str.length - trimmed.length)];
    }

    const groups: ParsedImportExportArgs[] = [];
    let currentOffset = offset;

    for (const rawGroup of text.split(',')) {
        let [rest, restOffset] = trimWithOffset(rawGroup, currentOffset);
        currentOffset += rawGroup.length + 1; // account for comma

        if (!rest) continue;

        const group: ParsedImportExportArgs = {};

        // 1: leading identifier (up to first special token)
        let m = rest.match(/^([^:=\s]+)/);
        if (m) {
            group.identifier = { text: m[1], index: restOffset };
            rest = rest.slice(m[0].length);
            restOffset += m[0].length;
        }

        [rest, restOffset] = trimWithOffset(rest, restOffset);

        // 2: optional ":" address size specifier
        if (rest.startsWith(':')) {
            rest = rest.slice(1);
            restOffset++;
            [rest, restOffset] = trimWithOffset(rest, restOffset);

            m = rest.match(/^([^:=\s]+)/);
            if (m) {
                group.addressSpecification = { text: m[1], index: restOffset };
                rest = rest.slice(m[0].length);
                restOffset += m[0].length;
            }
            [rest, restOffset] = trimWithOffset(rest, restOffset);
        }

        // 3: optional assignment
        if (rest.startsWith(':=') || rest.startsWith('=')) {
            const op = rest.startsWith(':=') ? ':=' : '=';
            group.assignmentOp = { text: op, index: restOffset };
            rest = rest.slice(op.length);
            restOffset += op.length;

            [rest, restOffset] = trimWithOffset(rest, restOffset);

            if (rest.length > 0) {
                group.value = { text: rest.trimEnd(), index: restOffset };
            }
        }

        groups.push(group);
    }

    return groups;
}

class DocumentScanner {
    private readonly symbolTable: SymbolTable;
    private currentScope: Scope;
    private currentMacro: Macro | null = null;
    private inIgnoredMacro = false;
    private currentSegment = 'CODE';
    private currentLabel: Symbol | undefined;
    private pendingLabelKindSet = false;
    private nextAnonLabelIndex = 0;

    constructor(
        private readonly document: TextDocument,
        private readonly settings: Ca65Settings
    ) {
        this.symbolTable = new SymbolTable(document.uri);
        this.currentScope = this.symbolTable.getRootScope();
    }

    public scan(): SymbolTable {
        const fullText = this.document.getText();
        const len = fullText.length;
        let lineNumber = 0;
        let lineStart = 0;
        let hasLineContinuation = false;

        while (lineStart <= len) {
            const nlIdx = fullText.indexOf('\n', lineStart);
            let lineEnd = nlIdx >= 0 ? nlIdx : len;
            if (lineEnd > lineStart && fullText.charCodeAt(lineEnd - 1) === 13 /* \r */) {
                lineEnd--;
            }

            const isContinued = hasLineContinuation;
            hasLineContinuation = false;

            const commentIdx = findCommentStartInRange(fullText, lineStart, lineEnd);
            const hasComment = commentIdx >= 0;
            const codeEnd = hasComment ? commentIdx : lineEnd;
            const trimmedEnd = trimEndIndex(fullText, lineStart, codeEnd);

            if (!hasComment && trimmedEnd > lineStart && fullText.charCodeAt(trimmedEnd - 1) === 92 /* \ */) {
                hasLineContinuation = true;
            }

            if (isContinued) {
                const trimmedLen = trimmedEnd - lineStart;
                if (trimmedLen > 0) {
                    // Handle line continuations by recording all symbol references across the continued line.
                    this.addReferences(lineNumber, fullText.slice(lineStart, codeEnd), 0, this.currentScope);
                }
                if (this.currentLabel) {
                    this.currentLabel.range.end = { line: lineNumber, character: trimmedLen };
                }
            } else if (trimmedEnd > lineStart) {
                this.processLine(lineNumber, fullText.slice(lineStart, codeEnd), trimmedEnd - lineStart);
            }

            if (nlIdx < 0) break;
            lineStart = nlIdx + 1;
            lineNumber++;
        }

        this.pruneAnonymousLabelRefs();
        this.closeOpenScopes();
        return this.symbolTable;
    }

    private processLine(lineNumber: number, text: string, trimmedLen: number): void {
        this.addAnonymousLabelRefs(lineNumber, text);

        if (this.handleMacroContent(lineNumber, text)) return;

        // Parse once for struct/union, enum, and generic directive/instruction lines
        const parsed = parseCodeLine(text);

        if (this.handleStructUnionContent(lineNumber, text, parsed)) return;
        if (this.handleEnumContent(lineNumber, text, parsed)) return;

        if (this.handleAssignment(lineNumber, text)) return;
        this.handleGenericLine(lineNumber, parsed, trimmedLen);
    }

    private addReferences(
        line: number,
        text: string,
        offset: number = 0,
        scope: Scope,
        callingEntity?: SymbolTableEntity
    ): void {
        visitQualifiedGroups(text, offset, (parsedNames) => {
            if (parsedNames.length === 1) {
                const { text: name, index, context } = parsedNames[0];
                this.symbolTable.addReference(new ReferenceInfo(
                    this.document.uri,
                    name,
                    EMPTY_QUALIFIERS,
                    context,
                    Range.create(line, index, line, index + name.length),
                    scope,
                    callingEntity
                ));
                return;
            }

            let qualifiers: string[] | undefined;
            const lastIdx = parsedNames.length - 1;
            for (let i = 0; i < parsedNames.length; i++) {
                const { text: name, index, context } = parsedNames[i];
                const refQualifiers = i === 0
                    ? EMPTY_QUALIFIERS
                    : (i === lastIdx ? qualifiers! : qualifiers!.slice());
                this.symbolTable.addReference(new ReferenceInfo(
                    this.document.uri,
                    name,
                    refQualifiers,
                    i === lastIdx ? context : 'scope',
                    Range.create(line, index, line, index + name.length),
                    scope,
                    callingEntity
                ));
                if (i < lastIdx) {
                    (qualifiers ??= []).push(name);
                }
            }
        });
    }

    private addSingleReference(
        context: ReferenceInfo['context'],
        line: number,
        text: string,
        offset: number,
        scope: Scope
    ): void {
        this.symbolTable.addReference(new ReferenceInfo(
            this.document.uri,
            text,
            EMPTY_QUALIFIERS,
            context,
            Range.create(line, offset, line, offset + text.length),
            scope
        ));
    }

    private addAnonymousLabelRefs(line: number, text: string): void {
        if (text.indexOf(':') === -1) return;

        let match: RegExpExecArray | null;
        ANON_REF_RE.lastIndex = 0;
        while ((match = ANON_REF_RE.exec(text)) !== null) {
            const offset = getAnonLabelRefOffsetFromPreviousLabel(match[0]);
            const targetIndex = this.nextAnonLabelIndex - 1 + offset;
            if (targetIndex < 0) continue;

            let list = this.symbolTable.anonymousLabelReferences.get(targetIndex);
            if (!list) {
                list = [];
                this.symbolTable.anonymousLabelReferences.set(targetIndex, list);
            }
            list.push(Range.create(line, match.index, line, match.index + match[0].length));
        }
    }

    private handleAssignment(line: number, text: string): boolean {
        if (text.indexOf('=') !== -1) {
            const constMatch = text.match(CONSTANT_ASSIGNMENT_RE);
            if (constMatch?.groups) {
                return this.recordAssignment(line, text, constMatch.groups.name, SymbolKind.Constant);
            }
        }

        if (text.indexOf('.set') !== -1) {
            const varMatch = text.match(VARIABLE_ASSIGNMENT_RE);
            if (varMatch?.groups) {
                return this.recordAssignment(line, text, varMatch.groups.name, SymbolKind.Variable, this.currentSegment);
            }
        }

        return false;
    }

    private recordAssignment(
        line: number,
        text: string,
        name: string,
        kind: SymbolKind,
        segment?: string
    ): boolean {
        const nameIndex = text.indexOf(name);
        const definition = Range.create(line, nameIndex, line, nameIndex + name.length);
        this.addReferences(line, text, 0, this.currentScope);
        this.currentScope.addSymbol(name, definition, kind, segment);
        return true;
    }

    private handleMacroContent(line: number, text: string): boolean {
        if (!this.currentMacro && !this.inIgnoredMacro) return false;

        const word = firstWord(text);
        if (!word) return true;

        if (word.charCodeAt(0) === 46 && (word.length === 7 || word.length === 9)) {
            const lowerWord = word.toLowerCase();
            if (lowerWord === '.endmac' || lowerWord === '.endmacro') {
                if (this.currentMacro?.range) {
                    const endIdx = text.toLowerCase().indexOf('.end');
                    this.currentMacro.range.end = { line, character: endIdx >= 0 ? endIdx : 0 };
                }
                this.currentMacro = null;
                this.inIgnoredMacro = false;
            }
        }
        return true;
    }

    private openScope(kind: ScopeKind, line: number, command: LineItem, args?: LineItem): void {
        this.currentLabel = undefined;
        const argsIndex = args?.index ?? (command.index + command.text.length);
        let name = args?.text || '';
        if (name) {
            this.addSingleReference('scope', line, name, argsIndex, this.currentScope);
        } else {
            name = `<anon line ${line + 1}>`;
        }
        this.currentScope = this.currentScope.addChildScope(
            name,
            Range.create(line, argsIndex, line, argsIndex + name.length),
            kind,
            kind === ScopeKind.Proc ? this.currentSegment : undefined
        );
    }

    private closeScope(expectedKind: ScopeKind, line: number, character: number): boolean {
        if (!this.currentScope.scope || this.currentScope.kind !== expectedKind) {
            return false;
        }
        if (this.currentScope.range) {
            this.currentScope.range.end = { line, character };
        }
        this.currentScope = this.currentScope.scope;
        return true;
    }

    private handleStructUnionContent(line: number, text: string, parsed: ParsedLine): boolean {
        if (this.currentScope.kind !== ScopeKind.Struct && this.currentScope.kind !== ScopeKind.Union) {
            return false;
        }

        const { command, args } = parsed;
        if (!command) return !parsed.label;
        const cmd = command.text.toLowerCase();

        if (CLOSE_SCOPE_KINDS[cmd] === this.currentScope.kind) {
            this.closeScope(this.currentScope.kind, line, command.index);
            return true;
        }

        if (cmd === '.struct' || cmd === '.union') {
            this.openScope(OPEN_SCOPE_KINDS[cmd], line, command, args);
            return true;
        }

        const definition = Range.create(line, command.index, line, command.index + command.text.length);

        if (args && firstWord(args.text).toLowerCase() === '.tag') {
            // Struct member is at the command position
            this.addSingleReference('symbol', line, command.text, command.index, this.currentScope);
            const argsWithoutTag = args.text.slice('.tag'.length).trimStart();
            const indexOfStructName = args.text.length - argsWithoutTag.length + args.index;
            const structName = firstWord(argsWithoutTag);
            if (structName) {
                this.addSingleReference('scope', line, structName, indexOfStructName, this.currentScope);
            }
        } else {
            this.addReferences(line, text, 0, this.currentScope);
        }
        this.currentScope.addSymbol(command.text, definition, SymbolKind.StructMember);
        return true;
    }

    private handleEnumContent(line: number, text: string, parsed: ParsedLine): boolean {
        if (this.currentScope.kind !== ScopeKind.Enum) {
            return false;
        }

        const { command } = parsed;
        if (!command) return !parsed.label;

        if (command.text.toLowerCase() === '.endenum') {
            this.closeScope(ScopeKind.Enum, line, command.index);
            return true;
        }

        const definition = Range.create(line, command.index, line, command.index + command.text.length);
        this.addReferences(line, text, 0, this.currentScope);
        this.currentScope.addSymbol(command.text, definition, SymbolKind.EnumMember);
        return true;
    }

    private handleGenericLine(line: number, parsed: ParsedLine, trimmedLen: number): void {
        const { label, command, args } = parsed;
        if (label) {
            this.handleLabel(line, label);
        }

        if (!command) return;

        const cmd = command.text.toLowerCase();
        const isDirective = cmd.charCodeAt(0) === 46 /* . */;
        if (!isDirective && !getMnemonicInfo(cmd, this.settings.cpu)) {
            this.addSingleReference('macro', line, command.text, command.index, this.symbolTable.getRootScope());
        }

        if (isDirective && this.handleDirective(line, command, args)) {
            return;
        }

        const argsText = args?.text || '';
        if (this.currentLabel) {
            // Consume any un-labeled commands as part of the current label
            this.currentLabel.range.end = { line, character: trimmedLen };
            this.updateLabelKindFromCommand(cmd, argsText);
        }

        if (!args) return;

        if (cmd === '.tag') {
            const structName = firstWord(args.text);
            if (structName) {
                this.addSingleReference('scope', line, structName, args.index, this.currentScope);
            }
            return;
        }

        let callingEntity: SymbolTableEntity | undefined;
        if (cmd === 'jsr' || cmd === 'jmp' || (this.settings.cpu === '65816' && (cmd === 'jsl' || cmd === 'jml'))) {
            if (this.currentLabel) {
                callingEntity = this.currentLabel;
            } else if (this.currentScope.kind === ScopeKind.Proc) {
                callingEntity = this.currentScope;
            }
        }
        this.addReferences(line, args.text, args.index, this.currentScope, callingEntity);
    }

    private handleLabel(line: number, label: LineItem): void {
        if (label.text.startsWith('@')) {
            // Cheap local labels are resolved on-demand.
            return;
        }

        if (label.text.length === 0) {
            this.symbolTable.anonymousLabelLines.push(line);
            let refs = this.symbolTable.anonymousLabelReferences.get(this.nextAnonLabelIndex);
            if (!refs) {
                refs = [];
                this.symbolTable.anonymousLabelReferences.set(this.nextAnonLabelIndex, refs);
            }
            refs.push(Range.create(line, label.index, line, label.index + 1));
            this.nextAnonLabelIndex++;
            return;
        }

        this.addSingleReference('symbol', line, label.text, label.index, this.currentScope);
        this.currentLabel = this.currentScope.addSymbol(
            label.text,
            Range.create(line, label.index, line, label.index + label.text.length),
            SymbolKind.Label,
            this.currentSegment
        );
        this.pendingLabelKindSet = false;
    }

    private handleDirective(line: number, command: LineItem, args?: LineItem): boolean {
        const cmd = command.text.toLowerCase();
        const argsText = args?.text || '';
        const argsIndex = args?.index ?? (command.index + command.text.length);

        const openKind = OPEN_SCOPE_KINDS[cmd];
        if (openKind) {
            this.openScope(openKind, line, command, args);
            return true;
        }

        if (cmd === '.endproc' || cmd === '.endscope') {
            this.currentLabel = undefined;
            return this.closeScope(CLOSE_SCOPE_KINDS[cmd], line, command.index);
        }

        if (cmd === '.macro' || cmd === '.mac') {
            this.handleMacroDirective(line, argsText, argsIndex, args ? firstWord(args.text) : undefined);
            return true;
        }

        if (cmd === '.define') {
            this.handleDefineDirective(line, argsText, argsIndex);
            return true;
        }

        if (SEGMENT_DIRECTIVES.has(cmd)) {
            this.currentLabel = undefined;
            this.currentSegment = cmd === '.segment'
                ? argsText.replace(/"/g, '')
                : cmd.slice(1).toUpperCase();
            return true;
        }

        if (IMPORT_EXPORT_DIRECTIVES.has(cmd)) {
            this.handleImportExportDirective(cmd, line, args);
            return true;
        }

        if (cmd === '.include') {
            this.handleIncludeDirective(line, args);
            return true;
        }

        if (cmd === '.incbin' && args && args.text.startsWith('"')) {
            const closeQuote = args.text.indexOf('"', 1);
            if (closeQuote > 1) {
                this.symbolTable.documentLinkDirectives.push({
                    line,
                    startChar: args.index + 1,
                    endChar: args.index + closeQuote,
                    filename: args.text.slice(1, closeQuote),
                    isBinary: true,
                });
            }
        }

        return false;
    }

    private handleMacroDirective(line: number, argsText: string, argsIndex: number, name?: string): void {
        this.currentLabel = undefined;
        if (!name) return;

        const rawParams = argsText.slice(name.length).trim();
        const params = rawParams
            ? rawParams.split(',').map(p => p.trim()).filter(Boolean)
            : [];

        this.addSingleReference('macro', line, name, argsIndex, this.currentScope);
        if (!this.symbolTable.getMacro(name)) {
            this.currentMacro = this.symbolTable.addMacro(
                name,
                Range.create(line, argsIndex, line, argsIndex + argsText.length),
                MacroKind.Macro,
                params
            );
        } else {
            this.inIgnoredMacro = true;
        }
    }

    private handleDefineDirective(line: number, argsText: string, argsIndex: number): void {
        this.currentLabel = undefined;
        const defMatch = argsText.match(/([a-zA-Z_@.][a-zA-Z0-9_]*)(?:\(([^)]*)\))?/);
        const name = defMatch?.[1];
        if (!name) return;

        const rawParams = defMatch?.[2];
        const params = rawParams !== undefined
            ? rawParams.split(',').map(p => p.trim()).filter(Boolean)
            : [];

        this.addSingleReference('macro', line, name, argsIndex, this.currentScope);
        if (!this.symbolTable.getMacro(name)) {
            this.symbolTable.addMacro(
                name,
                Range.create(line, argsIndex, line, argsIndex + name.length),
                MacroKind.Define,
                params
            );
        }
    }

    private handleImportExportDirective(cmd: string, line: number, args?: LineItem): void {
        if (!args) return;

        const isImport = cmd.startsWith('.import');
        const isGlobal = cmd.startsWith('.global');
        const isExport = cmd.startsWith('.export');
        const isZeroPage = cmd.endsWith('zp');

        for (const { identifier, assignmentOp, value } of parseImportExportArgs(args.text, args.index)) {
            if (!identifier) continue;

            const identifierRange = Range.create(
                line,
                identifier.index,
                line,
                identifier.index + identifier.text.length
            );

            if (isExport && assignmentOp && value) {
                // Exports may define a constant on the same line
                this.currentScope.addSymbol(identifier.text, identifierRange, SymbolKind.Constant);
                this.addReferences(line, value.text, value.index, this.currentScope);
            }
            this.addSingleReference('symbol', line, identifier.text, identifier.index, this.currentScope);

            if (isImport || isGlobal) {
                this.symbolTable.imports.push(
                    this.currentScope.addImport(
                        identifier.text,
                        identifierRange,
                        isImport ? ImportKind.Import : ImportKind.Global,
                        isZeroPage
                    )
                );
            }
            if (isExport || isGlobal) {
                this.symbolTable.exports.push(
                    new Export(
                        this.document.uri,
                        isExport ? ExportKind.Export : ExportKind.Global,
                        identifier.text,
                        identifierRange,
                        this.currentScope,
                        isZeroPage
                    )
                );
            }
        }
    }

    private handleIncludeDirective(line: number, args?: LineItem): void {
        this.currentLabel = undefined;
        if (!args) return;

        const argsText = args.text;
        const match = argsText.match(/^(['"])(.*)\1$/);
        if (!match) return;

        const quote = match[1];
        const filename = match[2];
        const targetUri = resolveIncludeUri(this.document.uri, filename, this.settings.includeDirs);
        if (targetUri) {
            this.symbolTable.includedFiles.push(targetUri);
        } else {
            this.symbolTable.unresolvedIncludes.push(filename);
        }
        if (quote === '"' && filename.length > 0) {
            this.symbolTable.documentLinkDirectives.push({
                line,
                startChar: args.index + 1,
                endChar: args.index + 1 + filename.length,
                filename,
                isBinary: false,
                resolvedUri: targetUri,
            });
        }
        this.currentSegment = `segment from ${filename}`;
    }

    private updateLabelKindFromCommand(cmd: string, argsText: string): void {
        if (!this.currentLabel || this.pendingLabelKindSet || cmd === '.align') return;

        this.pendingLabelKindSet = true;
        if (cmd.charCodeAt(0) !== 46 /* . */) return;

        if (cmd === '.res' || cmd === '.tag') {
            this.currentLabel.kind = SymbolKind.ResLabel;
        } else if (cmd === '.byt' || cmd === '.byte') {
            this.currentLabel.kind = /^"[^"]*"(\s*,\s*"[^"]*")*$/.test(argsText)
                ? SymbolKind.StringLabel
                : SymbolKind.DataLabel;
        } else if (DATA_LABEL_DIRECTIVES.has(cmd)) {
            this.currentLabel.kind = SymbolKind.DataLabel;
        } else if (STRING_LABEL_DIRECTIVES.has(cmd)) {
            this.currentLabel.kind = SymbolKind.StringLabel;
        }
    }

    private pruneAnonymousLabelRefs(): void {
        for (const refIndex of this.symbolTable.anonymousLabelReferences.keys()) {
            if (refIndex < 0 || refIndex >= this.nextAnonLabelIndex) {
                this.symbolTable.anonymousLabelReferences.delete(refIndex);
            }
        }
    }

    private closeOpenScopes(): void {
        let openScope: Scope | null = this.currentScope;
        while (openScope != null) {
            openScope.range.end = { line: this.document.lineCount, character: 0 };
            openScope = openScope.scope;
        }
    }
}

/**
 * Scans a ca65 document and constructs its symbol, scope, macro, include, and reference table.
 */
export async function scanDocument(document: TextDocument): Promise<SymbolTable> {
    const settings = await getDocumentSettings(document.uri);
    return performanceMonitor.time('scanDocument', () => {
        return new DocumentScanner(document, settings).scan();
    });
}
