import * as path from 'path';
import {
	workspace,
	ExtensionContext,
	commands,
	window,
	StatusBarAlignment,
	StatusBarItem,
	MarkdownString,
	Position,
	Selection,
	TextEditor,
	TextDocumentContentProvider,
	TextEditorRevealType,
	EventEmitter,
	ViewColumn,
	Range as VscodeRange,
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
		return showReferencePanel(context, clientReady);
	}));

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

	// --- Status Bar Cycle, Byte Estimator & Active Segment ---
	setupCycleStatusBar(context, clientReady);
	setupSegmentStatusBar(context, clientReady);

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
	hasVariableWidth16?: boolean;
	hasDpOffsetPenalty?: boolean;
	hasEmulationPagePenalty?: boolean;
	hasPerByteCycles?: boolean;
}

interface InstructionAnalysisSummary {
	cpu?: string;
	instructionCount: number;
	minBytes: number;
	maxBytes: number;
	minCycles: number;
	maxCycles: number;
	uncertainCount: number;
	hasBranchPenalty: boolean;
	hasPagePenalty: boolean;
	hasVariableWidth16?: boolean;
	hasDpOffsetPenalty?: boolean;
	hasEmulationPagePenalty?: boolean;
	hasPerByteCycles?: boolean;
	items: InstructionAnalysisItem[];
}

function formatRangeValue(min: number, max: number, unit: string): string {
	return min === max ? `${min} ${unit}` : `${min}–${max} ${unit}`;
}

function buildCycleTooltip(result: InstructionAnalysisSummary, isSelection: boolean): MarkdownString {
	const header = isSelection ? 'Selection Timing & Size' : 'Instruction Timing & Size';
	const cpuTag = result.cpu && result.cpu !== '6502' ? ` (${result.cpu})` : '';
	const cycText = formatRangeValue(result.minCycles, result.maxCycles, 'cycles');
	const byteText = formatRangeValue(result.minBytes, result.maxBytes, 'bytes');

	const lines: string[] = [
		`**${header}${cpuTag}**`,
		``,
		`- **Instructions:** ${result.instructionCount}`,
		`- **Bytes:** ${byteText}`,
		`- **Cycles:** ${cycText}`,
	];

	const notes: string[] = [];
	if (result.hasBranchPenalty) {
		const branchHasPagePenalty = result.items.some(item => item.hasBranchPenalty && item.hasPagePenalty);
		notes.push(
			branchHasPagePenalty
				? 'Branch instructions add +1 cycle when taken (+1 more if crossing a page)'
				: 'Branch instructions add +1 cycle when taken'
		);
	}
	if (result.items.some(item => item.hasPagePenalty && !item.hasBranchPenalty)) {
		notes.push(
			result.cpu === '65816'
				? 'Indexed reads may add +1 cycle when crossing a page boundary or with 16-bit X/Y'
				: 'Indexed/indirect modes may add +1 cycle when crossing a page boundary'
		);
	}
	if (result.hasVariableWidth16) {
		notes.push('65816 M/X flags: cycles and immediate bytes shown as 8-bit to 16-bit range');
	}
	if (result.hasDpOffsetPenalty) {
		notes.push('Direct Page modes add +1 cycle when Direct Page register low byte DL ≠ 0');
	}
	if (result.hasEmulationPagePenalty) {
		notes.push('In Emulation mode (E=1), branch page crossings add +1 cycle');
	}
	if (result.hasPerByteCycles) {
		notes.push('Block move (mvn/mvp) executes 7 cycles per byte transferred (C + 1 bytes)');
	}
	if (result.uncertainCount > 0) {
		const zpName = result.cpu === '65816' ? 'Direct Page' : 'Zero Page';
		notes.push(`${result.uncertainCount} instruction(s) have unknown ${zpName} vs Absolute width (shown as range)`);
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
			lines.push(`| ${item.line + 1} | \`${item.mnemonic.toLowerCase()}\` | ${item.mode}${item.uncertainMode ? ' ?' : ''} | ${byteCell} | ${cycCell} |`);
		}
		if (result.items.length > maxPreviewRows) {
			lines.push('', `*…and ${result.items.length - maxPreviewRows} more instruction(s)*`);
		}
	}

	return new MarkdownString(lines.join('\n'));
}

interface SegmentPositionResult {
	segment: string;
	definitionLine: number;
	explicit: boolean;
	line: number;
}

interface CursorStatusBarConfig<TResult> {
	priority: number;
	settingKey: string;
	affectingSettings: string[];
	getQueryKey: (editor: TextEditor) => string;
	fetchData: (editor: TextEditor) => Promise<TResult>;
	applyResult: (item: StatusBarItem, result: TResult, editor: TextEditor) => void;
}

