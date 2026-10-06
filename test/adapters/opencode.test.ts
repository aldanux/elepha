import { describe, expect, it } from 'vitest';
import { opencodeSessionAiTitle } from '../../src/adapters/opencode.js';

describe('OpencodeAdapter', () => {
    it('treats OpenCode placeholder titles as absent', () => {
        expect(opencodeSessionAiTitle('New session - 2026-09-08T16:24:27.510Z')).toBeUndefined();
        expect(opencodeSessionAiTitle('Qué es Git')).toBe('Qué es Git');
    });
});
