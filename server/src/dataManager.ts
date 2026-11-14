import * as path from 'path';
import * as fs from 'fs';
import { _Connection } from 'vscode-languageserver/node';

export interface DirectiveInfo {
    type: 'Control command' | 'Pseudo-function' | 'Pseudo-variable';
    shortDescription: string;
    documentationUrl?: string;
}

export let mnemonicData: Record<string, any> = {};
export let directiveData: Record<string, DirectiveInfo | string> = {};

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

    // Load ca65 directives data
    const directivePath = path.join(__dirname, '..', 'data', 'ca65_directives.json');
    try {
        directiveData = JSON.parse(fs.readFileSync(directivePath, 'utf8'));
        connection.console.log('Successfully loaded ca65 directives data.');
    } catch (error) {
        connection.console.error(`Failed to load ca65 directives data: ${error}`);
    }
}
