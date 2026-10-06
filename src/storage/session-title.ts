import { INTERNAL_COMMAND_NAME } from '../adapters/internal-command.js';
import { MAX_TITLE_CHARS } from '../config/constants.js';
import { stripShellSyntax } from '../security/sanitize.js';
import type { ParsedTurn } from '../types/index.js';

export const UNTITLED_EPISODE = 'Untitled episode';

const COMPACTION_SUMMARY_PREFIX = 'this session is being continued from a previous conversation that ran out of context.';
const CODEX_HISTORY_REVIEW_PREFIX = 'the following is the codex agent history';
const INTERNAL_COMMAND_START = /^<command-(?:message|name)>/;
const FILESYSTEM_PATH = /^(?:\/|~\/|\.{1,2}\/|[A-Za-z]:[\\/])\S+$/;
const SOURCE_PATH = /^(?:[^\s/\\]+[\\/])+[^\s/\\]+\.[A-Za-z0-9]+(?::\d+(?::\d+)?)?$/;
const COMMENT_LINE = /^(?:\/\/|\/\*|\*\/|<!--|--!?>)/;
const DIFF_FRAGMENT = /^(?:diff --git\s|index\s+[0-9a-f]+|@@\s|---\s+(?:a\/|\/dev\/null)|\+\+\+\s+(?:b\/|\/dev\/null)|[+-](?:\t| {2,}|\S))/;
const CODE_STATEMENT =
    /^(?:[}\])]|(?:if|for|while|switch|catch)\s*\(|(?:const|let|var)\s+[A-Za-z_$]|(?:return|throw|await|yield|import|export|class|interface|type|function)\b|(?:[A-Za-z_$][\w$]*\.)*[A-Za-z_$][\w$]*\s*\(.*\)\s*;?$)/;

function cleanTitle(value: string): string {
    const cleaned = stripShellSyntax(value).replace(/\s+/g, ' ').trim();
    return cleaned.length <= MAX_TITLE_CHARS ? cleaned : `${cleaned.slice(0, MAX_TITLE_CHARS - 1)}…`;
}

function isCommandWrapper(prompt: string): boolean {
    return INTERNAL_COMMAND_START.test(prompt) && INTERNAL_COMMAND_NAME.test(prompt);
}

function isNonProseLine(value: string): boolean {
    const line = value.trim();
    const pathList = line.split(/,\s*/);
    return (
        FILESYSTEM_PATH.test(line) ||
        (pathList.length > 1 && pathList.every((item) => FILESYSTEM_PATH.test(item))) ||
        SOURCE_PATH.test(line) ||
        COMMENT_LINE.test(line) ||
        DIFF_FRAGMENT.test(line) ||
        CODE_STATEMENT.test(line)
    );
}

function stripLeadingMarkdownNoise(value: string): string {
    const withoutEmphasis = value
        .trim()
        .replace(/^([*_]+)(.+?)\1(?=\s|$)/, '$2')
        .replace(/^[*_]+\s*/, '');
    return withoutEmphasis.replace(/^:\s*/, '').trim();
}

function candidateForLine(value: string): string | undefined {
    const candidate = stripLeadingMarkdownNoise(value.trim().replace(/^#+\s+/, ''));
    if (candidate === '' || isNonProseLine(candidate)) {
        return undefined;
    }
    const title = cleanTitle(candidate);
    return title === '' ? undefined : title;
}

function addCandidate(candidates: string[], candidate: string | undefined): void {
    if (candidate !== undefined && !candidates.includes(candidate)) {
        candidates.push(candidate);
    }
}

function promptTitleCandidates(value: string): string[] {
    const prompt = value.trim();
    if (
        prompt === '' ||
        isCommandWrapper(prompt) ||
        prompt.toLowerCase().startsWith('elepha:') ||
        prompt.toLowerCase() === 'compact' ||
        prompt.toLowerCase().startsWith(COMPACTION_SUMMARY_PREFIX) ||
        prompt.toLowerCase().startsWith(CODEX_HISTORY_REVIEW_PREFIX)
    ) {
        return [];
    }
    const lines = prompt.split(/\r?\n/).filter((line) => line.trim() !== '');
    const firstLine = lines[0] ?? prompt;
    const firstTitle = candidateForLine(firstLine);
    const wholePrompt = cleanTitle(stripLeadingMarkdownNoise(prompt));
    const hasProseLine = lines.some((line) => candidateForLine(line) !== undefined);
    const candidates: string[] = [];

    if (firstTitle === undefined) {
        addCandidate(
            candidates,
            lines
                .slice(1)
                .map(candidateForLine)
                .find((candidate) => candidate !== undefined),
        );
    } else if (firstTitle.length >= 20) {
        addCandidate(candidates, firstTitle);
    } else if (/^#+\s+/.test(firstLine.trim())) {
        const nextLongCandidate = lines
            .slice(1)
            .map(candidateForLine)
            .find((candidate) => candidate !== undefined && candidate.length >= 20);
        addCandidate(candidates, nextLongCandidate ?? wholePrompt);
    } else {
        addCandidate(candidates, wholePrompt);
    }

    for (const line of lines) {
        addCandidate(candidates, candidateForLine(line));
    }
    if (hasProseLine) {
        addCandidate(candidates, wholePrompt === '' ? undefined : wholePrompt);
    }
    return candidates;
}

function promptTitle(value: string): string | undefined {
    return promptTitleCandidates(value)[0];
}

function aiTitle(value: string | undefined): string | undefined {
    if (value === undefined) {
        return undefined;
    }
    const normalized = value.replace(/\s+/g, ' ').trim();
    const title = normalized.length <= MAX_TITLE_CHARS ? normalized : `${normalized.slice(0, MAX_TITLE_CHARS - 1)}…`;
    return title === '' ? undefined : title;
}

// Resolves the title for one persisted segment without reading a transcript
// at serve time. An ai-title replaces the fallback only in the segment that
// emitted it; a later segment begins with no inherited state.
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
