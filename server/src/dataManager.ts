import * as path from 'path';
import * as fs from 'fs';
import { _Connection } from 'vscode-languageserver/node';
import { Ca65Cpu, normalizeCpu } from './settings';

export interface DirectiveInfo {
    type: 'Control command' | 'Pseudo-function' | 'Pseudo-variable';
    shortDescription: string;
    documentationUrl?: string;
}

export interface MnemonicModeInfo {
    opcode: string;
    bytes: number;
    cycles: number;
    branchPenalty?: boolean;
    pagePenalty?: boolean;
    dpNonZeroPenalty?: boolean;
    byteVariableM?: boolean;
    byteVariableX?: boolean;
    cycleVariableM?: number;
    cycleVariableX?: number;
    pageOrIndex16Penalty?: boolean;
    emulationOnlyPagePenalty?: boolean;
    nativeModeCyclePenalty?: number;
    perByteCycles?: boolean;
}

export interface MnemonicInfo {
    fullName: string;
    description: string;
    note?: string;
    warning?: string;
    aliasOf?: string;
    seeAlso?: string[];
    modes: Record<string, MnemonicModeInfo>;
    flagChanges: Record<string, string>;
}

interface CpuMnemonicUpdate {
    fullName?: string;
    description?: string;
    note?: string;
    clearNote?: boolean;
    warning?: string;
    clearWarning?: boolean;
    seeAlso?: string[];
    modes?: Record<string, MnemonicModeInfo>;
    flagChanges?: Record<string, string>;
}

interface CpuExtensionPatch {
    updates?: Record<string, CpuMnemonicUpdate>;
    additions?: Record<string, MnemonicInfo>;
}

export let mnemonicData: Record<string, MnemonicInfo> = {};
export let directiveData: Record<string, DirectiveInfo | string> = {};

const cpuMnemonicTables = new Map<Ca65Cpu, Record<string, MnemonicInfo>>();

function cloneMnemonicInfo(info: MnemonicInfo): MnemonicInfo {
    const clonedModes: Record<string, MnemonicModeInfo> = {};
    for (const [mode, entry] of Object.entries(info.modes || {})) {
        clonedModes[mode] = { ...entry };
    }
    return {
        ...info,
        seeAlso: info.seeAlso ? [...info.seeAlso] : undefined,
        modes: clonedModes,
        flagChanges: { ...(info.flagChanges || {}) },
    };
}

function cloneMnemonicTable(table: Record<string, MnemonicInfo>): Record<string, MnemonicInfo> {
    const copy: Record<string, MnemonicInfo> = {};
    for (const [key, info] of Object.entries(table)) {
        copy[key] = cloneMnemonicInfo(info);
    }
    return copy;
}

function applyExtensionPatch(
    base: Record<string, MnemonicInfo>,
    patch?: CpuExtensionPatch
): Record<string, MnemonicInfo> {
    const result = cloneMnemonicTable(base);
    if (!patch) {
        return result;
    }

    if (patch.updates) {
        for (const [name, update] of Object.entries(patch.updates)) {
            const entry = result[name];
            if (!entry) continue;
            if (update.fullName !== undefined) entry.fullName = update.fullName;
            if (update.description !== undefined) entry.description = update.description;
            if (update.clearWarning) delete entry.warning;
            if (update.warning !== undefined) entry.warning = update.warning;
            if (update.clearNote) delete entry.note;
            if (update.note !== undefined) entry.note = update.note;
            if (update.seeAlso !== undefined) entry.seeAlso = [...update.seeAlso];
            if (update.flagChanges !== undefined) entry.flagChanges = { ...update.flagChanges };
            if (update.modes) {
                for (const [modeName, modeInfo] of Object.entries(update.modes)) {
                    entry.modes[modeName] = { ...modeInfo };
                }
            }
        }
    }

    if (patch.additions) {
        for (const [name, addition] of Object.entries(patch.additions)) {
            result[name] = cloneMnemonicInfo(addition);
        }
    }

    return result;
}

