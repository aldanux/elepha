import path from 'node:path';
import type { Readable, Writable } from 'node:stream';
import * as clack from '@clack/prompts';
import { expandUserPath } from '../config/paths.js';
import { type FullBackup, listFullBackups } from './commands/backup.js';
import { printTagline } from './wordmark.js';

const MANUAL_PATH = '__elepha_manual_restore_path__';

interface RestoreInput extends Readable {
    isTTY?: boolean;
}

interface RestoreOutput extends Writable {
    isTTY?: boolean;
}

interface PromptOption {
    value: string;
    label: string;
    hint?: string;
}

export interface RestorePrompts {
    intro(title: string): void;
    select(options: { message: string; options: PromptOption[] }): Promise<string | symbol>;
    text(options: {
        message: string;
        placeholder?: string;
        validate?: (value: string | undefined) => string | undefined;
    }): Promise<string | symbol>;
    confirm(options: { message: string; initialValue?: boolean }): Promise<boolean | symbol>;
    isCancel(value: unknown): boolean;
    cancel(message: string): void;
    outro(message: string): void;
}

export interface RestoreWizardOptions {
    input?: RestoreInput;
    output?: RestoreOutput;
    error?: Writable;
    backups?: FullBackup[];
    // Test seam; production routes every visual element through @clack/prompts.
    prompts?: RestorePrompts;
    restore(file: string, confirm: () => Promise<boolean>): Promise<{ cancelled: boolean }>;
}

function clackPrompts(input: RestoreInput, output: RestoreOutput): RestorePrompts {
    const common = { input, output };
    return {
        intro: (title) => clack.intro(title, common),
        select: (options) => clack.select({ ...options, ...common }) as Promise<string | symbol>,
        text: (options) => clack.text({ ...options, ...common }) as Promise<string | symbol>,
        confirm: (options) => clack.confirm({ ...options, ...common }) as Promise<boolean | symbol>,
        isCancel: clack.isCancel,
        cancel: (message) => clack.cancel(message, common),
        outro: (message) => clack.outro(message, common),
    };
}

function print(output: Writable, message: string): void {
    output.write(`${message}\n`);
}

function cancelled(prompts: RestorePrompts): number {
    prompts.cancel('Operation cancelled. No changes were made.');
    return 0;
}

function humanSize(bytes: number): string {
    const units = ['B', 'KB', 'MB', 'GB', 'TB'];
    let value = bytes;
    let unit = 0;
    while (value >= 1_024 && unit < units.length - 1) {
        value /= 1_024;
        unit += 1;
    }
    const precision = unit === 0 || value >= 10 ? 0 : 1;
    return `${value.toFixed(precision).replace(/\.0$/, '')} ${units[unit]}`;
}

function backupHint(backup: FullBackup): string {
    const date = new Date(backup.mtimeMs)
        .toISOString()
        .replace('T', ' ')
        .replace(/\.\d{3}Z$/, ' UTC');
    return `${humanSize(backup.bytes)} · ${date}`;
}

async function promptForPath(prompts: RestorePrompts): Promise<string | symbol> {
    return prompts.text({
        message: 'Which full elepha backup should be restored?',
        placeholder: '/path/to/elepha-full-…db',
        validate: (value) => (value?.trim() ? undefined : 'Enter the backup file path.'),
    });
}

// Interactive front-end for restore; validation, preview, snapshot, and replacement stay in the restore operation.
export async function runRestoreWizard(options: RestoreWizardOptions): Promise<number> {
    const input = options.input ?? process.stdin;
    const output = options.output ?? process.stdout;
    const error = options.error ?? process.stderr;
    if (!input.isTTY) {
        print(error, 'Specify a backup file when not running interactively.');
        return 1;
    }

    const prompts = options.prompts ?? clackPrompts(input, output);
    printTagline(output);
    prompts.intro('Restore elepha memory');
    const backups = [...(options.backups ?? listFullBackups())].sort(
        (a, b) => b.mtimeMs - a.mtimeMs || path.basename(b.path).localeCompare(path.basename(a.path)),
    );
    let selected: string | symbol;
    if (backups.length === 0) {
        selected = await promptForPath(prompts);
    } else {
        selected = await prompts.select({
            message: 'Which full elepha backup should be restored?',
            options: [
                ...backups.map((backup) => ({ value: backup.path, label: path.basename(backup.path), hint: backupHint(backup) })),
                { value: MANUAL_PATH, label: 'Enter a path manually…' },
            ],
        });
        if (selected === MANUAL_PATH) {
            selected = await promptForPath(prompts);
        }
    }
    if (prompts.isCancel(selected) || typeof selected !== 'string' || !selected.trim()) {
        return cancelled(prompts);
    }

    let wasCancelled = false;
    const result = await options.restore(expandUserPath(selected.trim()), async () => {
        const confirmed = await prompts.confirm({
            message: 'Replace the current elepha database with this backup? A snapshot of the current database is saved first.',
            initialValue: false,
        });
        if (prompts.isCancel(confirmed) || confirmed !== true) {
            wasCancelled = true;
            return false;
        }
        return true;
    });
    if (result.cancelled || wasCancelled) {
        return cancelled(prompts);
    }
    prompts.outro('Restore complete.');
    return 0;
}
