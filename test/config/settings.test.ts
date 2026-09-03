import { existsSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import { DEFAULT_MEMORY_CONFIG, readMemoryConfig } from '../../src/config/memory-config.js';
import { getSetting, listSettings, SETTING_KEYS, setSetting, unsetSetting } from '../../src/config/settings.js';

function configPath(): string {
    return path.join(mkdtempSync(path.join(tmpdir(), 'elepha-settings-')), 'config.json');
}

describe('settings', () => {
    it('persists update-check as a boolean and reports config as its source', () => {
        const file = configPath();

        setSetting('update-check', 'off', file);

        expect(JSON.parse(readFileSync(file, 'utf8'))).toEqual({ 'update-check': false });
        expect(getSetting('update-check', {}, file)).toEqual({ key: 'update-check', value: false, source: 'config' });
        expect(listSettings({}, file)).toEqual([
            { key: 'update-check', value: false, source: 'config' },
            { key: 'capture-claude-code', value: true, source: 'default' },
            { key: 'capture-codex', value: true, source: 'default' },
            { key: 'durable-capture', value: false, source: 'default' },
            { key: 'query-matching', value: 'strict', source: 'default' },
        ]);
    });

    it('defaults query-matching to strict and persists lax as a config value', () => {
        const file = configPath();

        expect(getSetting('query-matching', {}, file)).toEqual({
            key: 'query-matching',
            value: 'strict',
            source: 'default',
        });

        setSetting('query-matching', 'lax', file);

        expect(getSetting('query-matching', {}, file)).toEqual({
            key: 'query-matching',
            value: 'lax',
            source: 'config',
        });
        expect(JSON.parse(readFileSync(file, 'utf8'))).toEqual({ 'query-matching': 'lax' });
    });

    it('uses the environment as an explicit update-check override', () => {
        const file = configPath();
        writeFileSync(file, '{"update-check":true}\n');

        expect(getSetting('update-check', { ELEPHA_NO_UPDATE_CHECK: '1' }, file)).toEqual({
            key: 'update-check',
            value: false,
            source: 'env',
        });
    });

    it('keeps the environment override bound to update-check when setting keys are reordered', () => {
        const mutableSettingKeys = SETTING_KEYS as unknown as string[];
        mutableSettingKeys.reverse();

        try {
            expect(listSettings({ ELEPHA_NO_UPDATE_CHECK: '1' }, configPath())).toEqual([
                { key: 'query-matching', value: 'strict', source: 'default' },
                { key: 'durable-capture', value: false, source: 'default' },
                { key: 'capture-codex', value: true, source: 'default' },
                { key: 'capture-claude-code', value: true, source: 'default' },
                { key: 'update-check', value: false, source: 'env' },
            ]);
        } finally {
            mutableSettingKeys.reverse();
        }
    });

    it.each([
        ['capture-claude-code', false],
        ['capture-codex', true],
    ] as const)('does not apply the update-check environment override to %s', (key, configuredValue) => {
        const file = configPath();
        writeFileSync(file, `${JSON.stringify({ [key]: configuredValue })}\n`);

        expect(getSetting(key, { ELEPHA_NO_UPDATE_CHECK: '1' }, file)).toEqual({
            key,
            value: configuredValue,
            source: 'config',
        });
    });

    it.each(['capture-claude-code', 'capture-codex'] as const)(
        'preserves the default for %s when the update-check environment override is set',
        (key) => {
            const file = configPath();

            expect(getSetting(key, { ELEPHA_NO_UPDATE_CHECK: '1' }, file)).toEqual({
                key,
                value: true,
                source: 'default',
            });
        },
    );

    it('removes only update-check and returns to the default', () => {
        const file = configPath();
        writeFileSync(file, '{"memory":{"on_startup":"auto"},"update-check":false}\n');

        unsetSetting('update-check', file);

        expect(JSON.parse(readFileSync(file, 'utf8'))).toEqual({ memory: { on_startup: 'auto' } });
        expect(getSetting('update-check', {}, file)).toEqual({ key: 'update-check', value: true, source: 'default' });
    });

    it('does not create a file when unsetting an absent setting', () => {
        const file = configPath();

        unsetSetting('update-check', file);

        expect(existsSync(file)).toBe(false);
    });

    it.each([
        ['true', true],
        ['1', true],
        ['on', true],
        ['false', false],
        ['0', false],
        ['off', false],
    ])('accepts %s as %s for each boolean setting', (input, expected) => {
        for (const key of ['update-check', 'capture-claude-code', 'capture-codex', 'durable-capture'] as const) {
            const file = configPath();
            setSetting(key, input, file);
            expect(getSetting(key, {}, file).value).toBe(expected);
        }
    });

    it('defaults both capture tools to enabled and durable capture to disabled in settings and daemon memory config', () => {
        const file = configPath();

        expect(getSetting('capture-claude-code', {}, file).value).toBe(true);
        expect(getSetting('capture-codex', {}, file).value).toBe(true);
        expect(getSetting('durable-capture', {}, file).value).toBe(false);
        expect(DEFAULT_MEMORY_CONFIG.captureClaudeCode).toBe(true);
        expect(DEFAULT_MEMORY_CONFIG.captureCodex).toBe(true);
        expect(DEFAULT_MEMORY_CONFIG.durableCapture).toBe(false);
        expect(readMemoryConfig(file)).toEqual({ config: DEFAULT_MEMORY_CONFIG });
    });

    it('loads the durable capture setting into daemon memory config', () => {
        const file = configPath();
        writeFileSync(file, '{"durable-capture":true}\n');

        expect(readMemoryConfig(file)).toEqual({ config: { ...DEFAULT_MEMORY_CONFIG, durableCapture: true } });
    });

    it('rejects disabling both capture tools without changing the config', () => {
        const file = configPath();
        setSetting('capture-claude-code', 'off', file);
        const before = readFileSync(file, 'utf8');

        expect(() => setSetting('capture-codex', 'off', file)).toThrow('at least one capture tool must remain enabled');
        expect(readFileSync(file, 'utf8')).toBe(before);
    });

    it('rejects unknown keys and invalid values without writing a typo', () => {
        const file = configPath();

        expect(() => setSetting('auto-update', 'true', file)).toThrow(
            'unknown setting "auto-update"; valid keys: update-check, capture-claude-code, capture-codex, durable-capture, query-matching',
        );
        expect(() => setSetting('update-check', 'yes', file)).toThrow('update-check must be true, false, 1, 0, on, or off');
        expect(() => setSetting('query-matching', 'loose', file)).toThrow('query-matching must be strict or lax');
        expect(existsSync(file)).toBe(false);
    });
});
