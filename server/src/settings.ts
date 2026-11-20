export type Ca65Cpu = '6502' | '65SC02' | '65C02' | 'W65C02' | '65816';

export const SUPPORTED_CPUS: readonly Ca65Cpu[] = [
    '6502',
    '65SC02',
    '65C02',
    'W65C02',
    '65816',
];

export const DEFAULT_FILE_EXTENSIONS: readonly string[] = [
    '.s',
    '.asm',
    '.inc',
];

export const DEFAULT_INCLUDE_DIRS: readonly string[] = [
    '**/include',
];

const CPU_LOOKUP: Record<string, Ca65Cpu> = {
    '6502': '6502',
    '65SC02': '65SC02',
    '65C02': '65C02',
    'W65C02': 'W65C02',
    '65816': '65816',
};

/**
 * CPU implied by a cc65 target (`cc65 -t`), as reported by cc65's own `.setcpu` output (cc65 2.19).
 * HuC6280 (`pce`) is not supported by the extension's instruction data and maps to its base, 65C02.
 */
const CC65_TARGET_CPUS: Record<string, Ca65Cpu> = {
    apple2enh: '65C02',
    cx16: '65C02',
    'geos-apple': '65C02',
    sim65c02: '65C02',
    pce: '65C02',
    lynx: '65SC02',
    supervision: '65SC02',
};

/** Default `ca65.cc65.target`; keep in sync with package.json and client/src/cc65Toolchain.ts. */
export const DEFAULT_CC65_TARGET = 'c64';

export function cpuForCc65Target(target: unknown): Ca65Cpu {
    const name = typeof target === 'string' && target.trim() ? target.trim().toLowerCase() : DEFAULT_CC65_TARGET;
    return CC65_TARGET_CPUS[name] ?? '6502';
}

/**
 * Resolves `ca65.cpu`: an explicit CPU, or `auto` (the default) for the CPU implied by
 * `ca65.cc65.target`, like `-t` sets the CPU in the cc65 tools unless `--cpu` overrides it.
 */
export function resolveCpuSetting(cpu: unknown, cc65Settings: unknown): Ca65Cpu {
    if (cpu === undefined || (typeof cpu === 'string' && cpu.trim().toLowerCase() === 'auto')) {
        const target = cc65Settings && typeof cc65Settings === 'object' ? (cc65Settings as Record<string, unknown>).target : undefined;
        return cpuForCc65Target(target);
    }
    return normalizeCpu(cpu);
}

/**
 * Normalizes a raw CPU setting value into a supported Tier-1 ca65 CPU identifier.
 */
export function normalizeCpu(value: unknown): Ca65Cpu {
    if (typeof value !== 'string') return '6502';
    return CPU_LOOKUP[value.trim().toUpperCase()] ?? '6502';
}

function cleanStringArray(value: unknown): string[] {
    if (!Array.isArray(value)) return [];
    const out: string[] = [];
    for (const item of value) {
        if (typeof item !== 'string') continue;
        const trimmed = item.trim();
        if (trimmed.length > 0) out.push(trimmed);
    }
    return out;
}

/**
 * Normalizes a `ca65.fileExtensions` array to dotted extensions, falling back to `DEFAULT_FILE_EXTENSIONS` when unset.
 */
export function normalizeFileExtensions(raw: unknown): string[] {
    if (!Array.isArray(raw)) return Array.from(DEFAULT_FILE_EXTENSIONS);
    const seen = new Set<string>();
    const out: string[] = [];
    for (const item of raw) {
        if (typeof item !== 'string') continue;
        const trimmed = item.trim().replace(/^\*+/, '').replace(/^\.+/, '');
        if (!trimmed) continue;
        const normalized = `.${trimmed}`;
        if (!seen.has(normalized)) {
            seen.add(normalized);
            out.push(normalized);
        }
    }
    return out;
}

/**
 * Resolves watched/indexed extensions from a raw `ca65` settings object,
 * preserving backwards compatibility with deprecated `additionalExtensions`
 * when `fileExtensions` is unset.
 */
export function resolveConfiguredFileExtensions(raw: unknown): string[] {
    const rawObj: Record<string, unknown> = (raw && typeof raw === 'object')
        ? (raw as Record<string, unknown>)
        : {};
    if (Array.isArray(rawObj.fileExtensions)) {
        return normalizeFileExtensions(rawObj.fileExtensions);
    }
    if (Array.isArray(rawObj.additionalExtensions)) {
        return normalizeFileExtensions([
            ...DEFAULT_FILE_EXTENSIONS,
            ...rawObj.additionalExtensions,
        ]);
    }
    return Array.from(DEFAULT_FILE_EXTENSIONS);
}

/**
 * Strips output, listing, and dependency-file flags from `ca65.additionalArgs`
 * so background LSP runs never overwrite project build artifacts.
 */
