import * as path from 'path';
import * as crypto from 'crypto';
import {
	workspace,
	ExtensionContext,
	WorkspaceConfiguration,
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
	WebviewPanel,
	Event,
	EventEmitter,
	FileSystemWatcher,
	Disposable,
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
import { Uri } from 'vscode';
import { CBridge, createCa65BridgeMiddleware } from './cBridge';
import { setupCc65AssemblyView } from './cc65AssemblyView';


let client: LanguageClient;
let cBridgeInstance: CBridge | undefined;

function hasExplicitConfigValue(cfg: WorkspaceConfiguration, key: string): boolean {
	const inspected = cfg.inspect(key);
	if (!inspected) return false;
	return (
		inspected.globalValue !== undefined
		|| inspected.workspaceValue !== undefined
		|| inspected.workspaceFolderValue !== undefined
		|| inspected.globalLanguageValue !== undefined
		|| inspected.workspaceLanguageValue !== undefined
		|| inspected.workspaceFolderLanguageValue !== undefined
	);
}

function resolveEffectiveCa65Extensions(cfg: WorkspaceConfiguration, defaultExtensions: string[]): string[] {
	if (hasExplicitConfigValue(cfg, 'fileExtensions')) {
		const raw = cfg.get<unknown>('fileExtensions');
		return Array.isArray(raw) ? raw.filter((ext): ext is string => typeof ext === 'string') : [];
	}
	const rawLegacy = cfg.get<unknown>('additionalExtensions');
	const additional = Array.isArray(rawLegacy)
		? rawLegacy.filter((ext): ext is string => typeof ext === 'string')
		: [];
	return [...defaultExtensions, ...additional];
}

function applyLegacyConfigCompatibility(
	entry: Record<string, unknown>,
	cfg: WorkspaceConfiguration,
	defaultExtensions: string[]
): Record<string, unknown> {
	const merged = { ...entry };
	if (!hasExplicitConfigValue(cfg, 'enableStderrDiagnostics') && hasExplicitConfigValue(cfg, 'enableCa65StdErrDiagnostics')) {
		const legacyStderr = cfg.get<unknown>('enableCa65StdErrDiagnostics');
		if (typeof legacyStderr === 'boolean') {
			merged.enableStderrDiagnostics = legacyStderr;
		}
	}
	if (!hasExplicitConfigValue(cfg, 'fileExtensions') && hasExplicitConfigValue(cfg, 'additionalExtensions')) {
		merged.fileExtensions = resolveEffectiveCa65Extensions(cfg, defaultExtensions);
	}
	return merged;
}

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

	const createWatchers = (): FileSystemWatcher[] => {
		const rootCa65Config = workspace.getConfiguration('ca65');
		const configuredExtensions = resolveEffectiveCa65Extensions(rootCa65Config, baseExtensions);
		const normalizedExtensions = Array.from(new Set(
			configuredExtensions
				.map((ext) => ext.trim().replace(/^\*+/, '').replace(/^\.+/, ''))
				.filter((ext) => ext.length > 0)
		));

		const watchers: FileSystemWatcher[] = [];
		if (normalizedExtensions.length > 0) {
			const fileWatcherPattern = normalizedExtensions.length === 1
				? `**/*.${normalizedExtensions[0]}`
				: `**/*.{${normalizedExtensions.join(',')}}`;
			watchers.push(workspace.createFileSystemWatcher(fileWatcherPattern));
		}

		const associations = workspace.getConfiguration('files').get<Record<string, unknown>>('associations');
		if (associations && typeof associations === 'object') {
			for (const [pattern, lang] of Object.entries(associations)) {
				if (lang === 'ca65' && pattern.length > 0) {
					const globPattern = pattern.includes('/') ? pattern : `**/${pattern}`;
					watchers.push(workspace.createFileSystemWatcher(globPattern));
				}
			}
		}
		return watchers;
	};

	let activeWatchers: FileSystemWatcher[] = createWatchers();
	let activeWatcherSubscriptions: Disposable[] = [];
	const disposeWatchers = () => {
		for (const sub of activeWatcherSubscriptions) sub.dispose();
		for (const w of activeWatchers) w.dispose();
		activeWatcherSubscriptions = [];
		activeWatchers = [];
	};
	context.subscriptions.push({ dispose: disposeWatchers });

	// cc65 C mode: links C symbols (served by clangd) with global ca65 symbols.
	const cBridge = new CBridge(context);
	cBridgeInstance = cBridge;
	context.subscriptions.push(cBridge);

	const clientOptions: LanguageClientOptions = {
		documentSelector: [
			{ scheme: 'file', language: 'ca65' },
			// Embedded documents holding cc65 inline asm from C sources (see inlineAsmDocuments.ts)
			{ scheme: 'ca65-inline', language: 'ca65' },
		],
		synchronize: {
			configurationSection: 'ca65',
			fileEvents: activeWatchers
		},
		markdown: {
			isTrusted: { enabledCommands: ['ca65.showReference'] },
		},
		middleware: {
			...createCa65BridgeMiddleware(cBridge),
			workspace: {
				configuration: async (params, token, next) => {
					const result = await Promise.resolve(next(params, token));
					if (!Array.isArray(result)) return result;
					return result.map((entry, idx) => {
						const item = params.items[idx];
						if (item?.section !== 'ca65' || !entry || typeof entry !== 'object') {
							return entry;
						}
						const scope = item.scopeUri ? Uri.parse(item.scopeUri) : undefined;
						const scopedCfg = workspace.getConfiguration('ca65', scope);
						return applyLegacyConfigCompatibility(entry as Record<string, unknown>, scopedCfg, baseExtensions);
					});
				},
			},
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

	cBridge.attachCa65Client(client, clientReady);
	cBridge.activate();
	setupCc65AssemblyView(context, cBridge.cc65Diagnostics, async (content) => {
		await clientReady;
		return client.sendRequest('ca65/parseListing', { content });
	});

	context.subscriptions.push(workspace.onDidChangeConfiguration((event) => {
		if (
			event.affectsConfiguration('ca65.fileExtensions')
			|| event.affectsConfiguration('ca65.additionalExtensions')
			|| event.affectsConfiguration('files.associations')
		) {
			disposeWatchers();
			activeWatchers = createWatchers();
			const forwardFileChange = (uri: Uri, type: number) => {
				void clientReady.then(() => {
					return client.sendNotification('workspace/didChangeWatchedFiles', {
						changes: [{ uri: uri.toString(), type }],
					});
				});
			};
			for (const w of activeWatchers) {
				activeWatcherSubscriptions.push(
					w.onDidCreate(uri => forwardFileChange(uri, 1)),
					w.onDidChange(uri => forwardFileChange(uri, 2)),
					w.onDidDelete(uri => forwardFileChange(uri, 3)),
				);
			}
		}
	}));

	// --- Register the "Show Reference" Command ---
	context.subscriptions.push(commands.registerCommand('ca65.showReference', (mnemonic?: unknown) => {
		return showReferencePanel(context, clientReady, typeof mnemonic === 'string' ? mnemonic : undefined);
	}));

	context.subscriptions.push(commands.registerCommand('ca65.dumpDebugInfo', async () => {
		if (client) {
			await clientReady;
			return client.sendRequest('ca65/dumpDebugInfo');
		}
	}));

	const listingErrorUris = new Set<string>();
	const syncListingErrorContext = (overrideForActive?: boolean) => {
		const active = window.activeTextEditor;
		const isError = active && active.document.languageId === 'ca65'
			? (overrideForActive ?? listingErrorUris.has(active.document.uri.toString()))
			: false;
		void commands.executeCommand('setContext', 'ca65.listingError', isError);
	};

	const listingUpdatedEmitter = new EventEmitter<string[] | undefined>();
	context.subscriptions.push(
		listingUpdatedEmitter,
		window.onDidChangeActiveTextEditor(() => syncListingErrorContext()),
		workspace.onDidCloseTextDocument((doc) => {
			if (doc.languageId === 'ca65') {
				listingErrorUris.delete(doc.uri.toString());
			}
		})
	);
	void clientReady.then(() => {
		context.subscriptions.push(
			client.onNotification('ca65/listingUpdated', (params?: { uris?: string[]; errorUris?: string[] }) => {
				const allUris = new Set<string>();
				if (params?.uris) {
					for (const u of params.uris) {
						listingErrorUris.delete(u);
						allUris.add(u);
					}
				}
				if (params?.errorUris) {
					for (const u of params.errorUris) {
						listingErrorUris.add(u);
						allUris.add(u);
					}
				}
				syncListingErrorContext();
				listingUpdatedEmitter.fire(allUris.size > 0 ? Array.from(allUris) : undefined);
			})
		);
	});
	syncListingErrorContext();

	// --- Status Bar Cycle, Byte Estimator & Active Segment ---
	setupCycleStatusBar(context, clientReady, listingUpdatedEmitter.event, listingErrorUris, syncListingErrorContext);
	setupSegmentStatusBar(context, clientReady);

	// --- Read-Only Side-by-Side .lst / --dbgfile Listing ---
	setupSideBySideHexListing(context, clientReady, listingUpdatedEmitter.event);
}

interface InstructionAnalysisItem {
	line: number;
	mnemonic: string;
	maxBytes: number;
	minCycles: number;
	maxCycles: number;
	bytesText?: string;
}

interface ListingLineRangeItem {
	line: number;
	bytesText: string;
	byteCount: number;
}

interface InstructionAnalysisSummary {
	instructionCount: number;
	minBytes: number;
	maxBytes: number;
	minCycles: number;
	maxCycles: number;
	listingStatus?: 'ready' | 'error' | 'pending';
	lineListing?: {
		bytesText: string;
		byteCount: number;
	};
	listingLines?: ListingLineRangeItem[];
	items: InstructionAnalysisItem[];
}

function formatRangeValue(min: number, max: number, unit: string): string {
	return min === max ? `${min} ${unit}` : `${min}–${max} ${unit}`;
}

function buildCycleTooltip(result: InstructionAnalysisSummary | null, isError: boolean = false): MarkdownString {
	const footer = isError ? '*Fix assembly errors to open listing*' : '*Click to open listing*';
	if (!result) return new MarkdownString(footer);

	const rows: Array<{
		line: number;
		hex?: string;
		byteCount: number;
		fallbackLabel: string;
		cycles: string;
	}> = [];

	for (const item of result.items) {
		const cycles = item.minCycles === item.maxCycles
			? `${item.minCycles}`
			: `${item.minCycles}–${item.maxCycles}`;
		rows.push({
			line: item.line,
			hex: item.bytesText,
			byteCount: item.maxBytes,
			fallbackLabel: item.mnemonic.toLowerCase(),
			cycles,
		});
	}

	if (result.listingLines) {
		for (const entry of result.listingLines) {
			rows.push({
				line: entry.line,
				hex: entry.bytesText,
				byteCount: entry.byteCount,
				fallbackLabel: entry.bytesText,
				cycles: 'n/a',
			});
		}
	}

	if (rows.length === 0) return new MarkdownString(footer);
	rows.sort((a, b) => a.line - b.line);

	const hasHex = rows.some(row => Boolean(row.hex));
	if (!hasHex && rows.length === 1) return new MarkdownString(footer);

	const lines: string[] = [
		hasHex ? '| Line | Hex | Cycles |' : '| Line | Instruction | Cycles |',
		'|---:|---|---:|',
	];

	const maxPreviewRows = 15;
	for (const row of rows.slice(0, maxPreviewRows)) {
		const mainCell = hasHex
			? (row.hex ? `\`${formatCompactBytes(row.hex, row.byteCount, 8)}\`` : '—')
			: `\`${row.fallbackLabel}\``;
		lines.push(`| ${row.line + 1} | ${mainCell} | ${row.cycles} |`);
	}
	if (rows.length > maxPreviewRows) {
		lines.push('', `*…+${rows.length - maxPreviewRows} more*`);
	}
	lines.push('', footer);

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
	subscribeRefresh?: (trigger: (uris?: readonly string[]) => void) => void;
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

	if (config.subscribeRefresh) {
		config.subscribeRefresh((uris) => {
			const active = window.activeTextEditor;
			if (!active) return;
			if (!uris || uris.includes(active.document.uri.toString())) {
				lastQueryKey = '';
				updateForEditor(active, true);
			}
		});
	}

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

function setupCycleStatusBar(
	context: ExtensionContext,
	clientReady: Promise<void>,
	onListingUpdated: Event<string[] | undefined>,
	listingErrorUris: ReadonlySet<string>,
	syncListingErrorContext: (overrideForActive?: boolean) => void
): void {
	registerCursorStatusBarUpdater<InstructionAnalysisSummary | null>(context, clientReady, {
		priority: 100,
		settingKey: 'enableStatusBarCycleCount',
		affectingSettings: ['ca65.enableStatusBarCycleCount', 'ca65.cpu', 'ca65.cc65.target', 'ca65.implicitImports', 'ca65.cComments', 'ca65.lineContinuations', 'ca65.additionalArgs'],
		subscribeRefresh: (trigger) => {
			context.subscriptions.push(onListingUpdated((uris) => trigger(uris)));
		},
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
			const uriStr = editor.document.uri.toString();
			const isError = result?.listingStatus === 'error'
				|| (result?.listingStatus !== 'ready' && listingErrorUris.has(uriStr));
			syncListingErrorContext(isError);
			item.command = isError ? undefined : 'ca65.showHexListing';
			const hasInstructions = Boolean(result && result.instructionCount > 0);
			const byteStr = hasInstructions
				? formatRangeValue(result!.minBytes, result!.maxBytes, 'B')
				: `${result?.lineListing?.byteCount ?? 0} B`;
			const cycStr = hasInstructions
				? formatRangeValue(result!.minCycles, result!.maxCycles, 'cyc')
				: '0 cyc';
			item.text = `$(file-binary) ${byteStr} $(clock) ${cycStr}`;
			item.tooltip = buildCycleTooltip(result, isError);
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
	errors?: string[];
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
		// "<name> (listing)" selects the ca65-listing language (see package.json filenamePatterns).
		path: `/${baseName} (listing)`,
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

function setupSideBySideHexListing(
	context: ExtensionContext,
	clientReady: Promise<void>,
	onListingUpdated: Event<string[] | undefined>
): void {
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

		if (meta.source === 'none' || meta.error || meta.stale) {
			if (meta.error) {
				overlayStatusBadge.text = '$(warning) ca65 (assembly error)';
				overlayStatusBadge.tooltip = new MarkdownString('ca65 assembly failed\n\n*Click to view Problems*');
				overlayStatusBadge.command = 'workbench.actions.view.problems';
				overlayStatusBadge.show();
			} else {
				overlayStatusBadge.hide();
			}
			return;
		}

		const totalBytes = meta.lines.reduce((sum, entry) => sum + entry.byteCount, 0);
		overlayStatusBadge.text = `$(file-binary) ${totalBytes} B`;
		overlayStatusBadge.tooltip = `${totalBytes} bytes emitted in this file`;
		overlayStatusBadge.command = undefined;
		overlayStatusBadge.show();
	};

	const provider: TextDocumentContentProvider = {
		onDidChange: onDidChangeEmitter.event,
		async provideTextDocumentContent(listingUri: Uri): Promise<string> {
			const sourceUri = getSourceUriFromListingUri(listingUri);
			if (!sourceUri) {
				return 'Invalid ca65 listing URI.';
			}

			await clientReady;
			const srcDoc = await workspace.openTextDocument(sourceUri);
			const data = await client.sendRequest<OverlayDataResponse>('ca65/getOverlayData', {
				uri: sourceUri.toString(),
			});

			lastMetadataByListingUri.set(listingUri.toString(), data);
			updateStatusBadge();

			if (!data || data.source === 'none' || data.error || data.stale) {
				if (data?.error) {
					const lines = ['; Cannot generate listing due to assembly errors. Fix errors to update.'];
					if (data.errors && data.errors.length > 0) {
						lines.push(';', ...data.errors.map(e => `; ${e}`));
					}
					return lines.join('\n');
				}
				return '; ca65 listing unavailable (ensure ca65 is installed or configured via ca65.executablePath).';
			}

			const sourceLines = srcDoc.getText().split(/\r?\n/);
			return formatSideBySideListing(sourceLines, data);
		},
	};

	const pendingScrollSync = new Map<string, { targetLine: number; sourceVisible?: VscodeRange }>();
	const pendingHiddenListingRefresh = new Set<string>();

	const syncListingScroll = (
		shownEditor: TextEditor,
		targetLine: number,
		sourceVisible?: VscodeRange
	) => {
		const maxLine = Math.max(0, shownEditor.document.lineCount - 1);
		const clampedLine = Math.min(Math.max(0, targetLine), maxLine);
		const pos = new Position(clampedLine, 0);
		shownEditor.selection = new Selection(pos, pos);

		if (sourceVisible && clampedLine >= sourceVisible.start.line && clampedLine <= sourceVisible.end.line) {
			const topLine = Math.min(Math.max(0, sourceVisible.start.line), maxLine);
			shownEditor.revealRange(new VscodeRange(topLine, 0, topLine, 0), TextEditorRevealType.AtTop);
		} else {
			shownEditor.revealRange(new VscodeRange(clampedLine, 0, clampedLine, 0), TextEditorRevealType.InCenter);
		}
	};

	const refreshListingsForUris = (sourceUriFilter?: Set<string>) => {
		const visibleKeys = new Set(
			window.visibleTextEditors
				.filter(e => e.document.uri.scheme === LISTING_SCHEME)
				.map(e => e.document.uri.toString())
		);
		for (const doc of workspace.textDocuments) {
			if (doc.uri.scheme !== LISTING_SCHEME) continue;
			if (sourceUriFilter) {
				const sourceUri = getSourceUriFromListingUri(doc.uri)?.toString();
				if (!sourceUri || !sourceUriFilter.has(sourceUri)) continue;
			}
			const key = doc.uri.toString();
			pendingScrollSync.delete(key);
			if (visibleKeys.has(key)) {
				pendingHiddenListingRefresh.delete(key);
				onDidChangeEmitter.fire(doc.uri);
			} else {
				pendingHiddenListingRefresh.add(key);
			}
		}
		updateStatusBadge();
	};

	const flushPendingVisibleRefreshes = () => {
		for (const editor of window.visibleTextEditors) {
			if (editor.document.uri.scheme !== LISTING_SCHEME) continue;
			const key = editor.document.uri.toString();
			if (pendingHiddenListingRefresh.delete(key)) {
				onDidChangeEmitter.fire(editor.document.uri);
			}
		}
		updateStatusBadge();
	};

	context.subscriptions.push(
		onListingUpdated((uris) => {
			refreshListingsForUris(uris ? new Set(uris) : undefined);
		}),
		workspace.registerTextDocumentContentProvider(LISTING_SCHEME, provider),
		window.onDidChangeActiveTextEditor(() => flushPendingVisibleRefreshes()),
		window.onDidChangeVisibleTextEditors(() => flushPendingVisibleRefreshes()),
		workspace.onDidCloseTextDocument((doc) => {
			if (doc.uri.scheme === LISTING_SCHEME) {
				const key = doc.uri.toString();
				lastMetadataByListingUri.delete(key);
				pendingHiddenListingRefresh.delete(key);
				pendingScrollSync.delete(key);
			}
		}),
		workspace.onDidChangeTextDocument((event) => {
			if (event.document.uri.scheme !== LISTING_SCHEME) return;
			const key = event.document.uri.toString();
			const pending = pendingScrollSync.get(key);
			if (!pending) return;
			pendingScrollSync.delete(key);
			const editor = window.visibleTextEditors.find(e => e.document.uri.toString() === key);
			if (editor) {
				syncListingScroll(editor, pending.targetLine, pending.sourceVisible);
			}
		}),
		workspace.onDidSaveTextDocument((doc) => {
			if (doc.languageId === 'ca65') {
				refreshListingsForUris();
			}
		}),
		commands.registerCommand('ca65.showHexListing', async () => {
			const activeEditor = window.activeTextEditor;
			if (activeEditor?.document.uri.scheme === LISTING_SCHEME) {
				const key = activeEditor.document.uri.toString();
				pendingScrollSync.delete(key);
				pendingHiddenListingRefresh.delete(key);
				onDidChangeEmitter.fire(activeEditor.document.uri);
				updateStatusBadge();
				return;
			}
			if (!activeEditor || activeEditor.document.languageId !== 'ca65') {
				window.showInformationMessage('Open a ca65 source file to view its hex & address listing.');
				return;
			}

			const activeLine = activeEditor.selection.active.line;
			const sourceVisible = activeEditor.visibleRanges[0];
			const listingUri = buildListingUri(activeEditor.document.uri);
			const listingKey = listingUri.toString();
			pendingHiddenListingRefresh.delete(listingKey);
			pendingScrollSync.set(listingKey, { targetLine: activeLine, sourceVisible });
			onDidChangeEmitter.fire(listingUri);

			const listingDoc = await workspace.openTextDocument(listingUri);
			const shownEditor = await window.showTextDocument(listingDoc, {
				viewColumn: ViewColumn.Active,
				preserveFocus: false,
				preview: true,
			});

			syncListingScroll(shownEditor, activeLine, sourceVisible);
			updateStatusBadge();
		}),
	);
}

export async function deactivate(): Promise<void> {
	await Promise.all([
		cBridgeInstance?.stop(),
		client?.stop(),
	]);
}

const cachedReferenceBodyByCpu = new Map<string, string>();
let referencePanel: WebviewPanel | undefined;
let referencePanelCpu = '';

function escapeHtml(text: string): string {
	return text
		.replace(/&/g, '&amp;')
		.replace(/</g, '&lt;')
		.replace(/>/g, '&gt;')
		.replace(/"/g, '&quot;');
}

function renderInlineMarkdown(text: string): string {
	const codeTokens: string[] = [];
	const withTokens = escapeHtml(text).replace(/`([^`]+)`/g, (_match, inner: string) => {
		const id = codeTokens.length;
		codeTokens.push(inner);
		return `\u0000${id}\u0000`;
	});
	const formatted = withTokens
		.replace(/\*\*([^*]+)\*\*/g, '<strong>$1</strong>')
		.replace(/\*([^*]+)\*/g, '<em>$1</em>');
	return formatted.replace(/\u0000(\d+)\u0000/g, (_m, idxStr: string) => `<code>${codeTokens[Number(idxStr)]}</code>`);
}

function wrapReferenceHtml(cpu: string, bodyHtml: string, initialAnchor?: string): string {
	const nonce = crypto.randomBytes(16).toString('hex');
	const initialAnchorJson = JSON.stringify(initialAnchor || '');
	return `<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="UTF-8">
<meta http-equiv="Content-Security-Policy" content="default-src 'none'; style-src 'unsafe-inline'; script-src 'nonce-${nonce}';">
<title>Instruction reference (${escapeHtml(cpu)})</title>
<style>
	body {
		font-family: var(--vscode-font-family);
		font-size: var(--vscode-font-size);
		color: var(--vscode-foreground);
		background: var(--vscode-editor-background);
		line-height: 1.55;
		max-width: 860px;
		margin: 0 auto;
		padding: 16px 24px 64px;
	}
	h1, h2, h3 {
		font-weight: 600;
		margin-top: 1.3em;
		margin-bottom: 0.5em;
	}
	h1 {
		font-size: 1.6em;
		border-bottom: 1px solid var(--vscode-panel-border);
		padding-bottom: 6px;
		margin-top: 0;
	}
	h2 { font-size: 1.25em; }
	h3 { font-size: 1.1em; }
	a {
		color: var(--vscode-textLink-foreground);
		text-decoration: none;
	}
	a:hover { text-decoration: underline; }
	code {
		font-family: var(--vscode-editor-font-family);
		background: var(--vscode-textCodeBlock-background);
		padding: 1px 4px;
		border-radius: 3px;
		font-size: 0.92em;
	}
	table {
		border-collapse: collapse;
		width: 100%;
		margin: 10px 0 14px;
	}
	th, td {
		border: 1px solid var(--vscode-panel-border);
		padding: 5px 10px;
		text-align: left;
		vertical-align: top;
	}
	th {
		background: var(--vscode-textCodeBlock-background);
		font-weight: 600;
	}
	section.mnemonic {
		padding: 8px 12px 14px;
		margin: 12px 0;
		border-left: 3px solid transparent;
		border-bottom: 1px solid var(--vscode-panel-border);
		scroll-margin-top: 12px;
	}
	section.mnemonic.active {
		border-left-color: var(--vscode-textLink-foreground);
		background: var(--vscode-editor-lineHighlightBackground, transparent);
	}
	.callout {
		margin: 8px 0;
		opacity: 0.92;
	}
	.meta-row {
		display: flex;
		justify-content: space-between;
		align-items: center;
		gap: 12px;
		margin-top: 6px;
		font-size: 0.92em;
	}
</style>
</head>
<body id="top">
${bodyHtml}
<script nonce="${nonce}">
(function () {
	function jumpTo(anchor) {
		for (const el of document.querySelectorAll('section.mnemonic.active')) {
			el.classList.remove('active');
		}
		if (!anchor || anchor === 'top') {
			window.scrollTo(0, 0);
			return;
		}
		const target = document.getElementById(anchor);
		if (target) {
			if (target.classList.contains('mnemonic')) {
				target.classList.add('active');
			}
			target.scrollIntoView({ block: 'start' });
		}
	}

	window.addEventListener('message', (event) => {
		if (event.data && event.data.type === 'scrollTo') {
			jumpTo(event.data.anchor);
		}
	});

	document.addEventListener('click', (event) => {
		const link = event.target && event.target.closest ? event.target.closest('a[href^="#"]') : null;
		if (!link) return;
		event.preventDefault();
		const href = link.getAttribute('href') || '';
		jumpTo(href.slice(1));
	});

	const initial = ${initialAnchorJson};
	if (initial) {
		requestAnimationFrame(() => jumpTo(initial));
	}
})();
</script>
</body>
</html>`;
}

// --- Implementation for the "Show Reference" Panel ---
async function showReferencePanel(context: ExtensionContext, clientReady: Promise<void>, targetMnemonic?: string) {
	const activeUri = window.activeTextEditor?.document.uri;

	let targetCpu = '6502';
	let jsonData: Record<string, any> | undefined;
	if (client) {
		try {
			await clientReady;
			const response = await client.sendRequest<{ cpu: string; mnemonics: Record<string, any> }>(
				'ca65/getReferenceData',
				{ uri: activeUri?.toString() }
			);
			if (response?.mnemonics) {
				targetCpu = response.cpu || targetCpu;
				jsonData = response.mnemonics;
			}
		} catch {
			// Fall back to base 6502 reference JSON if server request fails
		}
	}

	let bodyHtml = cachedReferenceBodyByCpu.get(targetCpu);
	if (!bodyHtml) {
		if (!jsonData) {
			const dataPath = context.asAbsolutePath(path.join('server', 'data', '6502_mnemonics.json'));
			const rawData = await fs.readFile(dataPath, 'utf8');
			jsonData = JSON.parse(rawData);
			targetCpu = '6502';
		}

		bodyHtml = generateReferenceBodyHtml(jsonData!, targetCpu);
		cachedReferenceBodyByCpu.set(targetCpu, bodyHtml);
	}

	const safeAnchor = targetMnemonic?.trim().toLowerCase().replace(/[^a-z0-9_]/g, '') || '';

	if (referencePanel) {
		referencePanel.title = `ca65 Reference (${targetCpu})`;
		referencePanel.reveal(referencePanel.viewColumn ?? ViewColumn.Beside, false);
		if (referencePanelCpu !== targetCpu) {
			referencePanelCpu = targetCpu;
			referencePanel.webview.html = wrapReferenceHtml(targetCpu, bodyHtml, safeAnchor);
		} else {
			void referencePanel.webview.postMessage({ type: 'scrollTo', anchor: safeAnchor || 'top' });
		}
		return;
	}

	const panel = window.createWebviewPanel(
		'ca65Reference',
		`ca65 Reference (${targetCpu})`,
		ViewColumn.Beside,
		{
			enableScripts: true,
			retainContextWhenHidden: true,
		}
	);
	referencePanel = panel;
	referencePanelCpu = targetCpu;
	panel.onDidDispose(() => {
		if (referencePanel === panel) {
			referencePanel = undefined;
			referencePanelCpu = '';
		}
	});
	context.subscriptions.push(panel);
	panel.webview.html = wrapReferenceHtml(targetCpu, bodyHtml, safeAnchor);
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
	P: "Processor status"
};

function generateTypeTableHtml(jsonData: Record<string, any>): string {
	const link = (mnemonic: string) => {
		const lower = mnemonic.toLowerCase();
		return `<a href="#${lower}"><code>${lower}</code></a>`;
	};
	const formatGroup = (list: string[]) => list.filter(m => Boolean(jsonData[m])).map(link).join(' ');

	const rows: Array<[string, string[]]> = [
		['Access', ['LDA', 'STA', 'LDX', 'STX', 'LDY', 'STY', 'STZ']],
		['Transfer', ['TAX', 'TXA', 'TAY', 'TYA', 'TCD', 'TAD', 'TDC', 'TDA', 'TCS', 'TAS', 'TSC', 'TSA', 'TXY', 'TYX', 'XBA', 'SWA', 'XCE']],
		['Arithmetic', ['ADC', 'SBC', 'INC', 'INA', 'DEC', 'DEA', 'INX', 'DEX', 'INY', 'DEY']],
		['Shift', ['ASL', 'LSR', 'ROL', 'ROR']],
		['Bitwise', ['AND', 'ORA', 'EOR', 'BIT', 'TSB', 'TRB', 'RMB0', 'RMB1', 'RMB2', 'RMB3', 'RMB4', 'RMB5', 'RMB6', 'RMB7', 'SMB0', 'SMB1', 'SMB2', 'SMB3', 'SMB4', 'SMB5', 'SMB6', 'SMB7']],
		['Compare', ['CMP', 'CPA', 'CPX', 'CPY']],
		['Branch', ['BCC', 'BCS', 'BEQ', 'BNE', 'BPL', 'BMI', 'BVC', 'BVS', 'BRA', 'BRL', 'BBR0', 'BBR1', 'BBR2', 'BBR3', 'BBR4', 'BBR5', 'BBR6', 'BBR7', 'BBS0', 'BBS1', 'BBS2', 'BBS3', 'BBS4', 'BBS5', 'BBS6', 'BBS7']],
		['Jump & call', ['JMP', 'JML', 'JSR', 'JSL', 'RTS', 'RTL', 'BRK', 'COP', 'RTI']],
		['Stack', ['PHA', 'PLA', 'PHP', 'PLP', 'PHX', 'PLX', 'PHY', 'PLY', 'PHB', 'PLB', 'PHD', 'PLD', 'PHK', 'PEA', 'PEI', 'PER', 'TXS', 'TSX']],
		['Flags & ctrl', ['CLC', 'SEC', 'CLI', 'SEI', 'CLD', 'SED', 'CLV', 'REP', 'SEP']],
		['Block & other', ['MVN', 'MVP', 'NOP', 'WAI', 'STP', 'WDM']],
	];

	const trs: string[] = [];
	for (const [label, candidates] of rows) {
		const formatted = formatGroup(candidates);
		if (formatted) {
			trs.push(`<tr><td>${escapeHtml(label)}</td><td>${formatted}</td></tr>`);
		}
	}
	return `<table><thead><tr><th>Type</th><th>Instructions</th></tr></thead><tbody>${trs.join('')}</tbody></table>`;
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

function generateReferenceBodyHtml(jsonData: Record<string, any>, cpu: string = '6502'): string {
	const parts: string[] = [
		`<h1>Instruction reference (${escapeHtml(cpu)})</h1>`,
		`<h2>Instructions by type</h2>`,
		generateTypeTableHtml(jsonData),
		`<h2>Instructions</h2>`,
	];

	const sortedMnemonics = Object.keys(jsonData).sort();
	for (const mnemonic of sortedMnemonics) {
		const data = jsonData[mnemonic];
		const lower = mnemonic.toLowerCase();
		const sec: string[] = [
			`<section class="mnemonic" id="${escapeHtml(lower)}">`,
			`<h3><code>${escapeHtml(lower)}</code> - ${escapeHtml(data.fullName || '')}</h3>`,
		];

		if (data.description) {
			sec.push(`<p>${renderInlineMarkdown(data.description)}</p>`);
		}
		if (data.warning) {
			sec.push(`<p class="callout">⚠️ <strong>Warning:</strong> ${renderInlineMarkdown(data.warning)}</p>`);
		}
		if (data.note) {
			sec.push(`<p class="callout"><em>Note: ${renderInlineMarkdown(data.note)}</em></p>`);
		}

		if (data.flagChanges && Object.keys(data.flagChanges).length > 0) {
			const flagRows = Object.keys(data.flagChanges).map(flag => {
				const name = FLAG_NAMES[flag] || flag;
				return `<tr><td><code>${escapeHtml(flag)}</code> - ${escapeHtml(name)}</td><td>${renderInlineMarkdown(String(data.flagChanges[flag]))}</td></tr>`;
			}).join('');
			sec.push(`<table><thead><tr><th>Flag</th><th>New value</th></tr></thead><tbody>${flagRows}</tbody></table>`);
		}

		if (data.modes && Object.keys(data.modes).length > 0) {
			const modeRows = Object.keys(data.modes).map(modeName => {
				const mode = data.modes[modeName];
				const bytes = formatReferenceModeBytes(mode);
				const cycles = formatReferenceModeCycles(mode);
				return `<tr><td>${escapeHtml(modeName)}</td><td><code>${escapeHtml(String(mode.opcode ?? ''))}</code></td><td>${escapeHtml(bytes)}</td><td>${escapeHtml(cycles)}</td></tr>`;
			}).join('');
			sec.push(`<table><thead><tr><th>Addressing mode</th><th>Opcode</th><th>Bytes</th><th>Cycles</th></tr></thead><tbody>${modeRows}</tbody></table>`);
		}

		const seeAlsoLinks = (data.seeAlso && Array.isArray(data.seeAlso))
			? data.seeAlso
				.filter((link: string) => Boolean(jsonData[link.toUpperCase()]))
				.map((link: string) => {
					const l = link.toLowerCase();
					return `<a href="#${escapeHtml(l)}"><code>${escapeHtml(l)}</code></a>`;
				})
				.join(' ')
			: '';
		sec.push(`<div class="meta-row"><span>${seeAlsoLinks ? `<strong>See also:</strong> ${seeAlsoLinks}` : ''}</span><a href="#top">↑ Top</a></div>`);
		sec.push(`</section>`);
		parts.push(sec.join('\n'));
	}

	return parts.join('\n');
}

