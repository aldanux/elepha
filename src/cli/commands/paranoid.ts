import type { Command } from 'commander';
import { openDb } from '../../storage/db.js';
import {
    disableParanoidMode,
    enableParanoidMode,
    lockMemory,
    NON_TTY_UNLOCK_MESSAGE,
    unlockMemory,
    WRONG_PASSPHRASE_MESSAGE,
} from '../../storage/paranoid-gate.js';
import { readTtyPassphrase } from '../tty-passphrase.js';

export interface ParanoidCommandRuntime {
    stdinIsTty?: () => boolean;
    stderrIsTty?: () => boolean;
    readPassphrase?: (prompt: string) => Promise<string>;
    openDatabase?: typeof openDb;
    output?: (message: string) => void;
    error?: (message: string) => void;
}

function terminalAvailable(runtime: ParanoidCommandRuntime): boolean {
    return (
        (runtime.stdinIsTty ?? (() => process.stdin.isTTY === true))() && (runtime.stderrIsTty ?? (() => process.stderr.isTTY === true))()
    );
}

async function withDatabase<T>(runtime: ParanoidCommandRuntime, operation: (db: Awaited<ReturnType<typeof openDb>>) => T): Promise<T> {
    const db = await (runtime.openDatabase ?? openDb)();
    try {
        return operation(db);
    } finally {
        db.close();
    }
}

function terminalRefusal(runtime: ParanoidCommandRuntime): void {
    (runtime.error ?? console.error)(NON_TTY_UNLOCK_MESSAGE);
    process.exitCode = 1;
}

async function readFromTerminal(runtime: ParanoidCommandRuntime, prompt: string): Promise<string | undefined> {
    if (!terminalAvailable(runtime)) {
        terminalRefusal(runtime);
        return undefined;
    }
    return (runtime.readPassphrase ?? readTtyPassphrase)(prompt);
}

export async function enableParanoid(runtime: ParanoidCommandRuntime = {}): Promise<void> {
    const first = await readFromTerminal(runtime, 'Passphrase: ');
    if (first === undefined) {
        return;
    }
    const second = await (runtime.readPassphrase ?? readTtyPassphrase)('Confirm passphrase: ');
    if (first !== second) {
        (runtime.error ?? console.error)('Passphrases do not match. Paranoid mode remains unchanged.');
        process.exitCode = 1;
        return;
    }
    if (first.length === 0) {
        (runtime.error ?? console.error)('Passphrase cannot be empty. Paranoid mode remains unchanged.');
        process.exitCode = 1;
        return;
    }
    await withDatabase(runtime, (db) => enableParanoidMode(db, first));
    (runtime.output ?? console.log)('Paranoid mode enabled. Memory is locked.');
}

export async function unlockParanoid(runtime: ParanoidCommandRuntime = {}): Promise<void> {
    const passphrase = await readFromTerminal(runtime, 'Passphrase: ');
    if (passphrase === undefined) {
        return;
    }
    const result = await withDatabase(runtime, (db) => unlockMemory(db, passphrase));
    if (result === 'incorrect') {
        (runtime.error ?? console.error)(WRONG_PASSPHRASE_MESSAGE);
        process.exitCode = 1;
        return;
    }
    (runtime.output ?? console.log)(result === 'not_enabled' ? 'Paranoid mode is not enabled.' : 'Memory unlocked.');
}

export async function lockParanoid(runtime: ParanoidCommandRuntime = {}): Promise<void> {
    const result = await withDatabase(runtime, lockMemory);
    (runtime.output ?? console.log)(result === 'not_enabled' ? 'Paranoid mode is not enabled.' : 'Memory locked.');
}

export async function disableParanoid(runtime: ParanoidCommandRuntime = {}): Promise<void> {
    const passphrase = await readFromTerminal(runtime, 'Passphrase: ');
    if (passphrase === undefined) {
        return;
    }
    const result = await withDatabase(runtime, (db) => disableParanoidMode(db, passphrase));
    if (result === 'incorrect') {
        (runtime.error ?? console.error)(WRONG_PASSPHRASE_MESSAGE);
        process.exitCode = 1;
        return;
    }
    (runtime.output ?? console.log)(result === 'not_enabled' ? 'Paranoid mode is not enabled.' : 'Paranoid mode disabled.');
}

export function registerParanoid(program: Command, runtime: ParanoidCommandRuntime = {}): void {
    const paranoid = program.command('paranoid').description('Manage the optional passphrase-gated memory read lock');
    paranoid
        .command('enable')
        .description('Enable paranoid mode and lock memory reads')
        .allowExcessArguments(false)
        .action(() => enableParanoid(runtime));
    paranoid
        .command('disable')
        .description('Disable paranoid mode after verifying its passphrase')
        .allowExcessArguments(false)
        .action(() => disableParanoid(runtime));

    program
        .command('unlock')
        .description('Unlock paranoid-mode memory reads from a controlling terminal')
        .allowExcessArguments(false)
        .action(() => unlockParanoid(runtime));
    program
        .command('lock')
        .description('Lock paranoid-mode memory reads')
        .allowExcessArguments(false)
        .action(() => lockParanoid(runtime));
}
