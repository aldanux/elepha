// Raw-turn serving filter shared by ingestion (rendered_chars) and the
// serving surface. It deliberately accepts already-normalized ParsedTurn
// values: adapter JSONL parsing remains the only code that knows transcript
// formats, and this module never reads a transcript or starts a subprocess.

import { escapeShellSyntax } from '../security/sanitize.js';
import type { ParsedTurn } from '../types/index.js';
import { type FilteredTurnProjection, filterTurn } from './filtered-turn.js';

export const RAW_TURN_SEPARATOR = '\n\n---\n\n';

export function omissionMarker(omitted: number, shown: number, total: number): string {
    return `+${omitted} older rendered turns in this episode omitted (${shown} shown of ${total}).`;
}

function renderToolCalls(projection: FilteredTurnProjection): string | undefined {
    if (projection.toolCalls.length === 0 && projection.omittedToolCallCount === 0) {
        return undefined;
    }

    const lines = projection.toolCalls.flatMap((call) => [
        `- \`${escapeShellSyntax(call.name)}\``,
        ...call.filePaths.map((filePath) => `  - \`${escapeShellSyntax(filePath)}\``),
    ]);
    if (projection.omittedToolCallCount > 0) {
        lines.push(
            `- ${projection.omittedToolCallCount} tool call${projection.omittedToolCallCount === 1 ? '' : 's'} without file paths omitted`,
        );
    }
    return `**Tool calls**\n\n${lines.join('\n')}`;
}

// Renders one kept turn, or null for an explicit no-tool-call pause.
export function renderRawTurn(turn: ParsedTurn, renderedTurnNumber: number = turn.turnIndex): string | null {
    const projection = filterTurn(turn);
    if (!projection.included) {
        return null;
    }

    return [
        `## Turn ${renderedTurnNumber}`,
        `**User prompt**\n\n${escapeShellSyntax(projection.userPrompt)}`,
        `**Assistant response**\n\n${escapeShellSyntax(projection.assistantResponse)}`,
        renderToolCalls(projection),
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
