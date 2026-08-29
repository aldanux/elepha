import { describe, expect, it } from 'vitest';
import { relativeTime } from '../../src/util/relative-time.js';

const NOW = Date.parse('2026-08-28T12:00:00.000Z');

describe('relativeTime', () => {
    it('uses minutes, hours, and days without introducing coarser units', () => {
        expect(relativeTime(new Date(NOW - 16 * 60 * 1000).toISOString(), NOW)).toBe('16m ago');
        expect(relativeTime(new Date(NOW - 16 * 60 * 60 * 1000).toISOString(), NOW)).toBe('16h ago');
        expect(relativeTime(new Date(NOW - 400 * 24 * 60 * 60 * 1000).toISOString(), NOW)).toBe('400d ago');
    });
});
