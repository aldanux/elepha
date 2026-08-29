// haiku-provider.ts and rollup-provider.ts both log err.message verbatim
// to the summarizer call log (call-log.ts:32, world-readable until the
// permissions fix - and even at 0600, still a second place secrets can leak
// to besides the intended output). API client errors can echo back
// Authorization headers or API keys in their message text; truncate and
// redact before anything reaches disk.

import { describe, expect, it } from 'vitest';
import { sanitizeErrorMessage } from '../../src/summarizer/call-log.js';

describe('sanitizeErrorMessage', () => {
    it('redacts an Anthropic-style API key', () => {
        const msg = 'request failed: invalid key sk-ant-api03-abcdefghijklmnopqrstuvwxyz0123456789';
        expect(sanitizeErrorMessage(msg)).not.toContain('sk-ant-api03-abcdefghijklmnopqrstuvwxyz0123456789');
        expect(sanitizeErrorMessage(msg)).toContain('[redacted]');
    });

    it('redacts a Bearer authorization header value', () => {
        const msg = 'HTTP 401: header Authorization: Bearer abcXYZ123.longtoken-value_here failed validation';
        const out = sanitizeErrorMessage(msg);
        expect(out).not.toContain('abcXYZ123.longtoken-value_here');
        expect(out).toContain('Bearer [redacted]');
    });

    it('truncates a very long message', () => {
        // Space-separated short words, not one long token - exercises length
        // truncation independently of key/token redaction.
        const msg = `boom: ${'lorem ipsum '.repeat(200)}`;
        const out = sanitizeErrorMessage(msg);
        expect(out.length).toBeLessThan(400);
        expect(out).toContain('[truncated]');
    });

    it('leaves a short, benign message unchanged', () => {
        expect(sanitizeErrorMessage('rate limit exceeded')).toBe('rate limit exceeded');
    });
});
