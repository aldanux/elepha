import { createHash } from 'node:crypto';
import type { ParsedTurn } from '../types/index.js';

export function sourceTurnDigest(turn: ParsedTurn): string {
    return createHash('sha256')
        .update(
            JSON.stringify([
                turn.sourceKey,
                turn.projectPath,
                turn.startedAt,
                turn.endedAt,
                turn.userMessage,
                turn.assistantText,
                turn.toolCalls,
                turn.droppedReason,
                turn.provenance,
            ]),
        )
        .digest('hex');
}
