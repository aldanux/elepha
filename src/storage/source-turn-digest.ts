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
