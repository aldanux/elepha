import { mkdtempSync, readFileSync, statSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { HOOK_LOG_MAX_BYTES } from '../../src/config/constants.js';
import { appendHookLog } from '../../src/hooks/hook-log.js';

describe('appendHookLog', () => {
    const priorHookLogPath = process.env.ELEPHA_HOOK_LOG_PATH;

    afterEach(() => {
        if (priorHookLogPath === undefined) {
            delete process.env.ELEPHA_HOOK_LOG_PATH;
        } else {
            process.env.ELEPHA_HOOK_LOG_PATH = priorHookLogPath;
        }
    });

    it('drops the oldest content past the byte ceiling while retaining the newest content', () => {
        const directory = mkdtempSync(path.join(tmpdir(), 'elepha-hook-log-growth-'));
        const logPath = path.join(directory, 'hook.log');
        process.env.ELEPHA_HOOK_LOG_PATH = logPath;
        const fillerLine = 'x'.repeat(510);
        const oversized = `oldest diagnostic\n${`${fillerLine}\n`.repeat(Math.ceil(HOOK_LOG_MAX_BYTES / 511))}newest diagnostic\n`;
        writeFileSync(logPath, oversized);

        appendHookLog('appended diagnostic');

        const retained = readFileSync(logPath, 'utf8');
        expect(statSync(logPath).size).toBeLessThanOrEqual(HOOK_LOG_MAX_BYTES);
        expect(retained).not.toContain('oldest diagnostic');
        expect(retained).toContain('newest diagnostic');
        expect(retained).toContain('appended diagnostic');
    });

    it('keeps the appended line when rotation fails', () => {
        const directory = mkdtempSync(path.join(tmpdir(), 'elepha-hook-log-rotation-failure-'));
        const logPath = path.join(directory, 'hook.log');
        process.env.ELEPHA_HOOK_LOG_PATH = logPath;
        writeFileSync(logPath, `${'x'.repeat(HOOK_LOG_MAX_BYTES)}\n`);

        expect(() =>
            appendHookLog('survives failed rotation', {
                replaceFile: () => {
                    throw new Error('simulated rotation failure');
                },
            }),
        ).not.toThrow();

        expect(readFileSync(logPath, 'utf8')).toContain('survives failed rotation');
        expect(statSync(logPath).size).toBeGreaterThan(HOOK_LOG_MAX_BYTES);
    });
});
