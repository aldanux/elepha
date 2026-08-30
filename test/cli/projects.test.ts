import { Command } from 'commander';
import { describe, expect, it, vi } from 'vitest';
import { registerProjects } from '../../src/cli/commands/projects.js';
import { openDb } from '../../src/storage/db.js';
import { MemoryStore } from '../../src/storage/memory-store.js';
import { withGrantableTestDir } from '../helpers/tmp.js';

describe('elepha projects', () => {
    it('lists approved roots without sessions while omitting pending and denied roots', async () => {
        const approved = withGrantableTestDir('projects-approved-');
        const pending = withGrantableTestDir('projects-pending-');
        const denied = withGrantableTestDir('projects-denied-');
        const dbPath = `${withGrantableTestDir('projects-db-')}/elepha.db`;
        const db = openDb(dbPath);
        const store = new MemoryStore(db);
        store.consent.grant(approved);
        store.consent.recordPending(pending);
        store.consent.revoke(denied);
        db.close();
        vi.stubEnv('ELEPHA_DB_PATH', dbPath);
        const output: string[] = [];
        const log = vi.spyOn(console, 'log').mockImplementation((message) => output.push(String(message)));
        const program = new Command();
        registerProjects(program);

        try {
            await program.parseAsync(['node', 'elepha', 'projects']);
            expect(output).toEqual([`${approved} (no sessions yet)`]);
        } finally {
            log.mockRestore();
            vi.unstubAllEnvs();
        }
    });
});