function registerCursorStatusBarUpdater<TResult>(
	context: ExtensionContext,
	clientReady: Promise<void>,
	config: CursorStatusBarConfig<TResult>
): void {
	const statusBarItem = window.createStatusBarItem(StatusBarAlignment.Right, config.priority);
	context.subscriptions.push(statusBarItem);

	let debounceTimer: NodeJS.Timeout | undefined;
	let latestSeq = 0;
	let lastQueryKey = '';

	const updateForEditor = (editor: TextEditor | undefined, force: boolean = false) => {
		const enabled = workspace.getConfiguration('ca65').get<boolean>(config.settingKey, true);
		if (!enabled || !editor || editor.document.languageId !== 'ca65') {
			if (debounceTimer) {
				clearTimeout(debounceTimer);
				debounceTimer = undefined;
			}
			lastQueryKey = '';
			statusBarItem.hide();
			return;
		}

		const queryKey = config.getQueryKey(editor);
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

				const result = await config.fetchData(editor);
				if (seq !== latestSeq || window.activeTextEditor !== editor) return;

				config.applyResult(statusBarItem, result, editor);
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
			if (config.affectingSettings.some(setting => event.affectsConfiguration(setting))) {
				updateForEditor(window.activeTextEditor, true);
			}
		}),
		{ dispose: () => { if (debounceTimer) clearTimeout(debounceTimer); } },
	);

	updateForEditor(window.activeTextEditor, true);
}

function buildSegmentTooltip(result: SegmentPositionResult, editor: TextEditor): MarkdownString {
	const targetLine = result.definitionLine + 1;
	if (!result.explicit) {
		return new MarkdownString(
			`**Active Segment:** \`${result.segment}\` *(default segment)*\n\n*Click to jump to top of file*`
		);
	}
	const directiveText = editor.document.lineAt(result.definitionLine).text.trim();
	const lines = [`**Active Segment:** \`${result.segment}\``, ''];
	if (directiveText) {
		const safeText = directiveText.replace(/`/g, "'");
		lines.push(`Set at line ${targetLine}: \`${safeText}\``);
	} else {
		lines.push(`Set at line ${targetLine}`);
	}
	lines.push('', `*Click to jump to line ${targetLine}*`);
	return new MarkdownString(lines.join('\n'));
}

function setupSegmentStatusBar(context: ExtensionContext, clientReady: Promise<void>): void {
	context.subscriptions.push(commands.registerCommand('_ca65.revealSegmentOrigin', async (uri?: Uri, line?: number) => {
		if (!uri || typeof line !== 'number') return;
		const active = window.activeTextEditor;
		const editor = (active && active.document.uri.toString() === uri.toString())
			? active
			: await workspace.openTextDocument(uri).then(doc => window.showTextDocument(doc, { preserveFocus: false }));
		const clampedLine = Math.max(0, Math.min(line, Math.max(0, editor.document.lineCount - 1)));
		const pos = new Position(clampedLine, 0);
		editor.selection = new Selection(pos, pos);
		editor.revealRange(new VscodeRange(pos, pos), TextEditorRevealType.InCenterIfOutsideViewport);
	}));

	registerCursorStatusBarUpdater<SegmentPositionResult | null>(context, clientReady, {
		priority: 101,
		settingKey: 'enableStatusBarSegment',
		affectingSettings: ['ca65.enableStatusBarSegment'],
		getQueryKey: (editor) => `${editor.document.uri.toString()}|${editor.document.version}|L:${editor.selection.active.line}`,
		fetchData: (editor) => client.sendRequest<SegmentPositionResult | null>('ca65/getSegmentAtPosition', {
			uri: editor.document.uri.toString(),
			line: editor.selection.active.line,
		}),
		applyResult: (item, result, editor) => {
			if (!result) {
				item.hide();
				return;
			}
			item.text = `$(layers) ${result.segment}`;
			item.tooltip = buildSegmentTooltip(result, editor);
			item.command = {
				command: '_ca65.revealSegmentOrigin',
				title: 'Jump to Segment Origin',
				arguments: [editor.document.uri, result.definitionLine],
			};
			item.show();
		},
	});
}

