import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { PassThrough } from 'node:stream';
import { describe, expect, it, vi } from 'vitest';
import { type BackupPrompts, runBackupWizard } from '../../src/cli/backup-wizard.js';
import { type PurgePrompts, runPurgeWizard } from '../../src/cli/purge-wizard.js';
import { openDb } from '../../src/storage/db.js';
import { MemoryStore } from '../../src/storage/memory-store.js';

const CANCELLED = Symbol('cancelled');
const repositoryRoot = path.resolve(import.meta.dirname, '..', '..');

function ttyStream(): PassThrough {
    const stream = new PassThrough();
    Object.defineProperty(stream, 'isTTY', { value: true });
    return stream;
}

function projectFixture() {
    const directory = mkdtempSync(path.join(tmpdir(), 'elepha-project-labels-'));
    const db = openDb(path.join(directory, 'elepha.db'));
    const store = new MemoryStore(db);
    const childPath = path.join(repositoryRoot, 'src');
    const project = store.upsertProject(repositoryRoot);
    db.prepare(
        `INSERT INTO projects (path, display_name, git_root, git_remote, git_root_commit, first_seen_at, last_seen_at)
         VALUES (?, ?, ?, ?, ?, ?, ?)`,
    ).run(
        childPath,
        'src',
        project.git_root,
        project.git_remote,
        project.git_root_commit,
        '2026-08-01T00:00:00.000Z',
        '2026-08-01T00:00:00.000Z',
    );
    return { directory, db, store, childPath };
}

async function purgeProjectLabel(store: MemoryStore): Promise<string | undefined> {
    const selections: Array<string | symbol> = ['project', CANCELLED];
    const select = vi.fn(async (_options: Parameters<PurgePrompts['select']>[0]) => selections.shift() ?? CANCELLED);
    const prompts: PurgePrompts = {
        intro: vi.fn(),
        select,
        text: vi.fn(async () => CANCELLED),
        confirm: vi.fn(async () => CANCELLED),
        isCancel: (value) => value === CANCELLED,
        cancel: vi.fn(),
        outro: vi.fn(),
        spinner: () => ({ start: vi.fn(), stop: vi.fn() }),
    };

    await runPurgeWizard({
        input: ttyStream(),
        output: ttyStream(),
        store,
        prompts,
        runPurge: async () => {
            throw new Error('project selection was cancelled');
        },
        runExternalAgentImports: async () => {
            throw new Error('external-agent-imports was not selected');
        },
    });

    const projectPrompt = select.mock.calls[1]?.[0] as { options: Array<{ value: string; label: string }> } | undefined;
    return projectPrompt?.options.find((option) => option.value === repositoryRoot)?.label;
}

async function backupProjectLabel(store: MemoryStore): Promise<string | undefined> {
    const selections: Array<string | symbol> = ['project', CANCELLED];
    const select = vi.fn(async (_options: Parameters<BackupPrompts['select']>[0]) => selections.shift() ?? CANCELLED);
    const prompts: BackupPrompts = {
        intro: vi.fn(),
        select,
        text: vi.fn(async () => CANCELLED),
        isCancel: (value) => value === CANCELLED,
        cancel: vi.fn(),
        outro: vi.fn(),
    };

    await runBackupWizard({
        input: ttyStream(),
        output: ttyStream(),
        store,
        prompts,
        defaultOutput: () => 'unused.db',
        backupAll: async () => {
            throw new Error('all memory was not selected');
        },
        backupProject: async () => {
            throw new Error('project selection was cancelled');
        },
    });

    const projectPrompt = select.mock.calls[1]?.[0] as { options: Array<{ value: string; label: string }> } | undefined;
    return projectPrompt?.options.find((option) => option.value === repositoryRoot)?.label;
}

describe('project-set consent labels', () => {
    it.each([
        { decisions: 'pending + pending', configure: () => undefined, purgeLabel: 'elepha', backupLabel: 'elepha' },
        {
            decisions: 'pending + denied',
            configure: (store: MemoryStore, childPath: string) => store.consent.revoke(childPath),
            purgeLabel: 'elepha (revoked)',
            backupLabel: 'elepha (paused)',
        },
        {
            decisions: 'approved + approved',
            configure: (store: MemoryStore) => store.consent.grant(repositoryRoot),
            purgeLabel: 'elepha',
            backupLabel: 'elepha',
        },
        {
            decisions: 'approved + denied',
            configure: (store: MemoryStore, childPath: string) => {
                store.consent.grant(repositoryRoot);
                store.consent.revoke(childPath);
            },
            purgeLabel: 'elepha',
            backupLabel: 'elepha',
        },
        {
            decisions: 'denied + approved',
            configure: (store: MemoryStore, childPath: string) => {
                store.consent.revoke(repositoryRoot);
                store.consent.grant(childPath);
            },
            purgeLabel: 'elepha',
            backupLabel: 'elepha',
        },
    ])('keeps both wizard labels unchanged for $decisions paths', async ({ configure, purgeLabel, backupLabel }) => {
        const { directory, db, store, childPath } = projectFixture();

        try {
            configure(store, childPath);
            await expect(purgeProjectLabel(store)).resolves.toBe(purgeLabel);
            await expect(backupProjectLabel(store)).resolves.toBe(backupLabel);
        } finally {
            db.close();
            rmSync(directory, { recursive: true, force: true });
        }
    });
});
