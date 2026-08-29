import { describe, expect, it } from 'vitest';
import { isRefusedProjectRoot } from '../../src/config/paths.js';
import { HaikuSummarizationProvider } from '../../src/summarizer/haiku-provider.js';
import { HaikuRollupProvider } from '../../src/summarizer/rollup-provider.js';

interface FakeCall {
    maxTokens: number;
    stopReason: string;
    text: string;
}

/** Replaces the SDK client with a scripted sequence, recording the max_tokens of each request. */
function scriptClient(provider: object, script: FakeCall[]): number[] {
    const seen: number[] = [];
    let i = 0;
    // biome-ignore lint/suspicious/noExplicitAny: reaching into the private client is the point of the harness
    (provider as any).client = {
        messages: {
            create: async (req: { max_tokens: number }) => {
                seen.push(req.max_tokens);
                const step = script[Math.min(i++, script.length - 1)]!;
                return {
                    content: [{ type: 'text', text: step.text }],
                    stop_reason: step.stopReason,
                    usage: { input_tokens: 100, output_tokens: step.maxTokens },
                };
            },
        },
    };
    // biome-ignore lint/suspicious/noExplicitAny: silence the on-disk call log in tests
    (provider as any).callLog = { append: () => {} };
    return seen;
}

const VALID_TURN = JSON.stringify({ decisions: ['chose X'], pending_items: [] });
const VALID_ROLLUP = JSON.stringify({
    title: 'T',
    summary: 'S',
    decisions: [{ what: 'w', why: 'y' }],
    pending_items: [],
});

describe('turn summarizer truncation handling', () => {
    // The bug: a truncated response was retried at the SAME ceiling, so it
    // risked the same truncation and the extraction was lost.
    it('retries a truncated response at a larger budget, not the same one', async () => {
        const provider = new HaikuSummarizationProvider({ apiKey: 'test' });
        const budgets = scriptClient(provider, [
            { maxTokens: 1024, stopReason: 'max_tokens', text: '{"decisions": ["half of a' },
            { maxTokens: 2000, stopReason: 'end_turn', text: VALID_TURN },
        ]);

        const out = await provider.summarize({ userMessage: 'u', assistantText: 'a' });

        expect(budgets).toHaveLength(2);
        expect(budgets[1]).toBeGreaterThan(budgets[0]!);
        expect(out.status).toBe('ok');
        expect(out.decisions).toEqual([{ what: 'chose X', why: null }]);
    });

    it('sends the repair prompt (not a bigger budget request) when output was complete but malformed', async () => {
        const provider = new HaikuSummarizationProvider({ apiKey: 'test' });
        const budgets = scriptClient(provider, [
            { maxTokens: 40, stopReason: 'end_turn', text: 'I cannot produce JSON for this turn.' },
            { maxTokens: 60, stopReason: 'end_turn', text: VALID_ROLLUP },
        ]);

        await provider.summarize({ userMessage: 'u', assistantText: 'a' });
        // Two calls happened; the second is the repair pass, still with headroom.
        expect(budgets).toHaveLength(2);
    });

    it('does not retry at all when the first attempt parses', async () => {
        const provider = new HaikuSummarizationProvider({ apiKey: 'test' });
        const budgets = scriptClient(provider, [{ maxTokens: 50, stopReason: 'end_turn', text: VALID_TURN }]);
        const out = await provider.summarize({ userMessage: 'u', assistantText: 'a' });
        expect(budgets).toHaveLength(1);
        expect(out.status).toBe('ok');
    });
});

describe('rollup truncation handling', () => {
    // Rollups previously had NO retry path at all - a truncated rollup was
    // simply discarded.
    it('retries a truncated rollup at a larger budget', async () => {
        const provider = new HaikuRollupProvider({ apiKey: 'test' });
        const budgets = scriptClient(provider, [
            { maxTokens: 4096, stopReason: 'max_tokens', text: '{"title": "T", "decisions": [{"what": "half' },
            { maxTokens: 5000, stopReason: 'end_turn', text: VALID_ROLLUP },
        ]);

        const result = await provider.rollup([
            { turnIndex: 0, startedAt: '2026-08-01T00:00:00.000Z', decisions: ['d'], pendingItems: [], filesTouched: [] },
        ]);

        expect(budgets).toHaveLength(2);
        expect(budgets[1]).toBeGreaterThan(budgets[0]!);
        expect(result.status).toBe('ok');
    });

    it('does not retry a complete-but-malformed rollup - the next pass recomputes it from turn rows', async () => {
        const provider = new HaikuRollupProvider({ apiKey: 'test' });
        const budgets = scriptClient(provider, [{ maxTokens: 30, stopReason: 'end_turn', text: 'nope' }]);

        const result = await provider.rollup([
            { turnIndex: 0, startedAt: '2026-08-01T00:00:00.000Z', decisions: ['d'], pendingItems: [], filesTouched: [] },
        ]);

        expect(budgets).toHaveLength(1);
        expect(result.status).toBe('parse_error');
    });
});

describe('isRefusedProjectRoot', () => {
    const home = process.env.HOME as string;

    // $HOME registered itself as a project and ingested personal medical files.
    // Purging the row is not a fix: the next session from that cwd recreates
    // it, which is exactly what happened hours after the purge.
    it('refuses $HOME itself but allows projects beneath it', () => {
        expect(isRefusedProjectRoot(home)).toBe(true);
        expect(isRefusedProjectRoot(`${home}/Sites/real-project`)).toBe(false);
    });

    it('refuses document dumps as project roots', () => {
        expect(isRefusedProjectRoot(`${home}/Documents`)).toBe(true);
        expect(isRefusedProjectRoot(`${home}/Desktop`)).toBe(true);
        expect(isRefusedProjectRoot(`${home}/Downloads`)).toBe(true);
    });

    it('refuses an empty cwd, which would create an unreachable project row', () => {
        expect(isRefusedProjectRoot('')).toBe(true);
        expect(isRefusedProjectRoot('   ')).toBe(true);
    });

    it('refuses system roots and applies host case semantics', () => {
        expect(isRefusedProjectRoot('/')).toBe(true);
        expect(isRefusedProjectRoot('/etc')).toBe(true);
        if (process.platform === 'darwin' || process.platform === 'win32') {
            expect(isRefusedProjectRoot(home.toUpperCase())).toBe(true);
        } else {
            expect(isRefusedProjectRoot(home.toUpperCase())).toBe(false);
        }
    });
});