export function sanitizeAdditionalCa65Args(rawArgs: unknown): string[] {
    const args = cleanStringArray(rawArgs);
    const safeArgs: string[] = [];
    for (let i = 0; i < args.length; i++) {
        const arg = args[i];
        if (
            arg === '-o'
            || arg === '-l'
            || arg === '--listing'
            || arg === '--create-dep'
            || arg === '--create-full-dep'
        ) {
            i++;
            continue;
        }
        if (
            arg.startsWith('--listing=')
            || arg.startsWith('--create-dep=')
            || arg.startsWith('--create-full-dep=')
            || ((arg.startsWith('-o') || arg.startsWith('-l')) && !arg.startsWith('--'))
        ) {
            continue;
        }
        safeArgs.push(arg);
    }
    return safeArgs;
}

export interface Ca65Settings {
    cpu: Ca65Cpu;
    enableStderrDiagnostics: boolean;
    executablePath: string;
    enableUnusedSymbolDiagnostics: boolean;
    includeDirs: string[];
    binIncludeDirs: string[];
    autoIncludeExtensions: string[];
    anonymousLabelIndexHints: boolean;
    importFromHints: boolean;
    fileExtensions: string[];
    smartFolding: boolean;
    implicitImports: boolean;
    cComments: boolean;
    lineContinuations: boolean;
    additionalArgs: string[];
    enableStatusBarCycleCount: boolean;
    enableStatusBarSegment: boolean;
    enableInstructionHover: boolean;
    enableDirectiveHover: boolean;
    linkerConfig: string;
    hoverDocs: HoverDocsMode;
}

/**
 * Which comments attached to a definition are shown as its documentation in hovers:
 * - `any`: a `/** ... *\/` block if present, otherwise the `;` comments above plus the trailing `;` comment.
 * - `docBlocks`: only `/** ... *\/` blocks (needs `cComments`).
 */
export type HoverDocsMode = 'any' | 'docBlocks';

/**
 * Resolves raw workspace configuration into a single normalized settings object.
 */
export function resolveCa65Settings(raw: unknown): Ca65Settings {
    const rawObj: Record<string, unknown> = (raw && typeof raw === 'object')
        ? (raw as Record<string, unknown>)
        : {};

    return {
        executablePath: typeof rawObj.executablePath === 'string' ? rawObj.executablePath : '',
        fileExtensions: resolveConfiguredFileExtensions(rawObj),
        cpu: resolveCpuSetting(rawObj.cpu, rawObj.cc65),
        includeDirs: Array.isArray(rawObj.includeDirs)
            ? cleanStringArray(rawObj.includeDirs)
            : Array.from(DEFAULT_INCLUDE_DIRS),
        binIncludeDirs: cleanStringArray(rawObj.binIncludeDirs),
        implicitImports: Boolean(rawObj.implicitImports),
        cComments: typeof rawObj.cComments === 'boolean' ? rawObj.cComments : true,
        lineContinuations: typeof rawObj.lineContinuations === 'boolean' ? rawObj.lineContinuations : true,
        additionalArgs: sanitizeAdditionalCa65Args(rawObj.additionalArgs),
        enableStderrDiagnostics: typeof rawObj.enableStderrDiagnostics === 'boolean'
            ? rawObj.enableStderrDiagnostics
            : (typeof rawObj.enableCa65StdErrDiagnostics === 'boolean' ? rawObj.enableCa65StdErrDiagnostics : true),
        enableUnusedSymbolDiagnostics: typeof rawObj.enableUnusedSymbolDiagnostics === 'boolean' ? rawObj.enableUnusedSymbolDiagnostics : true,
        anonymousLabelIndexHints: typeof rawObj.anonymousLabelIndexHints === 'boolean' ? rawObj.anonymousLabelIndexHints : true,
        importFromHints: typeof rawObj.importFromHints === 'boolean' ? rawObj.importFromHints : true,
        enableStatusBarCycleCount: typeof rawObj.enableStatusBarCycleCount === 'boolean' ? rawObj.enableStatusBarCycleCount : true,
        enableStatusBarSegment: typeof rawObj.enableStatusBarSegment === 'boolean' ? rawObj.enableStatusBarSegment : true,
        enableInstructionHover: typeof rawObj.enableInstructionHover === 'boolean' ? rawObj.enableInstructionHover : true,
        enableDirectiveHover: typeof rawObj.enableDirectiveHover === 'boolean' ? rawObj.enableDirectiveHover : true,
        linkerConfig: typeof rawObj.linkerConfig === 'string' ? rawObj.linkerConfig.trim() : '',
        hoverDocs: rawObj.hoverDocs === 'docBlocks' ? 'docBlocks' : 'any',
        smartFolding: typeof rawObj.smartFolding === 'boolean' ? rawObj.smartFolding : true,
        autoIncludeExtensions: Array.isArray(rawObj.autoIncludeExtensions)
            ? cleanStringArray(rawObj.autoIncludeExtensions)
            : ['.inc'],
    };
}

export const documentSettings: Map<string, Thenable<Ca65Settings>> = new Map();
