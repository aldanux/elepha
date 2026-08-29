import path from 'node:path';
import { PassThrough } from 'node:stream';
import { describe, expect, it, vi } from 'vitest';
import { type ImportPrompts, runImportWizard } from '../../src/cli/import-wizard.js';
import { ELEPHA_TAGLINE, ELEPHA_WORDMARK } from '../../src/config/constants.js';

const CANCELLED = Symbol('cancelled');

function ttyStream(): PassThrough {
    const stream = new PassThrough();
    Object.defineProperty(stream, 'isTTY', { value: true });
    return stream;
}

function fakePrompts(
    selections: Array<string | typeof CANCELLED>,
    confirmation: boolean | typeof CANCELLED,
    events: string[] = [],
): ImportPrompts {
    return {
        intro: (title) => events.push(`intro:${title}`),
        select: vi.fn(async () => selections.shift() ?? CANCELLED),
        confirm: vi.fn(async () => confirmation),
        isCancel: (value) => value === CANCELLED,
        cancel: vi.fn(),
        outro: vi.fn(),
    };
}

describe('elepha import wizard', () => {
    it.each([
        ['safe', false],
        ['overwrite', true],
    ] as const)('imports the selected backup in %s mode through the fakeable confirmation seam', async (mode, overwrite) => {
        const backup = path.join('/tmp', `elepha-${mode}.db`);
        const events: string[] = [];
        const prompts = fakePrompts([backup, mode], true, events);
        const output = ttyStream();
        let rendered = '';
        output.on('data', (chunk: Buffer) => {
            rendered += chunk.toString('utf8');
            events.push('tagline');
        });
        const importBackup = vi.fn(async (_file: string, _overwrite: boolean, confirm?: () => Promise<boolean>) => ({
            cancelled: confirm ? !(await confirm()) : false,
        }));

        await expect(
            runImportWizard({
                input: ttyStream(),
                output,
                backups: [backup],
                prompts,
                importBackup,
            }),
        ).resolves.toBe(0);

        expect(importBackup).toHaveBeenCalledWith(backup, overwrite, expect.any(Function));
        expect(prompts.confirm).toHaveBeenCalledWith(expect.objectContaining({ initialValue: false }));
        expect(prompts.outro).toHaveBeenCalledWith('Import complete.');
        expect(rendered.split(ELEPHA_TAGLINE)).toHaveLength(2);
        expect(rendered).not.toContain(ELEPHA_WORDMARK);
        expect(events.slice(0, 2)).toEqual(['tagline', 'intro:Import elepha memory']);
    });

    it('cancels before the import operation mutates anything', async () => {
        const backup = path.join('/tmp', 'elepha-full.db');
        const cases = [
            { selections: [CANCELLED], confirmation: true, invokesOperation: false },
            { selections: [backup, 'safe'], confirmation: false, invokesOperation: true },
        ] as const;

        for (const { selections, confirmation, invokesOperation } of cases) {
            const prompts = fakePrompts([...selections], confirmation);
            let mutations = 0;
            const importBackup = vi.fn(async (_file: string, _overwrite: boolean, confirm?: () => Promise<boolean>) => {
                if (confirm && !(await confirm())) return { cancelled: true };
                mutations += 1;
                return { cancelled: false };
            });

            await expect(
                runImportWizard({
                    input: ttyStream(),
                    output: ttyStream(),
                    backups: [backup],
                    prompts,
                    importBackup,
                }),
            ).resolves.toBe(0);

            expect(importBackup).toHaveBeenCalledTimes(invokesOperation ? 1 : 0);
            expect(mutations).toBe(0);
            expect(prompts.cancel).toHaveBeenCalledWith('Operation cancelled. No changes were made.');
            expect(prompts.outro).not.toHaveBeenCalled();
        }
    });
});
