import * as path from 'path';
import {
	workspace,
	ExtensionContext,
	commands,
	window,
	StatusBarAlignment,
	MarkdownString,
	TextEditor,
	TextDocumentContentProvider,
	TextEditorRevealType,
	EventEmitter,
	ViewColumn,
	Range as VscodeRange,
	Position as VscodePosition,
	Location as VscodeLocation,
} from "vscode";
import {
	LanguageClient,
	LanguageClientOptions,
	ServerOptions,
	TransportKind
} from 'vscode-languageclient/node';
import * as fs from 'fs/promises';
import * as os from 'os';
import { Uri } from 'vscode';


let client: LanguageClient;

export function activate(context: ExtensionContext) {
	// ADDED: Log to confirm the extension is activating
	console.log('Activating ca65 extension...');

	// --- Start the Language Server ---
	let serverModule = context.asAbsolutePath(
		path.join('server', 'out', 'server.js')
	);

	const serverOptions: ServerOptions = {
		run: { module: serverModule, transport: TransportKind.ipc },
		debug: {
			module: serverModule,
			transport: TransportKind.ipc,
			options: { execArgv: ['--nolazy', '--inspect=6009'] },
		},
	};

	// Watch files that match the defined language extensions and user overrides
	const langContribution = context.extension.packageJSON.contributes.languages.find(
		(lang: any) => lang.id === 'ca65'
	);
	const baseExtensions: string[] = langContribution?.extensions?.length
		? langContribution.extensions
		: ['.s', '.asm', '.inc'];
	const rawAdditional = workspace.getConfiguration('ca65').get<unknown>('additionalExtensions');
	const additionalExtensions = Array.isArray(rawAdditional)
		? rawAdditional.filter((ext): ext is string => typeof ext === 'string')
		: [];
	const normalizedExtensions = Array.from(new Set(
		[...baseExtensions, ...additionalExtensions]
			.map((ext) => ext.trim().replace(/^\./, ''))
			.filter((ext) => ext.length > 0)
	));

	const fileWatchers: ReturnType<typeof workspace.createFileSystemWatcher>[] = [];
	if (normalizedExtensions.length > 0) {
		const fileWatcherPattern = normalizedExtensions.length === 1
			? `**/*.${normalizedExtensions[0]}`
			: `**/*.{${normalizedExtensions.join(',')}}`;
		fileWatchers.push(workspace.createFileSystemWatcher(fileWatcherPattern));
	}

	const associations = workspace.getConfiguration('files').get<Record<string, unknown>>('associations');
	if (associations && typeof associations === 'object') {
		for (const [pattern, lang] of Object.entries(associations)) {
			if (lang === 'ca65' && pattern.length > 0) {
				const glob = pattern.includes('/') ? pattern : `**/${pattern}`;
				fileWatchers.push(workspace.createFileSystemWatcher(glob));
			}
		}
	}
	context.subscriptions.push(...fileWatchers);

	const clientOptions: LanguageClientOptions = {
		documentSelector: [{ scheme: 'file', language: 'ca65' }],
		synchronize: {
			configurationSection: 'ca65',
			fileEvents: fileWatchers
		},
	};

	client = new LanguageClient(
		'ca65LanguageServer',
		'ca65 Language Server',
		serverOptions,
		clientOptions
	);

	const clientReady = Promise.resolve(client.start());
	console.log('ca65 Language Client started.');

	// --- Register the "Show Reference" Command ---
	context.subscriptions.push(commands.registerCommand('ca65.showReference', () => {
		return showReferencePanel(context);
	}));

	context.subscriptions.push(commands.registerCommand(
		'ca65.showProcReferences',
		async (
			uriStr: string,
			position: { line: number; character: number },
			locations: Array<{ uri: string; range: { start: { line: number; character: number }; end: { line: number; character: number } } }>
		) => {
			if (!locations || locations.length === 0) {
				return;
			}
			const parsedUri = Uri.parse(uriStr);
			const vscodePos = new VscodePosition(position.line, position.character);
			const vscodeLocs = locations.map(loc => new VscodeLocation(
				Uri.parse(loc.uri),
				new VscodeRange(loc.range.start.line, loc.range.start.character, loc.range.end.line, loc.range.end.character)
			));
			return commands.executeCommand('editor.action.showReferences', parsedUri, vscodePos, vscodeLocs);
		}
	));

	const dumpCommands: ReadonlyArray<[string, string]> = [
		['ca65.dumpPerformanceStats', 'ca65/dumpPerformanceStats'],
		['ca65.dumpSymbolTables', 'ca65/dumpSymbolTables'],
		['ca65.dumpIncludesGraph', 'ca65/dumpIncludesGraph'],
		['ca65.dumpExportsMap', 'ca65/dumpExportsMap'],
	];
	for (const [commandId, requestMethod] of dumpCommands) {
		context.subscriptions.push(commands.registerCommand(commandId, async () => {
			if (client) {
				await clientReady;
				return client.sendRequest(requestMethod);
			}
		}));
	}

	// --- Status Bar Cycle & Byte Estimator ---
	setupCycleStatusBar(context, clientReady);

	// --- Read-Only Side-by-Side .lst / --dbgfile Listing ---
	setupSideBySideHexListing(context, clientReady);
}

