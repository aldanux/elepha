import { createHash } from 'node:crypto';
import { escapeShellSyntax } from '../security/sanitize.js';
import type { ServedSession } from '../storage/session-read-model.js';

function storedArray(value: string, field: string): unknown[] {
    try {
        const decoded: unknown = JSON.parse(value);
        if (Array.isArray(decoded)) {
            return decoded;
        }
    } catch {
        // Parser errors can echo stored content; report only the failed field.
    }
    throw new Error(`Invalid stored ${field}; semantic source was not generated.`);
}

function strings(value: string | null | undefined, field: string): string[] {
    if (value == null) {
        return [];
    }
    const decoded = storedArray(value, field);
    if (decoded.some((item) => typeof item !== 'string')) {
        throw new Error(`Invalid stored ${field}; semantic source was not generated.`);
    }
    return decoded as string[];
}

// Only the durable metadata read model is accepted here, never transcript turns.
// Reapply the shared, idempotent sanitizer at the derived-cache write boundary.
export function embeddingSourceText(session: ServedSession): string {
    const texts = [session.title, session.custom_title, session.rollup_title, session.first_prompt_search, session.rollup_summary];
    if (session.rollup_decisions != null) {
        const decisions = storedArray(session.rollup_decisions, 'decisions');
        for (const decision of decisions) {
            if (
                !decision ||
                typeof decision !== 'object' ||
                !('what' in decision) ||
                !('why' in decision) ||
                typeof decision.what !== 'string' ||
                typeof decision.why !== 'string'
            ) {
                throw new Error('Invalid stored decision; semantic source was not generated.');
            }
            texts.push(decision.what, decision.why);
        }
    }
    if (session.rollup_instructions != null) {
        const instructions = storedArray(session.rollup_instructions, 'instructions');
        for (const instruction of instructions) {
            const why = instruction && typeof instruction === 'object' && 'why' in instruction ? instruction.why : undefined;
            if (
                !instruction ||
                typeof instruction !== 'object' ||
                !('what' in instruction) ||
                typeof instruction.what !== 'string' ||
                (why !== undefined && typeof why !== 'string')
            ) {
                throw new Error('Invalid stored instruction; semantic source was not generated.');
            }
            texts.push(instruction.what);
            if (why !== undefined) {
                texts.push(why);
            }
        }
    }
    texts.push(...strings(session.rollup_pending_items, 'pending items'));
    return escapeShellSyntax(texts.filter((text): text is string => typeof text === 'string' && text.trim().length > 0).join('\n'));
}

export function embeddingSourceHash(text: string): string {
    return createHash('sha256').update(text, 'utf8').digest('hex');
}
