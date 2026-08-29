import { closeSync, openSync, statSync, writeFileSync, writeSync } from 'node:fs';
import path from 'node:path';
import { describe, expect, it, vi } from 'vitest';
import { JsonlTurnAdapter, malformedCompleteRecordsDiagnostic, type TurnBuilderState, textValues } from '../../src/adapters/base.js';
import { MAX_JSON_VALUE_DEPTH, MAX_JSON_VALUE_NODES, MAX_TRANSCRIPT_RECORD_BYTES } from '../../src/config/constants.js';
import type { ToolName } from '../../src/types/index.js';
import { withTempDir } from '../helpers/tmp.js';

interface TestLine {
    type?: unknown;
    cwd?: unknown;
    timestamp?: unknown;
    text?: unknown;
}

class CountingAdapter extends JsonlTurnAdapter {
    readonly tool: ToolName = 'claude-code';
    readonly watchGlobs = ['*.jsonl'];
    classifiedLines = 0;

    matches(): boolean {
        return true;
    }

    nativeSessionId(filePath: string): string {
        return path.basename(filePath, '.jsonl');
    }

    async classifyEmptySession() {
        return undefined;
    }

    protected classify(line: unknown): 'boundary' | 'content' | 'skip' {
        this.classifiedLines++;
        const type = (line as TestLine).type;
        return type === 'user' ? 'boundary' : type === 'assistant' ? 'content' : 'skip';
    }

    protected cwdOf(line: unknown): string | undefined {
        const cwd = (line as TestLine).cwd;
        return typeof cwd === 'string' ? cwd : undefined;
    }

    protected timestampOf(line: unknown): string | undefined {
        const timestamp = (line as TestLine).timestamp;
        return typeof timestamp === 'string' ? timestamp : undefined;
    }

    protected fold(state: TurnBuilderState, line: unknown): void {
        const value = line as TestLine;
        if (value.type === 'user' && typeof value.text === 'string') {
            state.userMessageParts.push(value.text);
        }
        if (value.type === 'assistant' && typeof value.text === 'string') {
            state.assistantTextParts.push(value.text);
        }
    }
}

function turnLines(cwd: string, index: number): string {
    const startedAt = new Date(Date.UTC(2026, 7, 26, 0, 0, index * 2)).toISOString();
    const endedAt = new Date(Date.UTC(2026, 7, 26, 0, 0, index * 2 + 1)).toISOString();
    return `${JSON.stringify({ type: 'user', cwd, timestamp: startedAt, text: `request ${index}` })}\n${JSON.stringify({
        type: 'assistant',
        cwd,
        timestamp: endedAt,
        text: `response ${index}`,
    })}\n`;
}

