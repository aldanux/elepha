import type { OrphanEvidence } from '../storage/orphan-classification.js';
import { storedToolDisplayName } from './stored-tool-display.js';

export const ORPHAN_PREVIEW_INSTRUCTIONS =
    '\nRun with --apply to remove them. A backup will be saved first.\nUse --details to see individual chats.';

export function printOrphanClassification(evidence: OrphanEvidence, details = false): void {
    const report = evidence.classification;
    const t = report.totals;
    const total = evidence.identities.length;
    if (total === 0) {
        console.log('Cleanup: no chats qualify for deletion; no cleanup confirmation is needed.');
    } else {
        console.log(`${total} chat${total === 1 ? '' : 's'} can be removed:`);
        const { emptyChats, missingProjectChats } = evidence.counts;
        if (emptyChats > 0) {
            console.log(`  ${emptyChats} empty chat${emptyChats === 1 ? '' : 's'} whose original history is missing.`);
        }
        if (missingProjectChats > 0) {
            console.log(
                `  ${missingProjectChats} chat${missingProjectChats === 1 ? '' : 's'} whose project folder${missingProjectChats === 1 ? ' no longer exists' : 's no longer exist'}.`,
            );
        }
    }
    if (report.incomplete) {
        console.log('Incomplete inspections remain preserved; no absence was inferred from an inspection failure.');
    }
    if (details) {
        console.log(
            `Preserved memory: ${t.associated} chat${t.associated === 1 ? '' : 's'} with an existing project; ${t.relocated} with relocation evidence or needing project association repair; ${t.unresolved} not safely classified; ${t.mixed} with a mixture of missing and protected project parts.`,
        );
        if (t.mixed > 0) {
            console.log('Chats with missing and protected project parts are kept in full; removing individual parts is not supported.');
        }
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
