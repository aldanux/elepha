import { createHash } from 'node:crypto';
import type { ParsedTurn } from '../types/index.js';

export function sourceTurnDigest(turn: ParsedTurn): string {
    const fields: unknown[] = [
        turn.sourceKey,
        turn.projectPath,
        turn.startedAt,
        turn.endedAt,
        turn.userMessage,
        turn.assistantText,
        turn.toolCalls,
        turn.droppedReason,
        turn.provenance,
    ];
    if (turn.taskStateReport !== undefined) {
        fields.push(turn.taskStateReport);
    }
    return createHash('sha256').update(JSON.stringify(fields)).digest('hex');
}

// Before rejected retries were recognized, capture pinned this same native
// turn without its withheld report. Only an adapter-proven rejected retry
// can match that prior shape; all ordinary source fields remain pinned.
export function sourceTurnDigests(turn: ParsedTurn): string[] {
    const digests = [sourceTurnDigest(turn)];
    if (turn.taskStateReport !== undefined && turn.taskStateReportRejectedRetry === true) {
        digests.push(sourceTurnDigest({ ...turn, taskStateReport: undefined }));
    }
    return digests;
}