describe('bounded transcript value parsing', () => {
    it('traverses deeply nested values iteratively and stops at the depth limit', () => {
        let deeplyNested: unknown = 'too deep';
        for (let depth = 0; depth < MAX_JSON_VALUE_DEPTH + 10_000; depth++) {
            deeplyNested = [deeplyNested];
        }

        expect(textValues({ deeplyNested, shallow: 'kept' })).toEqual(['kept']);
    });

    it('stops collecting after the JSON value node budget', () => {
        const values: unknown[] = Array.from({ length: MAX_JSON_VALUE_NODES }, () => 0);
        values.push('past the node budget');

        expect(textValues(values)).toEqual([]);
    });

    it('parses a valid multi-record transcript larger than the single-record ceiling without changing its turns', async () => {
        const directory = withTempDir('elepha-base-bounds-');
        const filePath = path.join(directory, 'large-valid.jsonl');
        const cwd = '/Users/test/large-valid-project';
        const filler = Buffer.from(`${JSON.stringify({ type: 'metadata', padding: 'x'.repeat(64 * 1024) })}\n`);
        const fillerLines = Math.ceil((MAX_TRANSCRIPT_RECORD_BYTES + 1) / filler.length);
        const handle = openSync(filePath, 'w');
        try {
            writeSync(handle, turnLines(cwd, 0));
            for (let index = 0; index < fillerLines; index++) {
                writeSync(handle, filler);
            }
            writeSync(handle, turnLines(cwd, 1));
        } finally {
            closeSync(handle);
        }

        expect(statSync(filePath).size).toBeGreaterThan(MAX_TRANSCRIPT_RECORD_BYTES);
        const adapter = new CountingAdapter();
        const turns = [];
        for await (const turn of adapter.parseTurns(filePath, undefined, { closeTrailingOnIdle: true })) {
            turns.push(turn);
        }

        expect(turns.map(({ userMessage, assistantText }) => ({ userMessage, assistantText }))).toEqual([
            { userMessage: 'request 0', assistantText: 'response 0' },
            { userMessage: 'request 1', assistantText: 'response 1' },
        ]);
        expect(adapter.classifiedLines).toBe(fillerLines + 4);
    }, 15_000);

    it('reports malformed complete records once while preserving valid turns and cursor advancement', async () => {
        const directory = withTempDir('elepha-base-malformed-');
        const filePath = path.join(directory, 'malformed.jsonl');
        const cwd = '/Users/test/malformed-project';
        const malformedRecords = '{not json}\n{"also":"truncated"\n';
        const firstTurn = turnLines(cwd, 0);
        writeFileSync(filePath, `${firstTurn}${malformedRecords}${turnLines(cwd, 1)}`);
        const warn = vi.fn();

        const turns = [];
        for await (const turn of new CountingAdapter(warn).parseTurns(filePath, undefined, { closeTrailingOnIdle: true })) {
            turns.push(turn);
        }

        expect(warn).toHaveBeenCalledExactlyOnceWith(malformedCompleteRecordsDiagnostic(filePath, 2));
        expect(turns.map(({ userMessage, assistantText }) => ({ userMessage, assistantText }))).toEqual([
            { userMessage: 'request 0', assistantText: 'response 0' },
            { userMessage: 'request 1', assistantText: 'response 1' },
        ]);
        expect(Number(turns[0]?.cursor.split('|')[0])).toBe(Buffer.byteLength(`${firstTurn}${malformedRecords}`));
    });

    it('does not count an incomplete tail as a malformed complete record', async () => {
        const directory = withTempDir('elepha-base-partial-tail-');
        const filePath = path.join(directory, 'partial-tail.jsonl');
        const cwd = '/Users/test/partial-tail-project';
        writeFileSync(filePath, `${turnLines(cwd, 0)}{malformed but complete}\n{"type":"assistant"`);
        const warn = vi.fn();

        for await (const _turn of new CountingAdapter(warn).parseTurns(filePath, undefined, { closeTrailingOnIdle: true })) {
            // Drain the scan so its file-level diagnostic is emitted.
        }

        expect(warn).toHaveBeenCalledExactlyOnceWith(malformedCompleteRecordsDiagnostic(filePath, 1));
    });

    it('does not report a clean file or an incomplete-only tail', async () => {
        const directory = withTempDir('elepha-base-clean-');
        const cwd = '/Users/test/clean-project';
        const cleanFile = path.join(directory, 'clean.jsonl');
        const partialFile = path.join(directory, 'partial.jsonl');
        writeFileSync(cleanFile, turnLines(cwd, 0));
        writeFileSync(partialFile, `${turnLines(cwd, 0)}{"type":"assistant"`);
        const warn = vi.fn();
        const adapter = new CountingAdapter(warn);

        for await (const _turn of adapter.parseTurns(cleanFile, undefined, { closeTrailingOnIdle: true })) {
            // Drain the scan.
        }
        for await (const _turn of adapter.parseTurns(partialFile, undefined, { closeTrailingOnIdle: true })) {
            // Drain the scan.
        }

        expect(warn).not.toHaveBeenCalled();
    });
});
