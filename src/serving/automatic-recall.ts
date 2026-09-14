import { randomUUID } from 'node:crypto';
import { embeddingSourceHash, embeddingSourceText } from '../embeddings/source.js';
import { AUTOMATIC_RECALL_INSTRUCTIONS, dataBlockClose, dataBlockOpen, servedContextInstructions } from './instructions.js';
import { hitIdentity } from './lexical-recall.js';
import { type currentRecallHits, semanticDiscovery } from './semantic-recall.js';
import { publicSessionId } from './session-id.js';

export function automaticRecallCandidate(hit: ReturnType<typeof currentRecallHits>[number], similarity: number) {
    const id = publicSessionId(hit.session);
    const identity = hitIdentity(hit);
    // Include source and provenance, but not query wording or score: a changed
    // instruction may be shown again; a paraphrased follow-up may not.
    const hash = embeddingSourceHash(JSON.stringify([id, identity, embeddingSourceText(hit.session)]));
    const prefix = `Automatic memory candidate: ${hash}\n`;
    const nonce = randomUUID();
    const body = [
        prefix.trimEnd(),
        servedContextInstructions(nonce),
        AUTOMATIC_RECALL_INSTRUCTIONS,
        '',
        dataBlockOpen(nonce),
        `Title: ${identity.sessionTitle}`,
        `Why relevant: ${semanticDiscovery(similarity)} to the current prompt; relevance is unverified.`,
        `Project: ${identity.project}`,
        `Tool/surface: ${identity.tool}`,
        `Date: ${identity.date}`,
        `Session: ${id}`,
        dataBlockClose(nonce),
        `Fetch candidate: get_session({"id":${JSON.stringify(id)}})`,
    ].join('\n');
    return { prefix, body };
}