function build65C02Table(table65SC02: Record<string, MnemonicInfo>): Record<string, MnemonicInfo> {
    const result = cloneMnemonicTable(table65SC02);
    for (let bit = 0; bit < 8; bit++) {
        const lowNibbleHex = bit.toString(16).toUpperCase();
        const highOpPrefix = (bit + 8).toString(16).toUpperCase();
        const rmbOpcode = `${lowNibbleHex}7`;
        const smbOpcode = `${highOpPrefix}7`;
        const bbrOpcode = `${lowNibbleHex}F`;
        const bbsOpcode = `${highOpPrefix}F`;

        result[`RMB${bit}`] = {
            fullName: `Reset memory bit ${bit}`,
            description: `Clears bit ${bit} of the specified zero-page memory byte without affecting flags or registers.`,
            seeAlso: [`SMB${bit}`, `BBR${bit}`, 'TRB'],
            modes: {
                'Zero page': { opcode: rmbOpcode, bytes: 2, cycles: 5 },
            },
            flagChanges: {},
        };

        result[`SMB${bit}`] = {
            fullName: `Set memory bit ${bit}`,
            description: `Sets bit ${bit} of the specified zero-page memory byte without affecting flags or registers.`,
            seeAlso: [`RMB${bit}`, `BBS${bit}`, 'TSB'],
            modes: {
                'Zero page': { opcode: smbOpcode, bytes: 2, cycles: 5 },
            },
            flagChanges: {},
        };

        result[`BBR${bit}`] = {
            fullName: `Branch on bit ${bit} reset`,
            description: `Tests bit ${bit} of the specified zero-page byte and branches if it is 0. Syntax: \`bbr${bit} zp, target\`.`,
            seeAlso: [`BBS${bit}`, `RMB${bit}`],
            modes: {
                'Zero page, relative': {
                    opcode: bbrOpcode,
                    bytes: 3,
                    cycles: 5,
                    branchPenalty: true,
                    pagePenalty: true,
                },
            },
            flagChanges: {},
        };

        result[`BBS${bit}`] = {
            fullName: `Branch on bit ${bit} set`,
            description: `Tests bit ${bit} of the specified zero-page byte and branches if it is 1. Syntax: \`bbs${bit} zp, target\`.`,
            seeAlso: [`BBR${bit}`, `SMB${bit}`],
            modes: {
                'Zero page, relative': {
                    opcode: bbsOpcode,
                    bytes: 3,
                    cycles: 5,
                    branchPenalty: true,
                    pagePenalty: true,
                },
            },
            flagChanges: {},
        };
    }
    return result;
}

const MODE_RENAME_65816: Record<string, string> = {
    'Zero page': 'Direct page',
    'Zero page, X': 'Direct page, X',
    'Zero page, Y': 'Direct page, Y',
    '(Zero page)': '(Direct page)',
    '(Indirect, X)': '(Direct page, X)',
    '(Indirect), Y': '(Direct page), Y',
};

const DIRECT_PAGE_MODES_65816 = new Set([
    'Direct page',
    'Direct page, X',
    'Direct page, Y',
    '(Direct page)',
    '(Direct page, X)',
    '(Direct page), Y',
    '[Direct page]',
    '[Direct page], Y',
]);

const ALU_M_OPS_65816 = new Set(['ADC', 'AND', 'CMP', 'CPA', 'EOR', 'LDA', 'ORA', 'SBC']);
const INDEXED_PAGE_OR_X16_MODES = new Set(['Absolute, X', 'Absolute, Y', '(Direct page), Y']);
const RMW_M_OPS_65816 = new Set(['ASL', 'LSR', 'ROL', 'ROR', 'INC', 'DEC', 'TRB', 'TSB']);
const INDEX_READ_X_OPS_65816 = new Set(['CPX', 'CPY', 'LDX', 'LDY']);
const INDEX_WRITE_X_OPS_65816 = new Set(['STX', 'STY']);
const CONDITIONAL_BRANCHES = new Set(['BCC', 'BCS', 'BEQ', 'BMI', 'BNE', 'BPL', 'BVC', 'BVS']);

