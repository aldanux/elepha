import path from 'node:path';
import { Command } from 'commander';
import { afterEach, describe, expect, it } from 'vitest';
import { enableParanoid, registerParanoid, unlockParanoid } from '../../src/cli/commands/paranoid.js';
import type { DatabaseEncryptionRuntime } from '../../src/storage/database-encryption.js';
import { openDb } from '../../src/storage/db.js';
import { isMemoryLocked, NON_TTY_UNLOCK_MESSAGE, WRONG_PASSPHRASE_MESSAGE } from '../../src/storage/paranoid-gate.js';
import { withGrantableTestDir } from '../helpers/tmp.js';

const PASSPHRASE = 'terminal-only passphrase';

function encryptionRuntime(directory: string): DatabaseEncryptionRuntime {
    return {
        platform: 'linux',
        env: { CI: '1' },
        randomBytes: () => Buffer.alloc(32, 9),
        randomUUID: () => '22222222-2222-4222-8222-222222222222',
        keyFilePath: () => path.join(directory, 'elepha.keydata'),
    };
}

describe('paranoid lifecycle CLI boundary', () => {
    afterEach(() => {
        process.exitCode = undefined;
    });

    it('refuses unlock before opening the database unless both stdin and stderr are TTYs', async () => {
        const errors: string[] = [];
        let opened = false;
        await unlockParanoid({
            stdinIsTty: () => false,
            stderrIsTty: () => true,
            openDatabase: (() => {
                opened = true;
                throw new Error('must not open');
            }) as typeof openDb,
            error: (message) => errors.push(message),
        });

        expect(opened).toBe(false);
        expect(errors).toEqual([NON_TTY_UNLOCK_MESSAGE]);
        expect(process.exitCode).toBe(1);
    });

    it('rejects a passphrase supplied in argv before invoking the terminal reader', async () => {
        const program = new Command();
        program.exitOverride();
        program.configureOutput({ writeErr: () => undefined });
        let read = false;
        registerParanoid(program, {
            stdinIsTty: () => true,
            stderrIsTty: () => true,
            readPassphrase: async () => {
                read = true;
                return PASSPHRASE;
            },
        });

        await expect(program.parseAsync(['node', 'elepha', 'unlock', PASSPHRASE])).rejects.toMatchObject({
            code: 'commander.excessArguments',
        });
        expect(read).toBe(false);
    });

    it('enables and unlocks only through an injected controlling-TTY reader', async () => {
        const directory = withGrantableTestDir('elepha-paranoid-cli-');
        const dbPath = path.join(directory, 'elepha.db');
        const runtime = encryptionRuntime(directory);
        const initial = await openDb(dbPath, { encryption: runtime });
        initial.close();
        const openDatabase = (() => openDb(dbPath, { encryption: runtime })) as typeof openDb;
        const output: string[] = [];
        const errors: string[] = [];
        const enableReads = [PASSPHRASE, PASSPHRASE];

        await enableParanoid({
            stdinIsTty: () => true,
            stderrIsTty: () => true,
            readPassphrase: async () => enableReads.shift() ?? '',
            openDatabase,
            output: (message) => output.push(message),
            error: (message) => errors.push(message),
        });
        let verification = await openDb(dbPath, { encryption: runtime });
        expect(isMemoryLocked(verification)).toBe(true);
        verification.close();

        await unlockParanoid({
            stdinIsTty: () => true,
            stderrIsTty: () => true,
            readPassphrase: async () => 'wrong passphrase',
            openDatabase,
            output: (message) => output.push(message),
            error: (message) => errors.push(message),
        });
        expect(errors).toEqual([WRONG_PASSPHRASE_MESSAGE]);
        verification = await openDb(dbPath, { encryption: runtime });
        expect(isMemoryLocked(verification)).toBe(true);
        verification.close();

        process.exitCode = undefined;
        await unlockParanoid({
            stdinIsTty: () => true,
            stderrIsTty: () => true,
            readPassphrase: async () => PASSPHRASE,
            openDatabase,
            output: (message) => output.push(message),
            error: (message) => errors.push(message),
        });
        verification = await openDb(dbPath, { encryption: runtime });
        expect(isMemoryLocked(verification)).toBe(false);
        verification.close();
        expect(output).toEqual(['Paranoid mode enabled. Memory is locked.', 'Memory unlocked.']);
    });
});
