// Segmentation boundary tests: gap >= 7d cuts unconditionally; below that,
// high file overlap vetoes a cut and known-equal branches suppress a lone
// low-overlap signal. Otherwise gap >= 4h cuts with discontinuity evidence,
// while gap < 4h never cuts regardless of evidence.

import { describe, expect, it } from 'vitest';
import { assessSegmentBoundary, evaluateSegmentBoundary, fileOverlapRatio } from '../../src/storage/segmentation.js';

function base(overrides: Partial<Parameters<typeof evaluateSegmentBoundary>[0]> = {}) {
    return {
        gapHours: 5,
        trailingBranch: 'main',
        resumingBranch: 'main',
        trailingFiles: ['/p/a.ts'],
        resumingFiles: ['/p/a.ts'],
        resumeMarkerBefore: false,
        ...overrides,
    };
}

describe('evaluateSegmentBoundary', () => {
    it('cuts unconditionally at a >=7 day gap, even with no evidence at all', () => {
        expect(
            evaluateSegmentBoundary(
                base({ gapHours: 7 * 24, trailingBranch: null, resumingBranch: null, trailingFiles: [], resumingFiles: [] }),
            ),
        ).toBe(true);
    });

    it('cuts at a >=7 day gap despite complete file continuity and reports overlap as unavailable', () => {
        const input = base({ gapHours: 7 * 24, resumeMarkerBefore: true });
        expect(fileOverlapRatio(input.trailingFiles, input.resumingFiles)).toBe(1);
        expect(assessSegmentBoundary(input)).toEqual({ cut: true, evidence: ['seven-day-gap'], fileOverlap: null });
    });

    it('never cuts below a 4h gap, even when every evidence signal fires', () => {
        expect(
            evaluateSegmentBoundary(
                base({
                    gapHours: 3.9,
                    trailingBranch: 'main',
                    resumingBranch: 'feature/x',
                    trailingFiles: ['/p/a.ts'],
                    resumingFiles: ['/p/b.ts'],
                    resumeMarkerBefore: true,
                }),
            ),
        ).toBe(false);
    });

    it('the resume marker at a <4h gap does not override the never-cut floor (--model restart case)', () => {
        expect(evaluateSegmentBoundary(base({ gapHours: 0.01, resumeMarkerBefore: true }))).toBe(false);
    });

    it('the resume marker at a >=4h gap is sufficient evidence to cut on its own', () => {
        expect(evaluateSegmentBoundary(base({ gapHours: 5, trailingFiles: [], resumingFiles: [], resumeMarkerBefore: true }))).toBe(true);
    });

    it('complete file continuity vetoes a resume-marker cut below seven days', () => {
        expect(evaluateSegmentBoundary(base({ gapHours: 18, resumeMarkerBefore: true }))).toBe(false);
    });

    it('a >=4h gap with no evidence at all does not cut (resume-tomorrow guard)', () => {
        expect(evaluateSegmentBoundary(base({ gapHours: 5, resumeMarkerBefore: false }))).toBe(false);
    });

    it('a >=4h gap with a differing branch cuts', () => {
        expect(evaluateSegmentBoundary(base({ gapHours: 5, resumingBranch: 'feature/y', trailingFiles: [], resumingFiles: [] }))).toBe(
            true,
        );
    });

    it('a >=4h gap with genuine 0.083 file overlap cuts when both sides carry data', () => {
        const trailingFiles = ['/p/shared.ts', ...Array.from({ length: 10 }, (_, index) => `/p/old-${index}.ts`)];
        const resumingFiles = ['/p/shared.ts', '/p/new.ts'];
        expect(fileOverlapRatio(trailingFiles, resumingFiles)).toBeCloseTo(1 / 12);
        expect(
            evaluateSegmentBoundary(base({ gapHours: 5, trailingBranch: null, resumingBranch: null, trailingFiles, resumingFiles })),
        ).toBe(true);
    });

    it('known equal branches suppress low file overlap as the only evidence', () => {
        expect(evaluateSegmentBoundary(base({ gapHours: 5, trailingFiles: ['/p/a.ts'], resumingFiles: ['/p/b.ts'] }))).toBe(false);
    });

    it('known equal branches do not suppress low file overlap combined with a resume marker', () => {
        expect(
            evaluateSegmentBoundary(
                base({ gapHours: 5, trailingFiles: ['/p/a.ts'], resumingFiles: ['/p/b.ts'], resumeMarkerBefore: true }),
            ),
        ).toBe(true);
    });

    it('a branch absent on one side leaves low file overlap sufficient to cut', () => {
        expect(
            evaluateSegmentBoundary(base({ gapHours: 5, trailingBranch: null, trailingFiles: ['/p/a.ts'], resumingFiles: ['/p/b.ts'] })),
        ).toBe(true);
    });

    it('a >=4h gap with both file windows empty does not read as discontinuity (Codex under-cut regression guard)', () => {
        expect(
            evaluateSegmentBoundary(
                base({ gapHours: 5, trailingBranch: null, resumingBranch: null, trailingFiles: [], resumingFiles: [] }),
            ),
        ).toBe(false);
    });

    it('trailing files present + resuming empty is unavailable, not file-overlap evidence', () => {
        const input = base({ gapHours: 5, trailingBranch: null, resumingBranch: null, trailingFiles: ['/p/a.ts'], resumingFiles: [] });
        expect(fileOverlapRatio(input.trailingFiles, input.resumingFiles)).toBeNull();
        expect(assessSegmentBoundary(input)).toEqual({ cut: false, evidence: [], fileOverlap: null });
        expect(evaluateSegmentBoundary(input)).toBe(false);
    });

    it('trailing empty + resuming files present is unavailable, not file-overlap evidence', () => {
        const input = base({ gapHours: 5, trailingBranch: null, resumingBranch: null, trailingFiles: [], resumingFiles: ['/p/a.ts'] });
        expect(fileOverlapRatio(input.trailingFiles, input.resumingFiles)).toBeNull();
        expect(assessSegmentBoundary(input)).toEqual({ cut: false, evidence: [], fileOverlap: null });
        expect(evaluateSegmentBoundary(input)).toBe(false);
    });

    it('an unknown branch on either side is not treated as "differs" (Codex per-turn branch is often unavailable)', () => {
        expect(evaluateSegmentBoundary(base({ gapHours: 5, trailingBranch: null, resumingBranch: 'main' }))).toBe(false);
    });
});
