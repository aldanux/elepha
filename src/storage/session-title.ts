import { INTERNAL_COMMAND_TAGS } from '../adapters/internal-command.js';
import { MAX_TITLE_CHARS } from '../config/constants.js';
import { stripShellSyntax } from '../security/sanitize.js';
import type { ParsedTurn } from '../types/index.js';

export const UNTITLED_EPISODE = 'Untitled episode';

const COMPACTION_SUMMARY_PREFIX = 'this session is being continued from a previous conversation that ran out of context.';
const CODEX_HISTORY_REVIEW_PREFIX = 'the following is the codex agent history whose request action you are assessing';

function cleanTitle(value: string): string {
    const cleaned = stripShellSyntax(value).replace(/\s+/g, ' ').trim();
    return cleaned.length <= MAX_TITLE_CHARS ? cleaned : `${cleaned.slice(0, MAX_TITLE_CHARS - 1)}…`;
}

function promptTitle(value: string): string | undefined {
    const prompt = value.trim();
    const firstToken = prompt.split(/\s+/, 1)[0] ?? '';
    if (
        prompt === '' ||
        /^\/[A-Za-z0-9][A-Za-z0-9_-]*$/.test(firstToken) ||
        INTERNAL_COMMAND_TAGS.test(prompt) ||
        prompt.toLowerCase().startsWith('elepha:') ||
        prompt.toLowerCase() === 'compact' ||
        prompt.toLowerCase().startsWith(COMPACTION_SUMMARY_PREFIX) ||
        prompt.toLowerCase().startsWith(CODEX_HISTORY_REVIEW_PREFIX)
    ) {
        return undefined;
    }
    const lines = prompt.split(/\r?\n/).filter((line) => line.trim() !== '');
    const firstLine = lines[0] ?? prompt;
    const firstLineWithoutHeading = firstLine.replace(/^#+\s+/, '');
    let title = cleanTitle(firstLineWithoutHeading);
    if (title.length < 20) {
        title =
            firstLineWithoutHeading === firstLine
                ? cleanTitle(prompt)
                : (lines
                      .slice(1)
                      .map((line) => cleanTitle(line.replace(/^#+\s+/, '')))
                      .find((lineTitle) => lineTitle.length >= 20) ?? cleanTitle(prompt));
    }
    return title === '' ? undefined : title;
}

function aiTitle(value: string | undefined): string | undefined {
    if (value === undefined) {
        return undefined;
    }
    const title = cleanTitle(value);
    return title === '' ? undefined : title;
}

/**
 * Resolves the title for one persisted segment without reading a transcript
 * at serve time. An ai-title replaces the fallback only in the segment that
 * emitted it; a later segment begins with no inherited state.
 */
export function titleForTurn(
    currentTitle: string | null,
    turn: Pick<ParsedTurn, 'aiTitle' | 'userMessage'>,
    includeAiTitle: boolean,
): string {
    const prompt = promptTitle(turn.userMessage);
    const generated = includeAiTitle ? aiTitle(turn.aiTitle) : undefined;
    if (generated !== undefined && (prompt !== undefined || (currentTitle !== null && currentTitle !== UNTITLED_EPISODE))) {
        return generated;
    }

    if (currentTitle === null || currentTitle === UNTITLED_EPISODE) {
        return prompt ?? UNTITLED_EPISODE;
    }
    return currentTitle;
}

/** Derives the closed title rule for a fully known segment during backfill. */
export function titleForSegment(turns: Iterable<Pick<ParsedTurn, 'aiTitle' | 'userMessage'>>, includeAiTitle: boolean): string {
    let firstAiTitle: string | undefined;
    let firstPrompt: string | undefined;
    for (const turn of turns) {
        firstAiTitle ??= includeAiTitle ? aiTitle(turn.aiTitle) : undefined;
        firstPrompt ??= promptTitle(turn.userMessage);
    }
    return firstPrompt === undefined ? UNTITLED_EPISODE : (firstAiTitle ?? firstPrompt);
}
