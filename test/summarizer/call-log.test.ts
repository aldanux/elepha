import { existsSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import { SUMMARIZER_LOG_RETENTION_DAYS } from '../../src/config/constants.js';
import { SummarizerCallLog, type SummarizerCallLogEntry } from '../../src/summarizer/call-log.js';

const TODAY = '2026-08-29';

function entry(timestamp: string): SummarizerCallLogEntry {
    return {
        timestamp,
        job: 'turn_extraction',
        latencyMs: 10,
        inputTokens: 1,
        cacheCreationInputTokens: 0,
        cacheReadInputTokens: 0,
        outputTokens: 1,
        attempt: 1,
        rateLimited: false,
        error: null,
        status: 'ok',
    };
}

function writeEntry(directory: string, filename: string, timestamp: string): void {
    writeFileSync(path.join(directory, filename), `${JSON.stringify(entry(timestamp))}\n`);
}

describe('SummarizerCallLog', () => {
    it('opens only dated files that can contain entries since the threshold, while still reading malformed names', () => {
        const directory = mkdtempSync(path.join(tmpdir(), 'elepha-call-log-read-'));
        const readPaths: string[] = [];
        writeEntry(directory, 'summarizer-2026-07-01.log', '2026-07-01T12:00:00.000Z');
        writeEntry(directory, 'summarizer-2026-08-28.log', '2026-08-28T11:00:00.000Z');
        writeEntry(directory, 'summarizer-2026-08-29.log', '2026-08-29T13:00:00.000Z');
        writeEntry(directory, 'summarizer-not-a-date.log', '2026-08-29T14:00:00.000Z');
        writeEntry(directory, 'other-2026-08-29.log', '2026-08-29T15:00:00.000Z');

        const entries = new SummarizerCallLog(directory, {
            today: () => TODAY,
            readText: (file) => {
                readPaths.push(file);
                return readFileSync(file, 'utf8');
            },
        }).readEntriesSince('2026-08-28T12:00:00.000Z');

        expect(new Set(readPaths.map((file) => path.basename(file)))).toEqual(
            new Set(['summarizer-2026-08-28.log', 'summarizer-2026-08-29.log', 'summarizer-not-a-date.log']),
        );
        expect(entries.map((item) => item.timestamp)).toEqual(['2026-08-29T13:00:00.000Z', '2026-08-29T14:00:00.000Z']);
    });

    it('removes expired dated files on write and retains files inside the retention window', () => {
        const directory = mkdtempSync(path.join(tmpdir(), 'elepha-call-log-retention-'));
        const expiredFile = path.join(directory, 'summarizer-2026-07-29.log');
        const retainedFile = path.join(directory, 'summarizer-2026-07-30.log');
        writeFileSync(expiredFile, 'expired\n');
        writeFileSync(retainedFile, 'retained\n');

        new SummarizerCallLog(directory, { today: () => TODAY }).append(entry(`${TODAY}T12:00:00.000Z`));

        expect(SUMMARIZER_LOG_RETENTION_DAYS).toBe(30);
        expect(existsSync(expiredFile)).toBe(false);
        expect(existsSync(retainedFile)).toBe(true);
    });

    it('keeps a successful append successful when retention cleanup fails', () => {
        const directory = mkdtempSync(path.join(tmpdir(), 'elepha-call-log-retention-failure-'));
        const expiredFile = path.join(directory, 'summarizer-2026-07-29.log');
        writeFileSync(expiredFile, 'expired\n');

        expect(() =>
            new SummarizerCallLog(directory, {
                today: () => TODAY,
                removeFile: () => {
                    throw new Error('simulated retention failure');
                },
            }).append(entry(`${TODAY}T12:00:00.000Z`)),
        ).not.toThrow();
        expect(existsSync(expiredFile)).toBe(true);
    });
});
