import { randomUUID } from 'node:crypto';
import { embeddingSourceHash, embeddingSourceText } from '../embeddings/source.js';
import { AUTOMATIC_RECALL_INSTRUCTIONS, automaticContextInstructions, dataBlockClose, dataBlockOpen } from './instructions.js';
import { hitIdentity } from './lexical-recall.js';
import { type currentRecallHits, semanticDiscovery } from './semantic-recall.js';
import { publicSessionId } from './session-id.js';

export const AUTOMATIC_RECALL_BODY_PREFIX = 'Automatic memory candidate: ';

export function automaticRecallCandidate(hit: ReturnType<typeof currentRecallHits>[number], similarity: number) {
    const id = publicSessionId(hit.session);
    const identity = hitIdentity(hit);
    // Include source and provenance, but not query wording or score: a changed
    // instruction may be shown again; a paraphrased follow-up may not.
    const hash = embeddingSourceHash(JSON.stringify([id, identity, embeddingSourceText(hit.session)]));
    const prefix = `${AUTOMATIC_RECALL_BODY_PREFIX}${hash}\n`;
    const body = [
        prefix.trimEnd(),
        `Title: ${identity.sessionTitle}`,
        `Why relevant: ${semanticDiscovery(similarity)} to the current prompt; relevance is unverified.`,
        `Project: ${identity.project}`,
        `Tool/surface: ${identity.tool}`,
        `Date: ${identity.date}`,
        `Session: ${id}`,
    ].join('\n');
    return { prefix, body };
}

export function automaticRecallBody(candidates: readonly { body: string }[], nonce: string = randomUUID(), notice?: string): string {
    return [
        automaticContextInstructions(nonce),
        AUTOMATIC_RECALL_INSTRUCTIONS,
        '',
        dataBlockOpen(nonce),
        ...candidates.map((candidate) => candidate.body.slice(candidate.body.indexOf('\n') + 1)),
        dataBlockClose(nonce),
        ...(notice === undefined ? [] : [notice]),
    ].join('\n');
}
