import * as fs from 'node:fs';
import path from 'node:path';
import { Command } from 'commander';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { disableMemoryPlus, registerDisable } from '../../src/cli/commands/disable.js';
import { enableMemoryPlus, MEMORY_PLUS_PROBE } from '../../src/cli/commands/enable.js';
import { registerUninstall } from '../../src/cli/commands/uninstall.js';
import {
    MEMORY_PLUS_UNINSTALL_CONFIRM,
    MEMORY_PLUS_UNINSTALL_RETENTION,
    memoryPlusRemovalReport,
    uninstallMemoryPlus,
} from '../../src/cli/commands/uninstall-memory-plus.js';
import * as shared from '../../src/cli/shared.js';
import { elephaPaths } from '../../src/config/paths.js';
import { getSetting, setSetting } from '../../src/config/settings.js';
import { generateEmbeddings } from '../../src/embeddings/generate.js';
import { embeddingConfiguration } from '../../src/embeddings/provider-config.js';
import * as installer from '../../src/install/installer.js';
import * as backup from '../../src/storage/backup.js';
import { openUnmanagedDb } from '../../src/storage/db.js';
import { createTestDb, seedConsentRoot, seedProject, seedSession } from '../helpers/db.js';

vi.mock('node:fs', async (importOriginal) => ({ ...(await importOriginal<typeof import('node:fs')>()) }));

afterEach(() => {
    vi.restoreAllMocks();
    vi.unstubAllEnvs();
    process.exitCode = undefined;
});

async function fixture() {
    const f = createTestDb('memory-plus-lifecycle-');
    vi.stubEnv('ELEPHA_HOME', f.directory);
    vi.stubEnv('ELEPHA_DB_PATH', f.dbPath);
    const paths = elephaPaths();
    const project = seedProject(f);
    seedConsentRoot(f, { path: project.path });
    seedSession(f, { project, title: 'History to retain' });
    const provider = {
        configuration: embeddingConfiguration(true)!,
        embed: vi.fn(async () => Array(384).fill(0.25)),
        dispose: vi.fn(async () => {}),
    };
    const createProvider = vi.fn(async () => provider);
    setSetting('memory-plus', 'true');
    await generateEmbeddings(f.db, { createProvider });
    provider.embed.mockClear();
    const vectors = () => f.db.prepare('SELECT * FROM session_embeddings').all();
    const originalVectors = vectors();
    expect(originalVectors).toHaveLength(1);
    const installRuntime = () => {
        fs.mkdirSync(paths.memoryPlus, { recursive: true });
        fs.writeFileSync(path.join(paths.memoryPlus, 'package.json'), '{"private":true}');
    };
    return { ...f, paths, provider, createProvider, vectors, originalVectors, installRuntime };
}

