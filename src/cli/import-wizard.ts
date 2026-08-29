import path from 'node:path';
import type { Readable, Writable } from 'node:stream';
import * as clack from '@clack/prompts';
import { USER_BACKUPS_DIR_NAME } from '../config/constants.js';
import { elephaHome } from '../config/paths.js';
import { listRegularFiles } from '../util/fs.js';
import { printTagline } from './wordmark.js';

interface ImportInput extends Readable {
    isTTY?: boolean;
}

interface ImportOutput extends Writable {
    isTTY?: boolean;
}

interface PromptOption {
    value: string;
    label: string;
    hint?: string;
}

export interface ImportPrompts {
    intro(title: string): void;
    select(options: { message: string; options: PromptOption[] }): Promise<string | symbol>;
    confirm(options: { message: string; initialValue?: boolean }): Promise<boolean | symbol>;
    isCancel(value: unknown): boolean;
    cancel(message: string): void;
    outro(message: string): void;
}

export interface ImportWizardOptions {
    input?: ImportInput;
    output?: ImportOutput;
    error?: Writable;
    backups?: string[];
    skipConfirmation?: boolean;
    /** Test seam; production routes every visual element through @clack/prompts. */
    prompts?: ImportPrompts;
    importBackup(file: string, overwrite: boolean, confirm?: () => Promise<boolean>): Promise<{ cancelled: boolean }>;
}

function clackPrompts(input: ImportInput, output: ImportOutput): ImportPrompts {
    const common = { input, output };
    return {
        intro: (title) => clack.intro(title, common),
        select: (options) => clack.select({ ...options, ...common }) as Promise<string | symbol>,
        confirm: (options) => clack.confirm({ ...options, ...common }) as Promise<boolean | symbol>,
        isCancel: clack.isCancel,
        cancel: (message) => clack.cancel(message, common),
        outro: (message) => clack.outro(message, common),
    };
}

function print(output: Writable, message: string): void {
    output.write(`${message}\n`);
}

function cancelled(prompts: ImportPrompts): number {
    prompts.cancel('Operation cancelled. No changes were made.');
    return 0;
}

function importBackupDirectory(): string {
    return path.join(elephaHome(), USER_BACKUPS_DIR_NAME);
}

function listImportBackups(directory = importBackupDirectory()): string[] {
    return listRegularFiles(directory).sort((a, b) => path.basename(b).localeCompare(path.basename(a)));
}

/** Interactive backup and mode selection; validation, preview, snapshot, and merge stay in the import operation. */
export async function runImportWizard(options: ImportWizardOptions): Promise<number> {
    const input = options.input ?? process.stdin;
    const output = options.output ?? process.stdout;
    const error = options.error ?? process.stderr;
    if (!input.isTTY) {
        print(error, 'Specify a backup file when not running interactively.');
        return 1;
    }

    const prompts = options.prompts ?? clackPrompts(input, output);
    printTagline(output);
    prompts.intro('Import elepha memory');
    const backups = options.backups ?? listImportBackups();
    if (backups.length === 0) {
        prompts.outro(`No backups found in ${importBackupDirectory()}.`);
        return 0;
    }

    const selected = await prompts.select({
        message: 'Which backup should elepha import?',
        options: backups.map((file) => ({ value: file, label: path.basename(file), hint: file })),
    });
    if (prompts.isCancel(selected) || typeof selected !== 'string') {
        return cancelled(prompts);
    }

    const mode = await prompts.select({
        message: 'How should existing sessions be handled?',
        options: [
            { value: 'safe', label: 'Safe import', hint: 'Keep every existing row unchanged' },
            { value: 'overwrite', label: 'Overwrite existing', hint: "Use the backup's version for matching sessions" },
        ],
    });
    if (prompts.isCancel(mode) || (mode !== 'safe' && mode !== 'overwrite')) {
        return cancelled(prompts);
    }

    let wasCancelled = false;
    const overwrite = mode === 'overwrite';
    const confirm = options.skipConfirmation
        ? undefined
        : async () => {
              const confirmed = await prompts.confirm({
                  message: overwrite
                      ? 'Import this backup and overwrite matching sessions? A snapshot of the current database is saved first.'
                      : 'Import only new sessions from this backup? A snapshot of the current database is saved first.',
                  initialValue: false,
              });
              if (prompts.isCancel(confirmed) || confirmed !== true) {
                  wasCancelled = true;
                  return false;
              }
              return true;
          };
    const result = await options.importBackup(selected, overwrite, confirm);
    if (result.cancelled || wasCancelled) {
        return cancelled(prompts);
    }
    prompts.outro('Import complete.');
    return 0;
}