function setupCycleStatusBar(context: ExtensionContext, clientReady: Promise<void>): void {
	registerCursorStatusBarUpdater<InstructionAnalysisSummary | null>(context, clientReady, {
		priority: 100,
		settingKey: 'enableStatusBarCycleCount',
		affectingSettings: ['ca65.enableStatusBarCycleCount', 'ca65.cpu'],
		getQueryKey: (editor) => {
			const sel = editor.selection;
			return !sel.isEmpty
				? `${editor.document.uri.toString()}|${editor.document.version}|S:${sel.start.line}:${sel.start.character}-${sel.end.line}:${sel.end.character}`
				: `${editor.document.uri.toString()}|${editor.document.version}|L:${sel.active.line}`;
		},
		fetchData: (editor) => {
			const sel = editor.selection;
			const targetRange = !sel.isEmpty
				? {
					start: { line: sel.start.line, character: sel.start.character },
					end: { line: sel.end.line, character: sel.end.character },
				}
				: {
					start: { line: sel.active.line, character: 0 },
					end: { line: sel.active.line, character: editor.document.lineAt(sel.active.line).text.length },
				};
			return client.sendRequest<InstructionAnalysisSummary | null>('ca65/analyzeSelection', {
				uri: editor.document.uri.toString(),
				range: targetRange,
			});
		},
		applyResult: (item, result, editor) => {
			if (!result || result.instructionCount === 0) {
				item.hide();
				return;
			}

			const isSelection = !editor.selection.isEmpty;
			const cycStr = formatRangeValue(result.minCycles, result.maxCycles, 'cyc');
			const byteStr = formatRangeValue(result.minBytes, result.maxBytes, 'B');
			const detail = result.instructionCount === 1
				? `${result.items[0].mnemonic.toLowerCase()} ${result.items[0].mode}${result.items[0].uncertainMode ? '?' : ''}`
				: `${result.instructionCount} ops`;

			item.text = `$(clock) ${cycStr} · ${byteStr} (${detail})`;
			item.tooltip = buildCycleTooltip(result, isSelection);
			item.show();
		},
	});
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

const cachedReferenceMarkdownByCpu = new Map<string, string>();

// --- Implementation for the "Show Reference" Panel ---
async function showReferencePanel(context: ExtensionContext, clientReady: Promise<void>) {
	const activeUri = window.activeTextEditor?.document.uri;
	const configuredCpu = workspace.getConfiguration('ca65', activeUri).get<string>('cpu') || '6502';

	let targetCpu = configuredCpu;
	let markdown = cachedReferenceMarkdownByCpu.get(configuredCpu);

	if (!markdown) {
		let jsonData: Record<string, any> | undefined;
		if (client) {
			try {
				await clientReady;
				const response = await client.sendRequest<{ cpu: string; mnemonics: Record<string, any> }>(
					'ca65/getReferenceData',
					{ uri: activeUri?.toString(), cpu: configuredCpu }
				);
				if (response?.mnemonics) {
					targetCpu = response.cpu || configuredCpu;
					jsonData = response.mnemonics;
				}
			} catch {
				// Fall back to base 6502 reference JSON if server request fails
			}
		}

		if (!jsonData) {
			const dataPath = context.asAbsolutePath(path.join('server', 'data', '6502_mnemonics.json'));
			const rawData = await fs.readFile(dataPath, 'utf8');
			jsonData = JSON.parse(rawData);
			targetCpu = '6502';
		}

		markdown = generateFullMarkdown(jsonData!, targetCpu);
		cachedReferenceMarkdownByCpu.set(targetCpu, markdown);
	}

	// Save to a temp file
	const tmpDir = os.tmpdir();
	const safeCpuSlug = targetCpu.toLowerCase().replace(/[^a-z0-9_-]/g, '');
	const filePath = path.join(tmpDir, `ca65-reference-${safeCpuSlug}.md`);
	await fs.writeFile(filePath, markdown, 'utf-8');
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
	C: "Carry",
	E: "Emulation",
	P: "Processor Status"
};

function generateTypeTable(jsonData: Record<string, any>): string {
	const link = (mnemonic: string) => `[${mnemonic.toLowerCase()}](#${mnemonic.toLowerCase()})`;
	const formatGroup = (list: string[]) => list.filter(m => Boolean(jsonData[m])).map(link).join(', ');

	const rows: Array<[string, string[]]> = [
		['Access', ['LDA', 'STA', 'LDX', 'STX', 'LDY', 'STY', 'STZ']],
		['Transfer', ['TAX', 'TXA', 'TAY', 'TYA', 'TCD', 'TAD', 'TDC', 'TDA', 'TCS', 'TAS', 'TSC', 'TSA', 'TXY', 'TYX', 'XBA', 'SWA', 'XCE']],
		['Arithmetic', ['ADC', 'SBC', 'INC', 'INA', 'DEC', 'DEA', 'INX', 'DEX', 'INY', 'DEY']],
		['Shift', ['ASL', 'LSR', 'ROL', 'ROR']],
		['Bitwise', ['AND', 'ORA', 'EOR', 'BIT', 'TSB', 'TRB', 'RMB0', 'RMB1', 'RMB2', 'RMB3', 'RMB4', 'RMB5', 'RMB6', 'RMB7', 'SMB0', 'SMB1', 'SMB2', 'SMB3', 'SMB4', 'SMB5', 'SMB6', 'SMB7']],
		['Compare', ['CMP', 'CPA', 'CPX', 'CPY']],
		['Branch', ['BCC', 'BCS', 'BEQ', 'BNE', 'BPL', 'BMI', 'BVC', 'BVS', 'BRA', 'BRL', 'BBR0', 'BBR1', 'BBR2', 'BBR3', 'BBR4', 'BBR5', 'BBR6', 'BBR7', 'BBS0', 'BBS1', 'BBS2', 'BBS3', 'BBS4', 'BBS5', 'BBS6', 'BBS7']],
		['Jump & Call', ['JMP', 'JML', 'JSR', 'JSL', 'RTS', 'RTL', 'BRK', 'COP', 'RTI']],
		['Stack', ['PHA', 'PLA', 'PHP', 'PLP', 'PHX', 'PLX', 'PHY', 'PLY', 'PHB', 'PLB', 'PHD', 'PLD', 'PHK', 'PEA', 'PEI', 'PER', 'TXS', 'TSX']],
		['Flags & Ctrl', ['CLC', 'SEC', 'CLI', 'SEI', 'CLD', 'SED', 'CLV', 'REP', 'SEP']],
		['Block & Other', ['MVN', 'MVP', 'NOP', 'WAI', 'STP', 'WDM']],
	];

	let table = `\n| Type | Instructions |\n|------|--------------|\n`;
	for (const [label, candidates] of rows) {
		const formatted = formatGroup(candidates);
		if (formatted) {
			table += `| ${label} | ${formatted} |\n`;
		}
	}
	return `${table}\n`;
}

function formatReferenceModeBytes(mode: any): string {
	if (mode.bytes === undefined) return '';
	if (mode.byteVariableM) return `${mode.bytes}–${mode.bytes + 1} (M)`;
	if (mode.byteVariableX) return `${mode.bytes}–${mode.bytes + 1} (X)`;
	return `${mode.bytes}`;
}

function formatReferenceModeCycles(mode: any): string {
	if (mode.cycles === undefined) return '';
	if (mode.perByteCycles) return `${mode.cycles}/byte`;
	const notes: string[] = [];
	if (mode.branchPenalty) notes.push("+1 if branch taken");
	if (mode.pagePenalty) notes.push("+1 if page boundary crossed");
	if (mode.pageOrIndex16Penalty) notes.push("+1 if page crossed or 16-bit X/Y");
	if (mode.emulationOnlyPagePenalty) notes.push("+1 page if E=1");
	if (mode.cycleVariableM) notes.push(`+${mode.cycleVariableM} if 16-bit M`);
	if (mode.cycleVariableX) notes.push(`+${mode.cycleVariableX} if 16-bit X`);
	if (mode.dpNonZeroPenalty) notes.push("+1 if DL≠0");
	if (mode.nativeModeCyclePenalty) notes.push(`+${mode.nativeModeCyclePenalty} if E=0`);
	return notes.length > 0 ? `${mode.cycles} (${notes.join(", ")})` : `${mode.cycles}`;
}

// --- Helper to Generate the Full Markdown Reference ---
function generateFullMarkdown(jsonData: Record<string, any>, cpu: string = '6502'): string {
	let fullMarkdown = `# Instruction reference (${cpu})\n\n`;
	fullMarkdown += "## Instructions by type\n\n";
	fullMarkdown += generateTypeTable(jsonData);
	fullMarkdown += "\n___\n\n";

	fullMarkdown += "## Instructions\n\n";

	const sortedMnemonics = Object.keys(jsonData).sort();
	for (const mnemonic of sortedMnemonics) {
		const data = jsonData[mnemonic];

		// Title
		fullMarkdown += `### <a id="${mnemonic.toLowerCase()}"></a>\`${mnemonic.toLowerCase()}\` - ${data.fullName || ''}\n\n`;

		// Description
		if (data.description) {
			fullMarkdown += `${data.description}\n\n`;
		}

		// Warning
		if (data.warning) {
			fullMarkdown += `⚠️ **Warning**: ${data.warning}\n\n`;
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
				const bytes = formatReferenceModeBytes(mode);
				const cycles = formatReferenceModeCycles(mode);
				fullMarkdown += `| ${modeName} | \`${mode.opcode}\` | ${bytes} | ${cycles} |\n`;
			}
			fullMarkdown += `\n`;
		}

		// See also
		if (data.seeAlso && Array.isArray(data.seeAlso) && data.seeAlso.length > 0) {
			const seeAlsoLinks = data.seeAlso
				.filter((link: string) => Boolean(jsonData[link.toUpperCase()]))
				.map((link: string) => `[${link.toLowerCase()}](#${link.toLowerCase()})`)
				.join(', ');
			if (seeAlsoLinks) {
				fullMarkdown += `**See also:** ${seeAlsoLinks}\n\n`;
			}
		}

		fullMarkdown += "---\n\n";
	}
	return fullMarkdown;
}

