import { describe, expect, it } from 'vitest';
import { synthesisStatusReport } from '../../src/cli/status.js';
import type { SummarizerCallLogEntry } from '../../src/summarizer/call-log.js';

function call(status: SummarizerCallLogEntry['status'], error: string | null = null): SummarizerCallLogEntry {
    return {
        timestamp: '2026-08-16T00:00:00.000Z',
        job: 'turn_extraction',
        latencyMs: 10,
        inputTokens: status === 'api_error' ? null : 10,
        cacheCreationInputTokens: 0,
        cacheReadInputTokens: 0,
        outputTokens: status === 'api_error' ? null : 5,
        attempt: 1,
        rateLimited: false,
        error,
        status,
    };
}

describe('synthesisStatusReport', () => {
    it('classifies capture-only and configured provider health', () => {
        const cases = [
            {
                provider: undefined,
                calls: [call('api_error', 'old failure')],
                healthy: true,
                verdicts: ['capture-only', 'no provider configured'],
            },
            {
                provider: 'Anthropic',
                calls: [],
                healthy: true,
                verdicts: ['Anthropic configured', 'no calls'],
            },
            {
                provider: 'Anthropic',
                calls: [call('ok'), call('api_error', 'bad key'), call('api_error', 'bad key')],
                healthy: false,
                verdicts: ['Anthropic configured', '1/3 calls ok', 'last failure', 'bad key'],
            },
        ];

        for (const { provider, calls, healthy, verdicts } of cases) {
            const report = synthesisStatusReport(provider, calls);

            expect(report.healthy).toBe(healthy);
            for (const verdict of verdicts) {
                expect(report.line).toContain(verdict);
            }
        }
    });
});
