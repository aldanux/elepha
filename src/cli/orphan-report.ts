import type { OrphanClassification } from '../storage/orphan-classification.js';
import { storedToolDisplayName } from './stored-tool-display.js';

export function printOrphanClassification(
    report: OrphanClassification,
    details = false,
    deletionCandidates = report.totals.candidate,
): void {
    const t = report.totals;

    console.log(
        `Preserved memory: ${t.associated} chat${t.associated === 1 ? '' : 's'} with an existing project; ${t.relocated} with relocation evidence or needing project association repair; ${t.unresolved} not safely classified; ${t.mixed} with a mixture of missing and protected project parts.`,
    );
    console.log(
        deletionCandidates === 0
            ? 'Cleanup: no chats qualify for deletion; no cleanup confirmation is needed.'
            : `Cleanup: ${deletionCandidates} deletion candidate chat${deletionCandidates === 1 ? '' : 's'} with confirmed missing project directories; separate deletion approval is required.`,
    );
    if (report.incomplete) {
        console.log('Incomplete inspections remain preserved; no absence was inferred from an inspection failure.');
    }
    if (t.mixed > 0) {
        console.log('Chats with missing and protected project parts are kept in full; removing individual parts is not supported.');
    }
    if (details) {
        if (report.omittedDetails > 0) {
            console.log(`Dropped ${report.omittedDetails} oldest/oversized classification details at the diagnostic budget.`);
        }
        for (const unit of report.details) {
            console.log(
                `  ${JSON.stringify(storedToolDisplayName(unit.tool))}:${JSON.stringify(unit.nativeId)} — ${unit.outcome}: ${unit.reasons.map((r) => JSON.stringify(r)).join('; ')}`,
            );
            for (const segment of unit.ownership) {
                console.log(
                    `    segment ${segment.segmentIndex} [${segment.segmentId}], project [${segment.projectId}] ${JSON.stringify(segment.projectPath)}${segment.projectPath === null ? ' (ownership unavailable in bounded discovery)' : ''}`,
                );
            }
        }
    }
}
