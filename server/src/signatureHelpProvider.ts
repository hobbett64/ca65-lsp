import {
    _Connection,
    MarkupKind,
    ParameterInformation,
    SignatureHelp,
    SignatureHelpParams,
    SignatureInformation,
    TextDocuments,
} from 'vscode-languageserver/node';
import { TextDocument } from 'vscode-languageserver-textdocument';
import { getCursorCommentContext, parseLine } from './documentScanner';
import { ensureDocumentRefreshed, getDocumentSettings, includesGraph, initializationGate, performanceMonitor, symbolTables } from './server';
import { resolveMacroByName } from './symbolResolver';
import { Macro, MacroKind } from './symbolTable';
import { getCachedTextDocument } from './documentCache';
import { extractLeadingDocInfo, formatDocCommentForHover } from './hoverProvider';

function countTopLevelCommas(text: string): number {
    let quote: '"' | "'" | null = null;
    let parenDepth = 0;
    let commas = 0;

    for (let i = 0; i < text.length; i++) {
        const ch = text[i];
        if (quote) {
            if (ch === quote) quote = null;
            continue;
        }
        if (ch === '"' || ch === "'") {
            quote = ch;
        } else if (ch === '(') {
            parenDepth++;
        } else if (ch === ')') {
            if (parenDepth > 0) parenDepth--;
        } else if (ch === ',' && parenDepth === 0) {
            commas++;
        }
    }
    return commas;
}

function findEnclosingDefineCall(
    lineToCursor: string,
    documentUri: string
): { macro: Macro; activeArgIndex: number } | null {
    interface ParenFrame {
        macro?: Macro;
        commaCount: number;
    }

    const stack: ParenFrame[] = [];
    let quote: '"' | "'" | null = null;

    for (let i = 0; i < lineToCursor.length; i++) {
        const ch = lineToCursor[i];
        if (quote) {
            if (ch === quote) quote = null;
            continue;
        }
        if (ch === '"' || ch === "'") {
            quote = ch;
            continue;
        }
        if (ch === '(') {
            const before = lineToCursor.slice(0, i);
            const idMatch = before.match(/([a-zA-Z_@.][a-zA-Z0-9_]*)$/);
            let matchedDefine: Macro | undefined;
            if (idMatch) {
                const candidate = resolveMacroByName(documentUri, idMatch[1], symbolTables, includesGraph);
                if (candidate && candidate.kind === MacroKind.Define && candidate.params.length > 0) {
                    matchedDefine = candidate;
                }
            }
            stack.push({ macro: matchedDefine, commaCount: 0 });
        } else if (ch === ')') {
            if (stack.length > 0) stack.pop();
        } else if (ch === ',' && stack.length > 0) {
            stack[stack.length - 1].commaCount++;
        }
    }

    for (let i = stack.length - 1; i >= 0; i--) {
        const frame = stack[i];
        if (frame.macro) {
            return { macro: frame.macro, activeArgIndex: frame.commaCount };
        }
    }
    return null;
}

async function getMacroDocComment(
    macro: Macro,
    documents: TextDocuments<TextDocument>
): Promise<string | undefined> {
    const defDoc = await getCachedTextDocument(macro.uri, documents);
    if (!defDoc) {
        return undefined;
    }

    const { docCommentBlock } = extractLeadingDocInfo(defDoc, macro.definition.start.line);
    if (!docCommentBlock) {
        return undefined;
    }

    return formatDocCommentForHover(docCommentBlock) || undefined;
}

function buildMacroSignatureInfo(macro: Macro, documentation?: string): SignatureInformation {
    const prefix = macro.kind === MacroKind.Define ? `${macro.name}(` : `${macro.name} `;
    const suffix = macro.kind === MacroKind.Define ? ')' : '';

    let cursor = prefix.length;
    const parameters: ParameterInformation[] = [];
    for (let i = 0; i < macro.params.length; i++) {
        if (i > 0) cursor += 2; // ", "
        const param = macro.params[i];
        parameters.push(ParameterInformation.create([cursor, cursor + param.length]));
        cursor += param.length;
    }

    const label = `${prefix}${macro.params.join(', ')}${suffix}`;
    const sig = SignatureInformation.create(label, undefined, ...parameters);
    if (documentation) {
        sig.documentation = { kind: MarkupKind.Markdown, value: documentation };
    }
    return sig;
}

/**
 * Registers LSP signature help showing active macro / `.define` arguments while typing.
 */
export function initializeSignatureHelpProvider(
    connection: _Connection,
    documents: TextDocuments<TextDocument>
): void {
    connection.onSignatureHelp(async (params: SignatureHelpParams): Promise<SignatureHelp | null> => {
        await initializationGate.isInitialized;
        await ensureDocumentRefreshed?.(params.textDocument.uri);

        return performanceMonitor.timeAsync('onSignatureHelp', async () => {
            const document = documents.get(params.textDocument.uri);
            if (!document) return null;

            const settings = await getDocumentSettings(document.uri);
            const cursorCtx = getCursorCommentContext(document, params.position, {
                cComments: settings.cComments,
                lineContinuations: settings.lineContinuations,
            });
            if (cursorCtx.inComment) {
                return null;
            }

            const codeToCursor = cursorCtx.logicalCodeToCursor;
            let targetMacro: Macro | undefined;
            let activeArgIndex = 0;

            const defineCall = findEnclosingDefineCall(codeToCursor, document.uri);
            if (defineCall) {
                targetMacro = defineCall.macro;
                activeArgIndex = defineCall.activeArgIndex;
            } else {
                const parsed = parseLine(codeToCursor);
                if (!parsed.command) return null;

                const cmdEnd = parsed.command.index + parsed.command.text.length;
                if (codeToCursor.length <= cmdEnd) return null;

                const candidate = resolveMacroByName(document.uri, parsed.command.text, symbolTables, includesGraph);
                if (!candidate || candidate.kind !== MacroKind.Macro || candidate.params.length === 0) {
                    return null;
                }

                targetMacro = candidate;
                activeArgIndex = countTopLevelCommas(codeToCursor.slice(cmdEnd));
            }

            const documentation = await getMacroDocComment(targetMacro, documents);
            const sigInfo = buildMacroSignatureInfo(targetMacro, documentation);
            const clampedParam = Math.min(activeArgIndex, targetMacro.params.length - 1);

            return {
                signatures: [sigInfo],
                activeSignature: 0,
                activeParameter: clampedParam,
            };
        });
    });
}
