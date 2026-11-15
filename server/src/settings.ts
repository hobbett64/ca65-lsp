export type Ca65Cpu = '6502' | '65SC02' | '65C02' | 'W65C02' | '65816';

export const SUPPORTED_CPUS: readonly Ca65Cpu[] = [
    '6502',
    '65SC02',
    '65C02',
    'W65C02',
    '65816',
];

const CPU_LOOKUP: Record<string, Ca65Cpu> = {
    '6502': '6502',
    '65SC02': '65SC02',
    '65C02': '65C02',
    'W65C02': 'W65C02',
    '65816': '65816',
};

/**
 * Normalizes a raw CPU setting value into a supported Tier-1 ca65 CPU identifier.
 */
export function normalizeCpu(value: unknown): Ca65Cpu {
    if (typeof value !== 'string') return '6502';
    return CPU_LOOKUP[value.trim().toUpperCase()] ?? '6502';
}

export interface Ca65Settings {
    cpu?: Ca65Cpu;
    enableCa65StdErrDiagnostics: boolean;
    executablePath: string;
    enableUnusedSymbolDiagnostics: boolean;
    includeDirs: string[];
    binIncludeDirs: string[];
    autoIncludeExtensions: string[];
    anonymousLabelIndexHints: boolean;
    importFromHints: boolean;
    additionalExtensions: string[];
    smartFolding: boolean;
    implicitImports: boolean;
    lineContinuations: boolean;
    enableStatusBarCycleCount?: boolean;
    additionalArgs?: string[];
}

export const documentSettings: Map<string, Thenable<Ca65Settings>> = new Map();
