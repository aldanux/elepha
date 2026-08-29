import { describe, expect, it } from 'vitest';
import { claudeCodeSurface, codexSurface, toSessionRowKind } from '../../src/adapters/discriminators.js';

describe('claudeCodeSurface', () => {
    it('maps every Claude entrypoint input to its stored surface', () => {
        const cases = [
            ['cli', 'cli'],
            ['claude-desktop', 'desktop'],
            [undefined, null],
            ['something-new', null],
        ] as const;

        for (const [input, expected] of cases) {
            expect(claudeCodeSurface(input)).toBe(expected);
        }
    });
});

describe('codexSurface', () => {
    // Values: codex-tui 59, codex_exec 6, Codex Desktop 1, full local
    // corpus (66 files) - no fourth value found, both duplicate-session_meta files' second
    // occurrence also codex-tui.
    it('maps every Codex originator input to its stored surface', () => {
        const cases = [
            ['Codex Desktop', 'desktop'],
            ['codex-tui', 'cli'],
            ['codex_exec', 'cli'],
            ['some-future-codex-client', 'cli'],
            [undefined, null],
        ] as const;

        for (const [input, expected] of cases) {
            expect(codexSurface(input)).toBe(expected);
        }
    });
});

describe('toSessionRowKind', () => {
    it('maps every parsed session kind to its stored session kind', () => {
        const cases = [
            ['primary', 'main'],
            ['subagent', 'subagent'],
            ['fork-copy', 'fork'],
            ['adjudicator', 'adjudicator'],
        ] as const;

        for (const [input, expected] of cases) {
            expect(toSessionRowKind(input)).toBe(expected);
        }
    });
});