interface InstructionAnalysisItem {
	line: number;
	mnemonic: string;
	mode: string;
	minBytes: number;
	maxBytes: number;
	minCycles: number;
	maxCycles: number;
	uncertainMode?: boolean;
	hasBranchPenalty?: boolean;
	hasPagePenalty?: boolean;
}

interface InstructionAnalysisSummary {
	instructionCount: number;
	minBytes: number;
	maxBytes: number;
	minCycles: number;
	maxCycles: number;
	uncertainCount: number;
	hasBranchPenalty: boolean;
	hasPagePenalty: boolean;
	items: InstructionAnalysisItem[];
}

function formatRangeValue(min: number, max: number, unit: string): string {
	return min === max ? `${min} ${unit}` : `${min}–${max} ${unit}`;
}

function buildCycleTooltip(result: InstructionAnalysisSummary, isSelection: boolean): MarkdownString {
	const header = isSelection ? 'Selection Timing & Size' : 'Instruction Timing & Size';
	const cycText = formatRangeValue(result.minCycles, result.maxCycles, 'cycles');
	const byteText = formatRangeValue(result.minBytes, result.maxBytes, 'bytes');

	const lines: string[] = [
		`**${header}**`,
		``,
		`- **Instructions:** ${result.instructionCount}`,
		`- **Bytes:** ${byteText}`,
		`- **Cycles:** ${cycText}`,
	];

	const notes: string[] = [];
	if (result.hasBranchPenalty) {
		notes.push('Branch instructions add +1 cycle when taken (+1 more if crossing a page)');
	}
	if (result.items.some(item => item.hasPagePenalty && !item.hasBranchPenalty)) {
		notes.push('Indexed/indirect modes may add +1 cycle when crossing a page boundary');
	}
	if (result.uncertainCount > 0) {
		notes.push(`${result.uncertainCount} instruction(s) have unknown Zero Page vs Absolute width (shown as range)`);
	}
	if (notes.length > 0) {
		lines.push('', ...notes.map(n => `*${n}*`));
	}

	const maxPreviewRows = 15;
	if (result.items.length > 0) {
		lines.push('', '| Line | Instruction | Mode | Bytes | Cycles |', '|---:|---|---|---:|---:|');
		for (const item of result.items.slice(0, maxPreviewRows)) {
			const byteCell = item.minBytes === item.maxBytes
				? `${item.minBytes}`
				: `${item.minBytes}–${item.maxBytes}`;
			const cycCell = item.minCycles === item.maxCycles
				? `${item.minCycles}`
				: `${item.minCycles}–${item.maxCycles}`;
			lines.push(`| ${item.line + 1} | \`${item.mnemonic}\` | ${item.mode}${item.uncertainMode ? ' ?' : ''} | ${byteCell} | ${cycCell} |`);
		}
		if (result.items.length > maxPreviewRows) {
			lines.push('', `*…and ${result.items.length - maxPreviewRows} more instruction(s)*`);
		}
	}

	return new MarkdownString(lines.join('\n'));
}

