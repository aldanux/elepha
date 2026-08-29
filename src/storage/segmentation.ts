// Segmentation boundary evaluator. Pure decision function - no I/O, no DB
// access. Callers assemble SegmentBoundaryInput from denormalized
// trailing_branch/trailing_files columns (see MemoryStore.updateTrailingState)
// plus the resuming turn's gitBranch/files_touched/resumeMarkerBefore, keeping
// the decision to one row read per closed turn.
//
//   - gap >= 7 days -> cut unconditionally; overlap is diagnostically unavailable.
//   - below 7 days, files_touched overlap >= 0.5 vetoes a cut.
//   - otherwise, gap >= 4h AND discontinuity evidence -> cut. Evidence: branch
//     differs, OR files_touched overlap below threshold, OR a Codex resume
//     marker (<environment_context>) immediately preceded the
//     resuming turn. Known-equal branches suppress file overlap when it is the
//     only evidence.
//   - gap >= 4h with no evidence -> no cut (resume-tomorrow guard).
//   - gap < 4h -> never cut, regardless of evidence. The marker does not
//     override this - a 36-second restart to change --model is a real
//     process reattachment inside one episode, not an episode boundary.

import {
    SEGMENT_FILE_CONTINUITY_THRESHOLD,
    SEGMENT_FILE_OVERLAP_THRESHOLD,
    SEGMENT_MIN_GAP_HOURS,
    SEGMENT_UNCONDITIONAL_GAP_HOURS,
} from '../config/constants.js';

export interface SegmentBoundaryInput {
    /** Elapsed hours between the prior turn's close and the resuming turn's start. */
    gapHours: number;
    /** sessions.trailing_branch at the time of the prior turn, or null if never captured. */
    trailingBranch: string | null;
    /** The resuming turn's own git branch, or null if unavailable (Codex has no per-turn branch - see corpus-discriminators). */
    resumingBranch: string | null;
    /** sessions.trailing_files at the time of the prior turn. */
    trailingFiles: string[];
    /** files_touched across the resuming turn(s) being evaluated. */
    resumingFiles: string[];
    /** True if a Codex <environment_context> resume marker was seen immediately before the resuming turn (ParsedTurn.resumeMarkerBefore). */
    resumeMarkerBefore: boolean;
}

/**
 * Below this ratio, files_touched overlap between the trailing window and the
 * resuming turns counts as discontinuity evidence: "overlap < 0.2 -> differs; >= 0.2 -> same".
 */

/**
 * At or above this ratio, file continuity is strong enough to veto a cut below
 * the unconditional seven-day boundary, regardless of other evidence.
 */

export type SegmentBoundaryEvidence = 'seven-day-gap' | 'branch-change' | 'file-overlap' | 'resume-marker';

export interface SegmentBoundaryAssessment {
    cut: boolean;
    evidence: SegmentBoundaryEvidence[];
    fileOverlap: number | null;
}

/**
 * Jaccard overlap (intersection / union) of the two file sets. Returns null
 * when either side is empty - that is "unavailable", never "differs". With
 * nothing on one side there is nothing to compare; treating the arithmetic
 * zero as maximum divergence would turn missing file data into cut evidence,
 * especially for Codex where most turns carry no paths.
 */
export function fileOverlapRatio(trailingFiles: string[], resumingFiles: string[]): number | null {
    if (trailingFiles.length === 0 || resumingFiles.length === 0) {
        return null;
    }
    const trailing = new Set(trailingFiles);
    const resuming = new Set(resumingFiles);
    let intersection = 0;
    for (const f of trailing) {
        if (resuming.has(f)) {
            intersection++;
        }
    }
    const union = new Set([...trailing, ...resuming]).size;
    return union === 0 ? null : intersection / union;
}

/**
 * True if branch is known on both sides and they differ. An unknown branch on
 * either side is never treated as "differs" - Codex has no per-turn branch
 * capture (see corpus-discriminators), and the Codex fallback rule ("no cut
 * below 7 days when no evidence exists") depends on that absence not being
 * misread as a positive discontinuity signal.
 */
function branchDiffers(trailingBranch: string | null, resumingBranch: string | null): boolean {
    return trailingBranch !== null && resumingBranch !== null && trailingBranch !== resumingBranch;
}

/**
 * Diagnostic companion to evaluateSegmentBoundary(). Migration previews need
 * to show why each proposed cut fired, not only the aggregate count. The
 * evaluator delegates to this function so preview evidence cannot drift from
 * the live decision rule.
 */
export function assessSegmentBoundary(input: SegmentBoundaryInput): SegmentBoundaryAssessment {
    if (input.gapHours >= SEGMENT_UNCONDITIONAL_GAP_HOURS) {
        return { cut: true, evidence: ['seven-day-gap'], fileOverlap: null };
    }
    const overlap = fileOverlapRatio(input.trailingFiles, input.resumingFiles);
    if (input.gapHours < SEGMENT_MIN_GAP_HOURS) {
        return { cut: false, evidence: [], fileOverlap: overlap };
    }
    if (overlap !== null && overlap >= SEGMENT_FILE_CONTINUITY_THRESHOLD) {
        return { cut: false, evidence: [], fileOverlap: overlap };
    }

    const evidence: SegmentBoundaryEvidence[] = [];
    if (branchDiffers(input.trailingBranch, input.resumingBranch)) {
        evidence.push('branch-change');
    }
    if (overlap !== null && overlap < SEGMENT_FILE_OVERLAP_THRESHOLD) {
        evidence.push('file-overlap');
    }
    if (input.resumeMarkerBefore) {
        evidence.push('resume-marker');
    }

    const branchesMatch = input.trailingBranch !== null && input.resumingBranch !== null && input.trailingBranch === input.resumingBranch;
    if (branchesMatch && evidence.length === 1 && evidence[0] === 'file-overlap') {
        return { cut: false, evidence: [], fileOverlap: overlap };
    }

    return { cut: evidence.length > 0, evidence, fileOverlap: overlap };
}

export function evaluateSegmentBoundary(input: SegmentBoundaryInput): boolean {
    return assessSegmentBoundary(input).cut;
}
