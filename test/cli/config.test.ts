import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { PassThrough } from 'node:stream';
import { Command } from 'commander';
import { describe, expect, it, vi } from 'vitest';
import { registerConfig } from '../../src/cli/commands/config.js';
import { type ConfigPrompts, runConfigWizard } from '../../src/cli/config-wizard.js';
import { ELEPHA_TAGLINE, ELEPHA_WORDMARK } from '../../src/config/constants.js';

const CANCELLED = Symbol('cancelled');

function ttyStream(): PassThrough {
    const stream = new PassThrough();
    Object.defineProperty(stream, 'isTTY', { value: true });
    return stream;
}

function fakePrompts(selections: Array<string | typeof CANCELLED>): { prompts: ConfigPrompts; events: string[] } {
    const events: string[] = [];
    const prompts: ConfigPrompts = {
        intro: (title) => events.push(`intro:${title}`),
        note: (message, title) => events.push(`note:${title ?? ''}:${message}`),
        select: vi.fn(async (options) => {
            events.push(
                `select:${options.message}:${options.options
                    .map((option: { label: string; hint?: string }) =>
                        option.hint === undefined ? option.label : `${option.label} [hint: ${option.hint}]`,
                    )
                    .join(',')}`,
            );
            return selections.shift() ?? CANCELLED;
        }),
        isCancel: (value) => value === CANCELLED,
        cancel: (message) => events.push(`cancel:${message}`),
        outro: (message) => events.push(`outro:${message}`),
    };
    return { prompts, events };
}

function configProgram(): Command {
    const program = new Command();
    registerConfig(program);
    return program;
}