function setupCycleStatusBar(context: ExtensionContext, clientReady: Promise<void>): void {
	const statusBarItem = window.createStatusBarItem(StatusBarAlignment.Right, 100);
	context.subscriptions.push(statusBarItem);

	let debounceTimer: NodeJS.Timeout | undefined;
	let latestSeq = 0;
	let lastQueryKey = '';

	const updateForEditor = (editor: TextEditor | undefined, force: boolean = false) => {
		const enabled = workspace.getConfiguration('ca65').get<boolean>('enableStatusBarCycleCount', true);
		if (!enabled || !editor || editor.document.languageId !== 'ca65') {
			if (debounceTimer) {
				clearTimeout(debounceTimer);
				debounceTimer = undefined;
			}
			lastQueryKey = '';
			statusBarItem.hide();
			return;
		}

		const sel = editor.selection;
		const isSelection = !sel.isEmpty;
		const queryKey = isSelection
			? `${editor.document.uri.toString()}|${editor.document.version}|S:${sel.start.line}:${sel.start.character}-${sel.end.line}:${sel.end.character}`
			: `${editor.document.uri.toString()}|${editor.document.version}|L:${sel.active.line}`;

		if (!force && queryKey === lastQueryKey) {
			return;
		}
		lastQueryKey = queryKey;

		if (debounceTimer) {
			clearTimeout(debounceTimer);
			debounceTimer = undefined;
		}

		const seq = ++latestSeq;
		debounceTimer = setTimeout(async () => {
			try {
				await clientReady;
				if (seq !== latestSeq || window.activeTextEditor !== editor) return;

				const targetRange = isSelection
					? {
						start: { line: sel.start.line, character: sel.start.character },
						end: { line: sel.end.line, character: sel.end.character },
					}
					: {
						start: { line: sel.active.line, character: 0 },
						end: { line: sel.active.line, character: editor.document.lineAt(sel.active.line).text.length },
					};

				const result = await client.sendRequest<InstructionAnalysisSummary | null>('ca65/analyzeSelection', {
					uri: editor.document.uri.toString(),
					range: targetRange,
				});

				if (seq !== latestSeq || window.activeTextEditor !== editor) return;
				if (!result || result.instructionCount === 0) {
					statusBarItem.hide();
					return;
				}

				const cycStr = formatRangeValue(result.minCycles, result.maxCycles, 'cyc');
				const byteStr = formatRangeValue(result.minBytes, result.maxBytes, 'B');
				const detail = result.instructionCount === 1
					? `${result.items[0].mnemonic} ${result.items[0].mode}${result.items[0].uncertainMode ? '?' : ''}`
					: `${result.instructionCount} ops`;

				statusBarItem.text = `$(clock) ${cycStr} · ${byteStr} (${detail})`;
				statusBarItem.tooltip = buildCycleTooltip(result, isSelection);
				statusBarItem.show();
			} catch {
				if (seq === latestSeq) {
					lastQueryKey = '';
					statusBarItem.hide();
				}
			}
		}, 80);
	};

	context.subscriptions.push(
		window.onDidChangeActiveTextEditor((editor) => updateForEditor(editor, true)),
		window.onDidChangeTextEditorSelection((event) => {
			if (event.textEditor === window.activeTextEditor) {
				updateForEditor(event.textEditor);
			}
		}),
		workspace.onDidChangeTextDocument((event) => {
			if (window.activeTextEditor && event.document === window.activeTextEditor.document) {
				updateForEditor(window.activeTextEditor, true);
			}
		}),
		workspace.onDidChangeConfiguration((event) => {
			if (event.affectsConfiguration('ca65.enableStatusBarCycleCount')) {
				updateForEditor(window.activeTextEditor, true);
			}
		}),
		{ dispose: () => { if (debounceTimer) clearTimeout(debounceTimer); } },
	);

	updateForEditor(window.activeTextEditor, true);
}

interface OverlayLineItem {
	line: number;
	addressLabel: string;
	bytesText?: string;
	byteCount: number;
}

interface OverlayDataResponse {
	source: 'live-lst' | 'none';
	stale?: boolean;
	error?: boolean;
	lines: OverlayLineItem[];
}

const LISTING_SCHEME = 'ca65-listing';

function formatCompactBytes(bytesText: string, byteCount: number, maxInlineBytes: number = 6): string {
	const parts = bytesText.split(/\s+/);
	if (parts.length <= maxInlineBytes) {
		return parts.join(' ');
	}
	return `${parts.slice(0, maxInlineBytes).join(' ')}… (${byteCount}B)`;
}

