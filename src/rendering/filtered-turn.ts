import { DURABLE_CAPTURE_FILTER_VERSION } from '../config/constants.js';

export interface FilterableToolCall {
    name: string;
    filePaths: string[];
}

export interface FilterableTurn {
    userMessage: string;
    assistantText: string;
    toolCalls: FilterableToolCall[];
}

export interface FilteredTurnProjection {
    filterVersion: number;
    included: boolean;
    userPrompt: string;
    assistantResponse: string;
    toolCalls: FilterableToolCall[];
    omittedToolCallCount: number;
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

export function filterTurn(turn: FilterableTurn): FilteredTurnProjection {
    const userPrompt = withoutMemoryCitations(turn.userMessage).trim();
    const assistantResponse = withoutMemoryCitations(turn.assistantText).trim();
    const included = !(turn.toolCalls.length === 0 && EXPLICIT_PAUSE_REQUEST.test(userPrompt));
    if (!included) {
        return {
            filterVersion: DURABLE_CAPTURE_FILTER_VERSION,
            included: false,
            userPrompt: '',
            assistantResponse: '',
            toolCalls: [],
            omittedToolCallCount: 0,
        };
    }

    const toolCalls = turn.toolCalls
        .filter((call) => call.filePaths.length > 0)
        .map((call) => ({ name: call.name, filePaths: [...call.filePaths] }));
    return {
        filterVersion: DURABLE_CAPTURE_FILTER_VERSION,
        included: true,
        userPrompt,
        assistantResponse,
        toolCalls,
        omittedToolCallCount: turn.toolCalls.length - toolCalls.length,
    };
}