describe('elepha config', () => {
    it('keeps list as the settings view and uses it as the non-interactive bare fallback', async () => {
        const output: string[] = [];
        const log = vi.spyOn(console, 'log').mockImplementation((message) => output.push(String(message)));
        const expected = [
            'update-check = On (default)',
            'capture-claude-code = On (default)',
            'capture-codex = On (default)',
            'durable-capture = Off (default)',
            'query-matching = strict (default)',
        ];
        const program = configProgram();

        try {
            const config = program.commands.find((command) => command.name() === 'config');

            expect(config?.commands.some((command) => command.name() === 'list')).toBe(true);
            await expect(program.parseAsync(['node', 'elepha', 'config', 'list'])).resolves.toBe(program);
            expect(output).toEqual(expected);

            output.length = 0;
            await expect(configProgram().parseAsync(['node', 'elepha', 'config'])).resolves.toBeInstanceOf(Command);
            expect(output).toEqual(expected);
        } finally {
            log.mockRestore();
        }
    });

    it('uses the displayed value vocabulary for get, set, and unset', async () => {
        const directory = mkdtempSync(path.join(tmpdir(), 'elepha-config-commands-'));
        const priorElephaHome = process.env.ELEPHA_HOME;
        const priorNoUpdateCheck = process.env.ELEPHA_NO_UPDATE_CHECK;
        const output: string[] = [];
        const log = vi.spyOn(console, 'log').mockImplementation((message) => output.push(String(message)));
        const run = async (...args: string[]): Promise<string[]> => {
            output.length = 0;
            await configProgram().parseAsync(['node', 'elepha', 'config', ...args]);
            return [...output];
        };
        process.env.ELEPHA_HOME = directory;
        delete process.env.ELEPHA_NO_UPDATE_CHECK;

        try {
            expect(await run('set', 'update-check', 'off')).toEqual(['update-check set to Off']);
            expect(await run('list')).toEqual([
                'update-check = Off',
                'capture-claude-code = On (default)',
                'capture-codex = On (default)',
                'durable-capture = Off (default)',
                'query-matching = strict (default)',
            ]);
            const booleanValue = await run('get', 'update-check');
            expect(booleanValue).toEqual(['Off']);
            expect(await run('set', 'update-check', booleanValue[0]!)).toEqual(['update-check set to Off']);
            expect(await run('unset', 'update-check')).toEqual(['update-check unset; effective value: On']);

            expect(await run('set', 'query-matching', 'lax')).toEqual(['query-matching set to lax']);
            expect(await run('list')).toEqual([
                'update-check = On (default)',
                'capture-claude-code = On (default)',
                'capture-codex = On (default)',
                'durable-capture = Off (default)',
                'query-matching = lax',
            ]);
            const enumValue = await run('get', 'query-matching');
            expect(enumValue).toEqual(['lax']);
            expect(await run('set', 'query-matching', enumValue[0]!)).toEqual(['query-matching set to lax']);
            expect(await run('unset', 'query-matching')).toEqual(['query-matching unset; effective value: strict']);
        } finally {
            if (priorElephaHome === undefined) delete process.env.ELEPHA_HOME;
            else process.env.ELEPHA_HOME = priorElephaHome;
            if (priorNoUpdateCheck === undefined) delete process.env.ELEPHA_NO_UPDATE_CHECK;
            else process.env.ELEPHA_NO_UPDATE_CHECK = priorNoUpdateCheck;
            log.mockRestore();
            rmSync(directory, { recursive: true, force: true });
        }
    });

    it('lists settings, applies a change, and surfaces the last-capture refusal without writing', async () => {
        const directory = mkdtempSync(path.join(tmpdir(), 'elepha-config-wizard-'));
        const configPath = path.join(directory, 'config.json');
        const output = ttyStream();
        let rendered = '';
        output.on('data', (chunk: Buffer) => {
            rendered += chunk.toString('utf8');
        });

        try {
            const applied = fakePrompts(['capture-claude-code', 'off']);
            await expect(runConfigWizard({ output, prompts: applied.prompts, configPath, environment: {} })).resolves.toBe(0);

            expect(applied.events[1]).toBe(
                'select:Which setting should elepha change?:update-check = On (default),capture-claude-code = On (default),capture-codex = On (default),durable-capture = Off (default),query-matching = strict (default)',
            );
            expect(applied.events[2]).toBe('select:Which value should elepha use?:On (default),Off');
            expect(JSON.parse(readFileSync(configPath, 'utf8'))).toEqual({ 'capture-claude-code': false });
            expect(applied.events).toContain('outro:capture-claude-code set to Off.');
            expect(rendered).toContain(ELEPHA_TAGLINE);
            expect(rendered).not.toContain(ELEPHA_WORDMARK);

            const overridden = fakePrompts(['update-check', CANCELLED]);
            await expect(
                runConfigWizard({
                    output,
                    prompts: overridden.prompts,
                    configPath,
                    environment: { ELEPHA_NO_UPDATE_CHECK: '1' },
                }),
            ).resolves.toBe(0);

            expect(overridden.events[1]).toBe(
                'select:Which setting should elepha change?:update-check = Off (env),capture-claude-code = Off,capture-codex = On (default),durable-capture = Off (default),query-matching = strict (default)',
            );
            expect(overridden.events[2]).toBe(
                'note:Environment override:ELEPHA_NO_UPDATE_CHECK currently overrides this setting for this run. Your config preference will still be saved.',
            );
            expect(overridden.events[3]).toBe('select:Which value should elepha use?:On (default),Off');

            const before = readFileSync(configPath, 'utf8');
            const refused = fakePrompts(['capture-codex', 'off', CANCELLED]);
            await expect(runConfigWizard({ output, prompts: refused.prompts, configPath, environment: {} })).resolves.toBe(0);

            expect(refused.events).toContain('note:Setting unchanged:at least one capture tool must remain enabled');
            expect(refused.events).toContain('cancel:Operation cancelled. No changes were made.');
            expect(readFileSync(configPath, 'utf8')).toBe(before);

            const queryMatching = fakePrompts(['query-matching', 'lax']);
            await expect(runConfigWizard({ output, prompts: queryMatching.prompts, configPath, environment: {} })).resolves.toBe(0);

            expect(queryMatching.events[2]).toBe('select:Which value should elepha use?:strict (default),lax');
            expect(JSON.parse(readFileSync(configPath, 'utf8'))).toEqual({
                'capture-claude-code': false,
                'query-matching': 'lax',
            });
            expect(queryMatching.events).toContain('outro:query-matching set to lax.');

            const queryDefault = fakePrompts(['query-matching', 'strict']);
            await expect(runConfigWizard({ output, prompts: queryDefault.prompts, configPath, environment: {} })).resolves.toBe(0);

            expect(queryDefault.events[2]).toBe('select:Which value should elepha use?:strict (default),lax');
            expect(JSON.parse(readFileSync(configPath, 'utf8'))).toEqual({ 'capture-claude-code': false });
            expect(queryDefault.events).toContain('outro:query-matching returned to its default.');
        } finally {
            rmSync(directory, { recursive: true, force: true });
        }
    });
});