function buildListingUri(sourceUri: Uri): Uri {
	const baseName = path.basename(sourceUri.fsPath) || 'listing';
	return Uri.from({
		scheme: LISTING_SCHEME,
		path: `/${baseName}.lst`,
		query: encodeURIComponent(sourceUri.toString()),
	});
}

function getSourceUriFromListingUri(listingUri: Uri): Uri | null {
	if (listingUri.scheme !== LISTING_SCHEME || !listingUri.query) {
		return null;
	}
	try {
		return Uri.parse(decodeURIComponent(listingUri.query));
	} catch {
		return null;
	}
}

function formatSideBySideListing(
	sourceLines: string[],
	data: OverlayDataResponse
): string {
	const byLine = new Map<number, OverlayLineItem>();
	for (const item of data.lines) {
		if (item.line >= 0 && item.line < sourceLines.length) {
			byLine.set(item.line, item);
		}
	}

	const output: string[] = [];
	for (let line = 0; line < sourceLines.length; line++) {
		const item = byLine.get(line);
		const addrCol = (item ? item.addressLabel : '').padEnd(10, ' ');
		const bytesText = item?.bytesText
			? formatCompactBytes(item.bytesText, item.byteCount, 6)
			: '';
		const bytesCol = bytesText.length < 20 ? bytesText.padEnd(20, ' ') : `${bytesText} `;
		output.push(`${addrCol}${bytesCol}| ${sourceLines[line]}`);
	}
	return output.join('\n');
}

function setupSideBySideHexListing(context: ExtensionContext, clientReady: Promise<void>): void {
	const onDidChangeEmitter = new EventEmitter<Uri>();
	const lastMetadataByListingUri = new Map<string, OverlayDataResponse>();
	const overlayStatusBadge = window.createStatusBarItem(StatusBarAlignment.Right, 99);
	context.subscriptions.push(onDidChangeEmitter, overlayStatusBadge);

	const updateStatusBadge = () => {
		const active = window.activeTextEditor;
		if (!active) {
			overlayStatusBadge.hide();
			return;
		}

		let meta: OverlayDataResponse | undefined;
		if (active.document.uri.scheme === LISTING_SCHEME) {
			meta = lastMetadataByListingUri.get(active.document.uri.toString());
		} else if (active.document.languageId === 'ca65') {
			const expectedListingUri = buildListingUri(active.document.uri).toString();
			const isListingVisible = window.visibleTextEditors.some(
				e => e.document.uri.toString() === expectedListingUri
			);
			if (isListingVisible) {
				meta = lastMetadataByListingUri.get(expectedListingUri);
			}
		}

		if (!meta) {
			overlayStatusBadge.hide();
			return;
		}

		if (meta.source === 'none') {
			if (meta.error) {
				overlayStatusBadge.text = '$(warning) ca65 -l (assembly error)';
				overlayStatusBadge.tooltip = 'ca65 assembly failed; click to view Problems.';
				overlayStatusBadge.command = 'workbench.actions.view.problems';
				overlayStatusBadge.show();
			} else {
				overlayStatusBadge.hide();
			}
			return;
		}

		const totalBytes = meta.lines.reduce((sum, entry) => sum + entry.byteCount, 0);
		if (meta.stale) {
			overlayStatusBadge.text = meta.error
				? `$(warning) ca65 -l · ${totalBytes} B (stale — assembly error)`
				: `$(warning) ca65 -l · ${totalBytes} B (stale)`;
			overlayStatusBadge.tooltip = `Showing last valid ca65 -l listing (${totalBytes} bytes emitted). Fix errors and save to update (click to open Problems).`;
			overlayStatusBadge.command = 'workbench.actions.view.problems';
		} else {
			overlayStatusBadge.text = `$(file-binary) ca65 -l · ${totalBytes} B`;
			overlayStatusBadge.tooltip = `Side-by-side listing from ca65 -l (${totalBytes} bytes emitted in this file). Click to refresh.`;
			overlayStatusBadge.command = 'ca65.showHexListing';
		}
		overlayStatusBadge.show();
	};

	const provider: TextDocumentContentProvider = {
		onDidChange: onDidChangeEmitter.event,
		async provideTextDocumentContent(listingUri: Uri): Promise<string> {
			const sourceUri = getSourceUriFromListingUri(listingUri);
			if (!sourceUri) {
				return '; Invalid ca65 listing URI.';
			}

			await clientReady;
			const srcDoc = await workspace.openTextDocument(sourceUri);
			const data = await client.sendRequest<OverlayDataResponse>('ca65/getOverlayData', {
				uri: sourceUri.toString(),
			});

			lastMetadataByListingUri.set(listingUri.toString(), data);
			updateStatusBadge();

			if (!data || data.source === 'none') {
				return data?.error
					? '; Cannot generate ca65 -l listing due to assembly errors. Fix errors and save to update.'
					: '; ca65 listing unavailable (ensure ca65 is installed or configured via ca65.executablePath).';
			}

			const sourceLines = srcDoc.getText().split(/\r?\n/);
			return formatSideBySideListing(sourceLines, data);
		},
	};

	const refreshVisibleListings = () => {
		for (const editor of window.visibleTextEditors) {
			if (editor.document.uri.scheme === LISTING_SCHEME) {
				onDidChangeEmitter.fire(editor.document.uri);
			}
		}
		updateStatusBadge();
	};

	context.subscriptions.push(
		workspace.registerTextDocumentContentProvider(LISTING_SCHEME, provider),
		window.onDidChangeActiveTextEditor(() => updateStatusBadge()),
		window.onDidChangeVisibleTextEditors(() => updateStatusBadge()),
		workspace.onDidSaveTextDocument((doc) => {
			if (doc.languageId === 'ca65') {
				refreshVisibleListings();
			}
		}),
		commands.registerCommand('ca65.showHexListing', async () => {
			const activeEditor = window.activeTextEditor;
			if (!activeEditor || activeEditor.document.languageId !== 'ca65') {
				window.showInformationMessage('Open a ca65 source file to view its hex & address listing.');
				return;
			}

			const activeLine = activeEditor.selection.active.line;
			const listingUri = buildListingUri(activeEditor.document.uri);
			onDidChangeEmitter.fire(listingUri);

			const listingDoc = await workspace.openTextDocument(listingUri);
			const shownEditor = await window.showTextDocument(listingDoc, {
				viewColumn: ViewColumn.Beside,
				preserveFocus: true,
				preview: true,
			});

			const clampedLine = Math.min(activeLine, Math.max(0, listingDoc.lineCount - 1));
			shownEditor.revealRange(
				new VscodeRange(clampedLine, 0, clampedLine, 0),
				TextEditorRevealType.InCenterIfOutsideViewport
			);
			updateStatusBadge();
		}),
	);
}

