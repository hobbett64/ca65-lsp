import {
    _Connection,
    CodeLens,
    CodeLensParams,
    Location,
    TextDocuments,
} from 'vscode-languageserver/node';
import { TextDocument } from 'vscode-languageserver-textdocument';
import {
    ensureDocumentRefreshed,
    getDocumentSettings,
    includesGraph,
    initializationGate,
    performanceMonitor,
    symbolTables,
} from './server';
import { Scope, ScopeKind } from './symbolTable';
import { getAllReferenceLocationsForEntity } from './symbolResolver';
import { analyzeInstructionRange } from './instructionAnalyzer';

function collectProcScopes(rootScope: Scope): Scope[] {
    const procs: Scope[] = [];
    const stack: Scope[] = [rootScope];
    while (stack.length > 0) {
        const current = stack.pop()!;
        const children = current.getOrderedChildScopes();
        for (let i = children.length - 1; i >= 0; i--) {
            stack.push(children[i]);
        }
        if (current.kind === ScopeKind.Proc && current.name) {
            procs.push(current);
        }
    }
    return procs;
}

function isSameLocationStart(a: Location, uri: string, line: number, character: number): boolean {
    return a.uri === uri && a.range.start.line === line && a.range.start.character === character;
}

export async function computeProcCodeLenses(
    document: TextDocument
): Promise<CodeLens[]> {
    const symbolTable = symbolTables.get(document.uri);
    if (!symbolTable) {
        return [];
    }

    const settings = await getDocumentSettings(document.uri);
    if (settings.enableProcCodeLens === false) {
        return [];
    }

    const procScopes = collectProcScopes(symbolTable.getRootScope());
    if (procScopes.length === 0) {
        return [];
    }

    const lenses: CodeLens[] = [];
    for (const proc of procScopes) {
        const summary = analyzeInstructionRange(
            document,
            proc.range,
            symbolTable,
            symbolTables,
            includesGraph,
            settings.implicitImports
        );

        const allLocations = getAllReferenceLocationsForEntity(
            proc,
            symbolTables,
            includesGraph,
            settings.implicitImports
        );
        const refLocations = allLocations.filter(
            loc => !isSameLocationStart(loc, proc.uri, proc.definition.start.line, proc.definition.start.character)
        );
        const refCount = refLocations.length;

        const parts: string[] = [];
        const byteText = summary.minBytes === summary.maxBytes
            ? `${summary.minBytes} B`
            : `${summary.minBytes}–${summary.maxBytes} B`;
        parts.push(byteText);

        if (summary.instructionCount > 0) {
            const cycleText = summary.minCycles === summary.maxCycles
                ? `${summary.minCycles} cycles`
                : `${summary.minCycles}–${summary.maxCycles} cycles`;
            parts.push(cycleText);
        }

        const refText = refCount === 1 ? '1 reference' : `${refCount} references`;
        parts.push(refText);

        lenses.push({
            range: proc.definition,
            command: {
                title: parts.join(' · '),
                command: refCount > 0 ? 'ca65.showProcReferences' : '',
                arguments: refCount > 0 ? [document.uri, proc.definition.start, refLocations] : undefined,
            },
        });
    }

    return lenses;
}

export function initializeCodeLensProvider(connection: _Connection, documents: TextDocuments<TextDocument>): void {
    connection.onCodeLens(async (params: CodeLensParams): Promise<CodeLens[]> => {
        await initializationGate.isInitialized;
        await ensureDocumentRefreshed?.(params.textDocument.uri);

        return performanceMonitor.timeAsync('onCodeLens', async () => {
            const document = documents.get(params.textDocument.uri);
            if (!document) {
                return [];
            }
            return computeProcCodeLenses(document);
        });
    });
}
