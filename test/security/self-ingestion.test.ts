import { describe, expect, it } from 'vitest';
import { isNearVerbatim } from '../../src/security/self-ingestion.js';

describe('Rule 4 near-verbatim matching', () => {
    it('matches an embedded normalized injected line of at least forty characters', () => {
        const injection = 'This exact injected instruction is deliberately longer than forty characters!';
        expect(isNearVerbatim(`A reply quoted: ${injection.replace('instruction', 'instruction,')} Then it continued.`, injection)).toBe(
            true,
        );
    });

    it.each([
        ['below the 60 percent shingle threshold', 'abcdefghijklmn', false],
        ['above the 60 percent shingle threshold', 'abcdefghijklmnop', true],
        ['a paraphrase below both thresholds', 'the intent was described in different words', false],
    ])('%s', (_label, turn, expected) => {
        expect(isNearVerbatim(turn, 'abcdefghijklmnopqrst')).toBe(expected);
    });
});
