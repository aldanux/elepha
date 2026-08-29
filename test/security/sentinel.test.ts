import { describe, expect, it } from 'vitest';
import { buildInjectionId, CLOSE, containsSentinel, OPEN, wrap } from '../../src/security/sentinel.js';

describe('Rule 4 sentinel', () => {
    it('fails closed for complete, truncated, and mangled marker prefixes only', () => {
        expect(containsSentinel('before [[elepha:brief:01J]] after')).toBe(true);
        expect(containsSentinel('before [[elepha:')).toBe(true);
        expect(containsSentinel('before [[elepha:???')).toBe(true);
        expect(containsSentinel('elepha is mentioned in normal prose.')).toBe(false);
    });

    it('wraps a body with line-isolated markers containing the generated ID', () => {
        const id = buildInjectionId();
        const wrapped = wrap('brief', id, 'Remember this decision.');

        expect(id).toMatch(/^[0-9A-HJKMNP-TV-Z]{26}$/);
        expect(wrapped.split('\n')).toEqual([`${OPEN}brief:${id}]]`, 'Remember this decision.', CLOSE]);
    });
});
