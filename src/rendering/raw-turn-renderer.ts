// Raw-turn serving filter shared by ingestion (rendered_chars) and the
// serving surface. It deliberately accepts already-normalized ParsedTurn
// values: adapter JSONL parsing remains the only code that knows transcript
// formats, and this module never reads a transcript or starts a subprocess.

import { escapeShellSyntax } from '../security/sanitize.js';
import type { ParsedTurn } from '../types/index.js';

export const RAW_TURN_SEPARATOR = '\n\n---\n\n';

export function omissionMarker(omitted: number, shown: number, total: number): string {
    return `+${omitted} older rendered turns in this episode omitted (${shown} shown of ${total}).`;
}

// Codex's internal memory markup is injected content, not part of the human
// conversation. Non-greedy matching keeps adjacent blocks independent.
const MEMORY_CITATION_BLOCK = /<oai-mem-citation>[\s\S]*?<\/oai-mem-citation>/g;

// This is intentionally categorical, never length-based. The pause is explicit
// in the user message and the turn did no tool work; the acknowledgement may
// include a sentence about deferred work, which must not defeat the filter.
const EXPLICIT_PAUSE_REQUEST =
    /\b(?:no\s+(?:hagas?|hacer|toques?)\s+nada(?:\s+de\s+momento)?|do(?:n't| not)\s+(?:do|change|touch)\s+anything|hold\s+off|pause\s+here|wait\s+for\s+now)\b/i;

function withoutMemoryCitations(text: string): string {
    return text.replace(MEMORY_CITATION_BLOCK, '');
}

function isExplicitPauseTurn(turn: ParsedTurn, userMessage: string): boolean {
    return turn.toolCalls.length === 0 && EXPLICIT_PAUSE_REQUEST.test(userMessage);
}

function renderToolCalls(turn: ParsedTurn): string | undefined {
    const pathBearing = turn.toolCalls.filter((call) => call.filePaths.length > 0);
    const withoutPaths = turn.toolCalls.length - pathBearing.length;
    if (pathBearing.length === 0 && withoutPaths === 0) {
        return undefined;
    }

    const lines = pathBearing.flatMap((call) => [
        `- \`${escapeShellSyntax(call.name)}\``,
        ...call.filePaths.map((filePath) => `  - \`${escapeShellSyntax(filePath)}\``),
    ]);
    if (withoutPaths > 0) {
        lines.push(`- ${withoutPaths} tool call${withoutPaths === 1 ? '' : 's'} without file paths omitted`);
    }
    return `**Tool calls**\n\n${lines.join('\n')}`;
}

// Renders one kept turn, or null for an explicit no-tool-call pause.
export function renderRawTurn(turn: ParsedTurn, renderedTurnNumber: number = turn.turnIndex): string | null {
    // Adapters preserve transcript whitespace. It is not conversation content
    // at the outer edges, and retaining it would make the stored count differ
    // from the reviewed golden artifacts.
    const userMessage = withoutMemoryCitations(turn.userMessage).trim();
    const assistantText = withoutMemoryCitations(turn.assistantText).trim();
    if (isExplicitPauseTurn(turn, userMessage)) {
        return null;
    }

    return [
        `## Turn ${renderedTurnNumber}`,
        `**User prompt**\n\n${escapeShellSyntax(userMessage)}`,
        `**Assistant response**\n\n${escapeShellSyntax(assistantText)}`,
        renderToolCalls(turn),
    ]
        .filter((section): section is string => section !== undefined)
        .join('\n\n');
}

// Produces the rendered sequence once so every consumer shares its filter.
export function renderableRawTurns(turns: Iterable<ParsedTurn>, renderedTurnOffset: number = 0): string[] {
    const rendered: string[] = [];
    for (const turn of turns) {
        const text = renderRawTurn(turn, renderedTurnOffset + rendered.length + 1);
        if (text !== null) {
            rendered.push(text);
        }
    }
    return rendered;
}

// Renders a segment's turns with the exact inter-turn bytes served to consumers.
export function renderRawTurns(turns: Iterable<ParsedTurn>): string {
    const rendered = renderableRawTurns(turns);
    return rendered.length === 0 ? '' : `${rendered.join(RAW_TURN_SEPARATOR)}\n`;
}

// Stored turn-count input: the exact number of turns renderRawTurns keeps.
export function renderedTurns(turns: Iterable<ParsedTurn>): number {
    return renderableRawTurns(turns).length;
}

// Stored token-estimate input: the exact character count of renderRawTurns().
export function renderedChars(turns: Iterable<ParsedTurn>): number {
    return renderRawTurns(turns).length;
}