export function deactivate(): Thenable<void> | undefined {
	if (!client) {
		return undefined;
	}
	return client.stop();
}

let cachedReferenceMarkdown: string | undefined;

// --- Implementation for the "Show Reference" Panel ---
async function showReferencePanel(context: ExtensionContext) {
	if (!cachedReferenceMarkdown) {
		// 1. Load the JSON data
		const dataPath = context.asAbsolutePath(path.join('server', 'data', '6502_mnemonics.json'));
		const rawData = await fs.readFile(dataPath, 'utf8');
		const jsonData = JSON.parse(rawData);

		// 2. Generate the full Markdown string
		cachedReferenceMarkdown = generateFullMarkdown(jsonData);
	}

	// Save to a temp file
	const tmpDir = os.tmpdir();
	const filePath = path.join(tmpDir, 'ca65-reference.md');
	await fs.writeFile(filePath, cachedReferenceMarkdown, 'utf-8');
	const fileUri = Uri.file(filePath);

	// Show the preview (no editor tab)
	await commands.executeCommand('markdown.showPreviewToSide', fileUri);
}

const FLAG_NAMES: Record<string, string> = {
	N: "Negative",
	V: "Overflow",
	B: "Break",
	D: "Decimal",
	I: "Interrupt",
	Z: "Zero",
	C: "Carry"
};