describe('Memory-Plus disable and runtime uninstall', () => {
    it('dispatches disable, retains runtime and vectors, and re-enables without regenerating current history', async () => {
        const f = await fixture();
        f.installRuntime();
        const log = vi.spyOn(console, 'log').mockImplementation(() => {});
        const program = new Command();
        registerDisable(program);
        await program.parseAsync(['node', 'elepha', 'disable', 'memory-plus']);
        expect(getSetting('memory-plus').value).toBe(false);
        expect(f.vectors()).toEqual(f.originalVectors);
        expect(fs.existsSync(f.paths.memoryPlus)).toBe(true);
        expect(log).toHaveBeenCalledWith(expect.stringMatching(/disabled.*vectors.*retained/i));

        await enableMemoryPlus({
            confirm: async () => true,
            installDependency: async () => {},
            createProvider: f.createProvider,
            openDatabase: async () => openUnmanagedDb(f.dbPath),
            log,
        });
        expect(getSetting('memory-plus').value).toBe(true);
        expect(f.provider.embed).toHaveBeenCalledExactlyOnceWith(MEMORY_PLUS_PROBE, expect.any(Function));
        expect(f.vectors()).toEqual(f.originalVectors);
        expect(log).toHaveBeenCalledWith(expect.stringMatching(/0 sessions indexed, 1 already current/));
    });

    it('treats already off as a successful no-op without rewriting configuration or vectors', async () => {
        const f = await fixture();
        setSetting('memory-plus', 'false');
        const before = fs.statSync(f.paths.config);
        const log = vi.fn();
        disableMemoryPlus({ log });
        expect(getSetting('memory-plus').value).toBe(false);
        expect(fs.statSync(f.paths.config)).toEqual(before);
        expect(f.vectors()).toEqual(f.originalVectors);
        expect(log).toHaveBeenCalledWith(expect.stringMatching(/already off.*vectors.*retained/i));
    });

    it.each([true, false])('previews, confirms, backs up, removes only the runtime and verifies absence (enabled: %s)', async (enabled) => {
        const f = await fixture();
        f.installRuntime();
        setSetting('memory-plus', String(enabled));
        fs.mkdirSync(f.paths.embeddingModels, { recursive: true });
        const model = path.join(f.paths.embeddingModels, 'model.bin');
        fs.writeFileSync(model, 'cached model');
        const external = path.join(f.directory, 'external');
        fs.mkdirSync(external);
        fs.writeFileSync(path.join(external, 'keep'), 'unrelated');
        fs.symlinkSync(external, path.join(f.paths.memoryPlus, 'child-link'), 'dir');
        const log = vi.fn();
        const confirm = vi.fn(async () => {
            expect(log.mock.calls[0]).toEqual([memoryPlusRemovalReport(fs.realpathSync(f.paths.memoryPlus))]);
            expect(log).toHaveBeenCalledWith(MEMORY_PLUS_UNINSTALL_RETENTION);
            expect(fs.existsSync(f.paths.memoryPlus)).toBe(true);
            expect(getSetting('memory-plus').value).toBe(enabled);
            expect(backup.listManagedBackups(f.dbPath)).toEqual([]);
            return true;
        });
        const actualFs = await vi.importActual<typeof import('node:fs')>('node:fs');
        const remove = vi.spyOn(fs, 'rmSync').mockImplementation((target, options) => {
            expect(getSetting('memory-plus').value).toBe(false);
            expect(backup.listManagedBackups(f.dbPath)).toHaveLength(1);
            actualFs.rmSync(target, options);
        });
        await expect(uninstallMemoryPlus({ confirm, log })).resolves.toBe(true);
        expect(confirm).toHaveBeenCalledExactlyOnceWith(MEMORY_PLUS_UNINSTALL_CONFIRM);
        expect(remove).toHaveBeenCalledExactlyOnceWith(f.paths.memoryPlus, { recursive: true });
        expect(fs.existsSync(f.paths.memoryPlus)).toBe(false);
        expect(fs.readFileSync(model, 'utf8')).toBe('cached model');
        expect(fs.readFileSync(path.join(external, 'keep'), 'utf8')).toBe('unrelated');
        expect(getSetting('memory-plus').value).toBe(false);
        expect(f.vectors()).toEqual(f.originalVectors);
        const backups = backup.listManagedBackups(f.dbPath);
        expect(backups).toHaveLength(1);
        const saved = openUnmanagedDb(backups[0]!);
        try {
            expect(saved.prepare('SELECT * FROM session_embeddings').all()).toEqual(f.originalVectors);
        } finally {
            saved.close();
        }
        expect(log).toHaveBeenLastCalledWith(expect.stringContaining(MEMORY_PLUS_UNINSTALL_RETENTION));
    });

    it.each([true, false])('handles an already-uninstalled runtime without a prompt or deletion (enabled: %s)', async (enabled) => {
        const f = await fixture();
        setSetting('memory-plus', String(enabled));
        const confirm = vi.fn();
        const remove = vi.spyOn(fs, 'rmSync');
        const log = vi.fn();
        await expect(uninstallMemoryPlus({ confirm, log })).resolves.toBe(true);
        expect(confirm).not.toHaveBeenCalled();
        expect(remove).not.toHaveBeenCalled();
        expect(getSetting('memory-plus').value).toBe(false);
        expect(f.vectors()).toEqual(f.originalVectors);
        expect(backup.listManagedBackups(f.dbPath)).toEqual([]);
        expect(log).toHaveBeenCalledWith(expect.stringMatching(/already uninstalled.*off.*vectors.*retained/i));
    });

    it('leaves everything unchanged when confirmation is declined', async () => {
        const f = await fixture();
        f.installRuntime();
        await expect(uninstallMemoryPlus({ confirm: async () => false, log: vi.fn() })).resolves.toBe(false);
        expect(fs.existsSync(f.paths.memoryPlus)).toBe(true);
        expect(getSetting('memory-plus').value).toBe(true);
        expect(f.vectors()).toEqual(f.originalVectors);
        expect(backup.listManagedBackups(f.dbPath)).toEqual([]);
    });

    it.each(['directory', 'symlink'] as const)('aborts if the confirmed directory is replaced with a %s', async (replacement) => {
        const f = await fixture();
        f.installRuntime();
        const moved = path.join(f.directory, 'original-runtime');
        const confirm = async () => {
            fs.renameSync(f.paths.memoryPlus, moved);
            if (replacement === 'symlink') fs.symlinkSync(moved, f.paths.memoryPlus, 'dir');
            else fs.mkdirSync(f.paths.memoryPlus);
            return true;
        };
        await expect(uninstallMemoryPlus({ confirm, log: vi.fn() })).rejects.toThrow('changed since preview');
        expect(fs.existsSync(path.join(moved, 'package.json'))).toBe(true);
        expect(fs.lstatSync(f.paths.memoryPlus)).toBeDefined();
        expect(getSetting('memory-plus').value).toBe(true);
        expect(backup.listManagedBackups(f.dbPath)).toEqual([]);
    });

    it('refuses a runtime symlink before confirmation, including a dangling link', async () => {
        const f = await fixture();
        fs.symlinkSync(path.join(f.directory, 'missing'), f.paths.memoryPlus, 'dir');
        const confirm = vi.fn();
        await expect(uninstallMemoryPlus({ confirm, log: vi.fn() })).rejects.toThrow('symlink');
        expect(confirm).not.toHaveBeenCalled();
        expect(getSetting('memory-plus').value).toBe(true);
    });

    it.each(['direct', 'symlink'] as const)('refuses a configured database inside the runtime via a %s path', async (location) => {
        const f = await fixture();
        f.installRuntime();
        const database = path.join(f.paths.memoryPlus, 'memory.db');
        f.db.pragma('wal_checkpoint(TRUNCATE)');
        fs.copyFileSync(f.dbPath, database);
        const alias = path.join(f.directory, 'database-alias');
        fs.symlinkSync(database, alias);
        vi.stubEnv('ELEPHA_DB_PATH', location === 'direct' ? database : alias);
        const before = fs.readFileSync(database);
        const confirm = vi.fn();
        await expect(uninstallMemoryPlus({ confirm, log: vi.fn() })).rejects.toThrow('contains protected data');
        expect(confirm).not.toHaveBeenCalled();
        expect(fs.readFileSync(database)).toEqual(before);
        expect(getSetting('memory-plus').value).toBe(true);
    });

    it('does not change settings or remove the runtime when the required backup fails', async () => {
        const f = await fixture();
        f.installRuntime();
        vi.spyOn(backup, 'writeBackup').mockImplementation(() => {
            throw new Error('backup failed');
        });
        await expect(uninstallMemoryPlus({ confirm: async () => true, log: vi.fn() })).rejects.toThrow('backup failed');
        expect(fs.existsSync(f.paths.memoryPlus)).toBe(true);
        expect(getSetting('memory-plus').value).toBe(true);
        expect(f.vectors()).toEqual(f.originalVectors);
    });

    it.each(['failure', 'still present'] as const)('keeps the feature off and reports removal %s', async (failure) => {
        const f = await fixture();
        f.installRuntime();
        vi.spyOn(fs, 'rmSync').mockImplementation(() => {
            expect(getSetting('memory-plus').value).toBe(false);
            if (failure === 'failure') throw new Error('permission denied');
        });
        await expect(uninstallMemoryPlus({ confirm: async () => true, log: vi.fn() })).rejects.toThrow(
            failure === 'failure' ? 'permission denied' : 'still exists after removal',
        );
        expect(getSetting('memory-plus').value).toBe(false);
        expect(f.vectors()).toEqual(f.originalVectors);
    });

    it('routes uninstall memory-plus independently from elepha and hook uninstall', async () => {
        const f = await fixture();
        f.installRuntime();
        const teardown = vi.spyOn(installer, 'uninstallElepha').mockImplementation(() => {
            throw new Error('global lifecycle must not run');
        });
        vi.spyOn(shared, 'confirmYesNo').mockResolvedValue(true);
        vi.spyOn(console, 'log').mockImplementation(() => {});
        const program = new Command();
        program.command('hook');
        registerUninstall(program);
        await program.parseAsync(['node', 'elepha', 'uninstall', 'memory-plus']);
        expect(teardown).not.toHaveBeenCalled();
        expect(process.exitCode).not.toBe(1);
        expect(fs.existsSync(f.paths.memoryPlus)).toBe(false);
        expect(getSetting('memory-plus').value).toBe(false);
        expect(f.vectors()).toEqual(f.originalVectors);
    });
});