function build65816Table(
    table65SC02: Record<string, MnemonicInfo>,
    patch65816?: CpuExtensionPatch
): Record<string, MnemonicInfo> {
    const result = applyExtensionPatch(table65SC02, patch65816);

    // Populate CPA alias from resolved CMP before applying Direct Page / width modifiers.
    if (result.CMP && result.CPA) {
        const cmpClone = cloneMnemonicInfo(result.CMP);
        result.CPA.modes = cmpClone.modes;
        result.CPA.flagChanges = cmpClone.flagChanges;
    }

    for (const [name, info] of Object.entries(result)) {
        const renamedModes: Record<string, MnemonicModeInfo> = {};
        for (const [modeName, modeInfo] of Object.entries(info.modes)) {
            const targetName = MODE_RENAME_65816[modeName] || modeName;
            const updated: MnemonicModeInfo = { ...modeInfo };

            if (DIRECT_PAGE_MODES_65816.has(targetName)) {
                updated.dpNonZeroPenalty = true;
            }

            if (ALU_M_OPS_65816.has(name)) {
                if (targetName === 'Immediate') {
                    updated.byteVariableM = true;
                    updated.cycleVariableM = 1;
                } else {
                    updated.cycleVariableM = 1;
                    if (INDEXED_PAGE_OR_X16_MODES.has(targetName)) {
                        delete updated.pagePenalty;
                        updated.pageOrIndex16Penalty = true;
                    }
                }
            } else if (name === 'BIT') {
                if (targetName === 'Immediate') {
                    updated.byteVariableM = true;
                    updated.cycleVariableM = 1;
                } else {
                    updated.cycleVariableM = 1;
                    if (targetName === 'Absolute, X') {
                        delete updated.pagePenalty;
                        updated.pageOrIndex16Penalty = true;
                    }
                }
            } else if (name === 'STA' || name === 'STZ') {
                updated.cycleVariableM = 1;
            } else if (name === 'PHA' || name === 'PLA') {
                updated.cycleVariableM = 1;
            } else if (RMW_M_OPS_65816.has(name)) {
                if (targetName !== 'Accumulator') {
                    updated.cycleVariableM = 2;
                }
            } else if (INDEX_READ_X_OPS_65816.has(name)) {
                if (targetName === 'Immediate') {
                    updated.byteVariableX = true;
                    updated.cycleVariableX = 1;
                } else {
                    updated.cycleVariableX = 1;
                    if (targetName === 'Absolute, X' || targetName === 'Absolute, Y') {
                        delete updated.pagePenalty;
                        updated.pageOrIndex16Penalty = true;
                    }
                }
            } else if (INDEX_WRITE_X_OPS_65816.has(name)) {
                updated.cycleVariableX = 1;
            } else if (name === 'PHX' || name === 'PHY' || name === 'PLX' || name === 'PLY') {
                updated.cycleVariableX = 1;
            } else if (CONDITIONAL_BRANCHES.has(name) && targetName === 'Relative') {
                delete updated.pagePenalty;
                updated.emulationOnlyPagePenalty = true;
            }

            renamedModes[targetName] = updated;
        }
        info.modes = renamedModes;
    }

    return result;
}

export function getMnemonicsForCpu(cpu?: unknown): Record<string, MnemonicInfo> {
    const normalized = normalizeCpu(cpu);
    return cpuMnemonicTables.get(normalized) ?? mnemonicData;
}

export function getMnemonicInfo(mnemonic: string, cpu?: unknown): MnemonicInfo | undefined {
    const table = getMnemonicsForCpu(cpu);
    return table[mnemonic.toUpperCase()];
}

/**
 * Resolves a directive name or alias (case-insensitive) to its definition.
 */
export function resolveDirectiveAlias(key: string): DirectiveInfo | null {
    let entry: DirectiveInfo | string | undefined = directiveData[key.toUpperCase()];

    if (typeof entry === 'string') {
        entry = directiveData[entry];
    }

    if (typeof entry === 'object' && entry !== null) {
        return entry;
    }

    return null;
}

export function loadAllData(connection: _Connection) {
    // Load 6502 mnemonics data
    const mnemonicPath = path.join(__dirname, '..', 'data', '6502_mnemonics.json');
    try {
        mnemonicData = JSON.parse(fs.readFileSync(mnemonicPath, 'utf8'));
        connection.console.log('Successfully loaded 6502 mnemonics data.');
    } catch (error) {
        connection.console.error(`Failed to load mnemonics data: ${error}`);
    }

    // Load CPU extensions and materialize per-CPU mnemonic tables
    const extensionsPath = path.join(__dirname, '..', 'data', 'cpu_extensions.json');
    let extensions: Record<string, CpuExtensionPatch> = {};
    try {
        extensions = JSON.parse(fs.readFileSync(extensionsPath, 'utf8'));
        connection.console.log('Successfully loaded CPU extension mnemonics data.');
    } catch (error) {
        connection.console.error(`Failed to load CPU extension data: ${error}`);
    }

    const table6502 = cloneMnemonicTable(mnemonicData);
    const table65SC02 = applyExtensionPatch(table6502, extensions['65SC02']);
    const table65C02 = build65C02Table(table65SC02);
    const tableW65C02 = applyExtensionPatch(table65C02, extensions['W65C02']);
    const table65816 = build65816Table(table65SC02, extensions['65816']);

    cpuMnemonicTables.clear();
    cpuMnemonicTables.set('6502', table6502);
    cpuMnemonicTables.set('65SC02', table65SC02);
    cpuMnemonicTables.set('65C02', table65C02);
    cpuMnemonicTables.set('W65C02', tableW65C02);
    cpuMnemonicTables.set('65816', table65816);

    // Load ca65 directives data
    const directivePath = path.join(__dirname, '..', 'data', 'ca65_directives.json');
    try {
        directiveData = JSON.parse(fs.readFileSync(directivePath, 'utf8'));
        connection.console.log('Successfully loaded ca65 directives data.');
    } catch (error) {
        connection.console.error(`Failed to load ca65 directives data: ${error}`);
    }
}
