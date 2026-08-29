import { readFileSync } from 'node:fs';
import path from 'node:path';
import { PassThrough } from 'node:stream';
import { describe, expect, it, vi } from 'vitest';
import { type RestorePrompts, runRestoreWizard } from '../../src/cli/restore-wizard.js';
import { ELEPHA_TAGLINE, ELEPHA_WORDMARK } from '../../src/config/constants.js';
import { createTestDb } from '../helpers/db.js';

const CANCELLED = Symbol('cancelled');

function ttyStream(): PassThrough {
    const stream = new PassThrough();
    Object.defineProperty(stream, 'isTTY', { value: true });
    return stream;
}

function fakePrompts(selections: Array<string | symbol>, confirmation: boolean | typeof CANCELLED, events: string[] = []): RestorePrompts {
    return {
        intro: (title) => events.push(`intro:${title}`),
        select: vi.fn(async () => selections.shift() ?? CANCELLED),
        text: vi.fn(async () => selections.shift() ?? CANCELLED),
        confirm: vi.fn(async () => confirmation),
        isCancel: (value) => value === CANCELLED,
        cancel: vi.fn(),
        outro: vi.fn(),
    };
}

describe('elepha restore wizard', () => {
    it('lists full backups newest-first with metadata and restores the selected file', async () => {
        const fixture = createTestDb('elepha-restore-wizard-');
        const newest = path.join(fixture.directory, 'elepha-full-newest.db');
        const older = path.join(fixture.directory, 'elepha-full-older.db');
        const events: string[] = [];
        const prompts = fakePrompts([newest], true, events);
        const output = ttyStream();
        let rendered = '';
        output.on('data', (chunk: Buffer) => {
            rendered += chunk.toString('utf8');
            events.push('tagline');
        });
        const restore = vi.fn(async (_file: string, confirm: () => Promise<boolean>) => ({ cancelled: !(await confirm()) }));

        await expect(
            runRestoreWizard({
                input: ttyStream(),
                output,
                backups: [
                    { path: older, mtimeMs: Date.UTC(2026, 7, 24, 4), bytes: 1_024 },
                    { path: newest, mtimeMs: Date.UTC(2026, 7, 25, 4), bytes: 2_048 },
                ],
                prompts,
                restore,
            }),
        ).resolves.toBe(0);
        expect(prompts.select).toHaveBeenCalledWith({
            message: 'Which full elepha backup should be restored?',
            options: [
                expect.objectContaining({ value: newest, label: path.basename(newest), hint: expect.stringContaining('2 KB') }),
                expect.objectContaining({ value: older, label: path.basename(older), hint: expect.stringContaining('1 KB') }),
                expect.objectContaining({ label: 'Enter a path manually…' }),
            ],
        });
        expect(prompts.text).not.toHaveBeenCalled();
        expect(restore).toHaveBeenCalledWith(newest, expect.any(Function));
        expect(prompts.confirm).toHaveBeenCalledWith(
            expect.objectContaining({ message: expect.stringContaining('Replace the current elepha database') }),
        );
        expect(prompts.outro).toHaveBeenCalledWith('Restore complete.');
        expect(rendered.split(ELEPHA_TAGLINE)).toHaveLength(2);
        expect(rendered).not.toContain(ELEPHA_WORDMARK);
        expect(events.slice(0, 2)).toEqual(['tagline', 'intro:Restore elepha memory']);
    });

    it('falls back to the path prompt when manual entry is selected', async () => {
        const backup = path.join('/tmp', 'manual-full.db');
        const prompts = fakePrompts([], true);
        vi.mocked(prompts.select).mockImplementationOnce(async ({ options }) => options.at(-1)?.value ?? CANCELLED);
        vi.mocked(prompts.text).mockResolvedValueOnce(`  ${backup}  `);
        const restore = vi.fn(async (_file: string, confirm: () => Promise<boolean>) => ({ cancelled: !(await confirm()) }));

        await expect(
            runRestoreWizard({
                input: ttyStream(),
                output: ttyStream(),
                backups: [{ path: '/tmp/elepha-full-found.db', mtimeMs: 1, bytes: 1 }],
                prompts,
                restore,
            }),
        ).resolves.toBe(0);

        expect(prompts.text).toHaveBeenCalledOnce();
        expect(restore).toHaveBeenCalledWith(backup, expect.any(Function));
    });

    it('uses the path prompt directly when no full backups are available', async () => {
        const backup = path.join('/tmp', 'manual-full.db');
        const prompts = fakePrompts([backup], true);
        const restore = vi.fn(async (_file: string, confirm: () => Promise<boolean>) => ({ cancelled: !(await confirm()) }));

        await expect(runRestoreWizard({ input: ttyStream(), output: ttyStream(), backups: [], prompts, restore })).resolves.toBe(0);

        expect(prompts.select).not.toHaveBeenCalled();
        expect(prompts.text).toHaveBeenCalledOnce();
        expect(restore).toHaveBeenCalledWith(backup, expect.any(Function));
    });

    it('cancels before the shared restore operation mutates the database', async () => {
        const fixture = createTestDb('elepha-restore-wizard-');
        const dbBytes = readFileSync(fixture.dbPath);
        const backup = path.join(fixture.directory, 'full.db');
        const cases = [
            { selections: [CANCELLED], confirmation: true, invokesOperation: false },
            { selections: [backup], confirmation: false, invokesOperation: true },
        ] as const;

        for (const { selections, confirmation, invokesOperation } of cases) {
            const prompts = fakePrompts([...selections], confirmation);
            let mutations = 0;
            const restore = vi.fn(async (_file: string, confirm: () => Promise<boolean>) => {
                if (!(await confirm())) return { cancelled: true };
                mutations += 1;
                return { cancelled: false };
            });

            await expect(runRestoreWizard({ input: ttyStream(), output: ttyStream(), backups: [], prompts, restore })).resolves.toBe(0);

            expect(restore).toHaveBeenCalledTimes(invokesOperation ? 1 : 0);
            expect(mutations).toBe(0);
            expect(readFileSync(fixture.dbPath)).toEqual(dbBytes);
            expect(prompts.cancel).toHaveBeenCalledWith('Operation cancelled. No changes were made.');
            expect(prompts.outro).not.toHaveBeenCalled();
        }
    });
});