function generateTypeTable(): string {
	const link = (mnemonic: string) => `[${mnemonic}](#${mnemonic.toLowerCase()})`;

	return `
| Type      | Instructions                                                                 |
|-----------|------------------------------------------------------------------------------|
| Access    | ${link('LDA')}, ${link('STA')}, ${link('LDX')}, ${link('STX')}, ${link('LDY')}, ${link('STY')}                                                 |
| Transfer  | ${link('TAX')}, ${link('TXA')}, ${link('TAY')}, ${link('TYA')}                                                           |
| Arithmetic| ${link('ADC')}, ${link('SBC')}, ${link('INC')}, ${link('DEC')}, ${link('INX')}, ${link('DEX')}, ${link('INY')}, ${link('DEY')}                                       |
| Shift     | ${link('ASL')}, ${link('LSR')}, ${link('ROL')}, ${link('ROR')}                                                           |
| Bitwise   | ${link('AND')}, ${link('ORA')}, ${link('EOR')}, ${link('BIT')}                                                           |
| Compare   | ${link('CMP')}, ${link('CPX')}, ${link('CPY')}                                                                |
| Branch    | ${link('BCC')}, ${link('BCS')}, ${link('BEQ')}, ${link('BNE')}, ${link('BPL')}, ${link('BMI')}, ${link('BVC')}, ${link('BVS')}                                       |
| Jump      | ${link('JMP')}, ${link('JSR')}, ${link('RTS')}, ${link('BRK')}, ${link('RTI')}                                                      |
| Stack     | ${link('PHA')}, ${link('PLA')}, ${link('PHP')}, ${link('PLP')}, ${link('TXS')}, ${link('TSX')}                                                 |
| Flags     | ${link('CLC')}, ${link('SEC')}, ${link('CLI')}, ${link('SEI')}, ${link('CLD')}, ${link('SED')}, ${link('CLV')}                                            |
| Other     | ${link('NOP')}                                                                          |
\n`;
}

// --- Helper to Generate the Full Markdown Reference ---
function generateFullMarkdown(jsonData: any): string {
	let fullMarkdown = "# Instruction reference\n\n";
	fullMarkdown += "## Official instructions by type\n\n";
	fullMarkdown += generateTypeTable();
	fullMarkdown += "\n___\n\n";

	fullMarkdown += "## Official instructions\n\n";

	for (const mnemonic in jsonData) {
		const data = jsonData[mnemonic];

		// Title
		fullMarkdown += `### <a id="${mnemonic.toLowerCase()}"></a>\`${mnemonic}\` - ${data.fullName || ''}\n\n`;

		// Description
		if (data.description) {
			fullMarkdown += `${data.description}\n\n`;
		}

		// Warning
		if (data.warning) {
			fullMarkdown += `⚠️ **WARNING**: ${data.warning}\n\n`;
		}

		if (data.note) {
			fullMarkdown += `*Note: ${data.note}*\n\n`;
		}

		// Flags
		if (data.flagChanges && Object.keys(data.flagChanges).length > 0) {
			fullMarkdown += `| Flag | New Value |\n`;
			fullMarkdown += `|------|-----------|\n`;
			for (const flag of Object.keys(data.flagChanges)) {
				const name = FLAG_NAMES[flag] || flag;
				fullMarkdown += `| \`${flag}\` - ${name} | ${data.flagChanges[flag]} |\n`;
			}
			fullMarkdown += `\n`;
		}

		// Addressing Modes Table
		if (data.modes && Object.keys(data.modes).length > 0) {
			fullMarkdown += `| Addressing Mode | Opcode | Bytes | Cycles |\n`;
			fullMarkdown += `|------|--------|-------|--------|\n`;
			for (const modeName of Object.keys(data.modes)) {
				const mode = data.modes[modeName];
				let cycles = mode.cycles !== undefined ? `${mode.cycles}` : '';
				let notes: string[] = [];
				if (mode.branchPenalty) notes.push("+1 if branch taken");
				if (mode.pagePenalty) notes.push("+1 if page boundary crossed");
				if (notes.length > 0) cycles += ` (${notes.join(", ")})`;
				fullMarkdown += `| ${modeName} | \`${mode.opcode}\` | ${mode.bytes || ''} | ${cycles} |\n`;
			}
			fullMarkdown += `\n`;
		}

		// See also
		if (data.seeAlso && Array.isArray(data.seeAlso) && data.seeAlso.length > 0) {
			const seeAlsoLinks = data.seeAlso.map(
				(link: string) => `[${link}](#${link.toLowerCase()})`
			).join(', ');
			fullMarkdown += `**See also:** ${seeAlsoLinks}\n\n`;
		}

		fullMarkdown += "---\n\n";
	}
	return fullMarkdown;
}

