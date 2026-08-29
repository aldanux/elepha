import { describe, expect, it } from 'vitest';
import { MAX_SUMMARIZATION_FIELD_CHARS } from '../../src/config/constants.js';
import { buildRepairUserContent, buildSummarizationUserContent } from '../../src/summarizer/prompt.js';

const HEAD_CHARS = Math.floor(MAX_SUMMARIZATION_FIELD_CHARS / 3);
const TAIL_CHARS = MAX_SUMMARIZATION_FIELD_CHARS - HEAD_CHARS;

function longText(opening: string, ending: string): string {
    return `${opening}${'x'.repeat(MAX_SUMMARIZATION_FIELD_CHARS)}${ending}`;
}

function truncationMarker(text: string): string {
    return `\n…[${text.length - MAX_SUMMARIZATION_FIELD_CHARS} chars omitted]…\n`;
}

describe('summarization prompt truncation', () => {
    it('keeps the assistant reply head and tail, with trailing decisions and next steps visible', () => {
        const opening = 'Opening context: investigate the failing import.\n';
        const ending = '\nDecision: keep the existing import boundary.\nNext step: add the regression test.';
        const assistant = longText(opening, ending);

        const content = buildSummarizationUserContent('short user message', assistant);
        const embeddedAssistant = `${assistant.slice(0, HEAD_CHARS)}${truncationMarker(assistant)}${assistant.slice(-TAIL_CHARS)}`;

        expect(content).toContain(embeddedAssistant);
        expect(content).toContain(opening);
        expect(content).toContain(ending);
        expect(embeddedAssistant).toHaveLength(MAX_SUMMARIZATION_FIELD_CHARS + truncationMarker(assistant).length);
    });

    it('uses head-and-tail truncation for both turn fields and the repair echo', () => {
        const user = longText('User opening context.\n', '\nUser final constraint.');
        const assistant = longText('Assistant opening context.\n', '\nAssistant final decision.');
        const malformed = longText('Malformed JSON begins here.\n', '\nMalformed JSON ends here.');

        const summarization = buildSummarizationUserContent(user, assistant);
        const repair = buildRepairUserContent(malformed);

        for (const text of [user, assistant]) {
            expect(summarization).toContain(`${text.slice(0, HEAD_CHARS)}${truncationMarker(text)}${text.slice(-TAIL_CHARS)}`);
        }
        expect(repair).toContain(`${malformed.slice(0, HEAD_CHARS)}${truncationMarker(malformed)}${malformed.slice(-TAIL_CHARS)}`);
    });

    it('leaves text at the field limit byte-identical', () => {
        const atLimit = 'a'.repeat(MAX_SUMMARIZATION_FIELD_CHARS);

        expect(buildSummarizationUserContent(atLimit, atLimit)).toBe(
            `<user_message>${atLimit}</user_message>\n<assistant_reply>${atLimit}</assistant_reply>`,
        );
        expect(buildRepairUserContent(atLimit)).toContain(`\n${atLimit}\n\nReturn ONLY`);
        expect(buildSummarizationUserContent(atLimit, atLimit)).not.toContain('chars omitted');
        expect(buildRepairUserContent(atLimit)).not.toContain('chars omitted');
    });
});
