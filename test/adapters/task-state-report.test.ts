import { mkdirSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import { ClaudeCodeAdapter } from '../../src/adapters/claude-code.js';
import { CodexAdapter } from '../../src/adapters/codex.js';
import { parseTaskStateReportInput, sameTaskStateReportInput } from '../../src/adapters/task-state-report.js';
import {
    TASK_STATE_REPORT_ACK,
    TASK_STATE_REPORT_INPUT_MAX_BYTES,
    TASK_STATE_REPORT_ITEM_MAX_CHARS,
    TASK_STATE_REPORT_LIST_MAX_ITEMS,
    TASK_STATE_REPORT_SOURCE_MAX_ITEMS,
    TASK_STATE_REPORT_SOURCE_QUOTE_MAX_CHARS,
} from '../../src/config/constants.js';
import { isNearVerbatim, turnText } from '../../src/security/self-ingestion.js';
import { open } from '../../src/security/sentinel.js';
import type { ParsedTurn } from '../../src/types/index.js';

const cwd = '/Users/test/demo-project';
const PROMPT = 'Implement the parser slice.';
const REQUEST_ID = '01J00000000000000000000000';
const SOURCE = { role: 'user', quote: PROMPT };
const REPORT = {
    mode: 'precompact_manifest',
    request_id: REQUEST_ID,
    objective: { text: 'Implement the parser slice.', sources: [SOURCE] },
    decisions: [{ text: 'Retain exact source evidence.', sources: [{ role: 'assistant', quote: 'Keep the cited source turn.' }] }],
    constraints: [],
    pending_items: [{ text: 'Add the report table.', sources: [SOURCE] }],
};
const EXPECTED_REPORT = {
    callId: 'report-1',
    ...REPORT,
};

async function collect(iter: AsyncIterable<ParsedTurn>): Promise<ParsedTurn[]> {
    const turns: ParsedTurn[] = [];
    for await (const turn of iter) turns.push(turn);
    return turns;
}

function fixture(name: string, lines: unknown[]): string {
    const directory = path.join(process.cwd(), '.test-scratch', 'task-state-report');
    mkdirSync(directory, { recursive: true });
    const file = path.join(directory, name);
    writeFileSync(file, `${lines.map((line) => JSON.stringify(line)).join('\n')}\n`);
    return file;
}

function claudeLine(type: 'user' | 'assistant', second: number, content: unknown): unknown {
    return {
        type,
        cwd,
        timestamp: `2026-09-28T00:00:${String(second).padStart(2, '0')}.000Z`,
        message: { role: type, content },
    };
}

function claudeReportCall(id: string, input: unknown, name = 'mcp__elepha__report_task_state'): unknown {
    return claudeLine('assistant', 4, [{ type: 'tool_use', id, name, input }]);
}

function claudeReportResult(id: string, content: unknown = [{ type: 'text', text: TASK_STATE_REPORT_ACK }], isError = false): unknown {
    return claudeLine('user', 5, [{ type: 'tool_result', tool_use_id: id, content, ...(isError ? { is_error: true } : {}) }]);
}

// User text, an ordinary tool call, the report call with its fixed
// acknowledgement, and the assistant's closing text.
function claudeComposite(): unknown[] {
    return [
        claudeLine('user', 0, PROMPT),
        claudeLine('assistant', 1, [
            { type: 'text', text: 'Reading the adapter first.' },
            { type: 'tool_use', id: 'read-1', name: 'Read', input: { file_path: 'src/adapters/base.ts' } },
        ]),
        claudeLine('user', 2, [{ type: 'tool_result', tool_use_id: 'read-1', content: 'adapter source' }]),
        claudeReportCall('report-1', REPORT),
        claudeReportResult('report-1'),
        claudeLine('assistant', 6, [{ type: 'text', text: 'The parser slice is in place.' }]),
    ];
}

function claudeGenericRecall(id = 'recall-1'): unknown[] {
    return [
        claudeLine('assistant', 3, [{ type: 'tool_use', id, name: 'mcp__elepha__recall', input: { query: 'parser' } }]),
        claudeLine('user', 3, [{ type: 'tool_result', tool_use_id: id, content: 'served elepha memory' }]),
    ];
}

function claudeNextTurn(): unknown[] {
    return [claudeLine('user', 7, 'Next request'), claudeLine('assistant', 8, [{ type: 'text', text: 'Next answer' }])];
}

async function parseClaude(lines: unknown[], warnings: string[] = []): Promise<ParsedTurn[]> {
    const adapter = new ClaudeCodeAdapter((message) => warnings.push(message));
    return collect(adapter.parseTurns(fixture('session.jsonl', lines), undefined, { closeTrailingOnIdle: true }));
}

function expectOrdinaryClaudeWork(turn: ParsedTurn | undefined): void {
    expect(turn?.droppedReason).toBeUndefined();
    expect(turn?.userMessage).toBe(PROMPT);
    expect(turn?.assistantText).toBe('Reading the adapter first.\nThe parser slice is in place.');
    expect(turn?.toolCalls.map((call) => call.name)).toEqual(['Read']);
}

describe('Claude Code task-state report', () => {
    it('rejects a report without the request id issued by elepha', () => {
        const { request_id: _requestId, ...unsolicited } = REPORT;
        expect(parseTaskStateReportInput(unsolicited)).toMatchObject({ state: 'incomplete', reason: 'malformed-input' });
    });

    it('keeps the ordinary turn, excludes the report from toolCalls, and captures the report', async () => {
        const turns = await parseClaude(claudeComposite());

        expect(turns).toHaveLength(1);
        expectOrdinaryClaudeWork(turns[0]);
        expect(turns[0]?.taskStateReport).toEqual(EXPECTED_REPORT);
        expect(turns[0]?.taskStateReportFailure).toBeUndefined();
        expect(turns[0]?.elephaMcpResultReceipts).toBeUndefined();
        expect(JSON.stringify(turns[0]?.toolCalls)).not.toContain('report');
        // The acknowledgement is never folded into turn content.
        expect(turnText(turns[0]!)).not.toContain(TASK_STATE_REPORT_ACK);
    });

    it('drops the whole turn, report included, when it also calls a generic elepha tool', async () => {
        const lines = claudeComposite();
        lines.splice(3, 0, ...claudeGenericRecall());
        const turns = await parseClaude(lines);

        expect(turns).toHaveLength(1);
        expect(turns[0]).toMatchObject({
            droppedReason: 'elepha-mcp',
            userMessage: '',
            assistantText: '',
            toolCalls: [],
            elephaMcpResultReceipts: [{ callId: 'recall-1', body: 'served elepha memory' }],
        });
        expect(turns[0]?.taskStateReport).toBeUndefined();
        expect(turns[0]?.taskStateReportFailure).toBeUndefined();
    });

    it('still drops a generic-only elepha turn and treats a near-miss report name as generic', async () => {
        const lines = claudeComposite();
        lines[3] = claudeReportCall('report-1', REPORT, 'mcp__elepha__report_task_state_v2');
        const turns = await parseClaude(lines);

        expect(turns[0]?.droppedReason).toBe('elepha-mcp');
        expect(turns[0]?.userMessage).toBe('');
        expect(turns[0]?.taskStateReport).toBeUndefined();
    });

    it('fails generic coverage closed when a generic elepha call reuses the report call id', async () => {
        const lines = claudeComposite();
        lines.splice(5, 0, ...claudeGenericRecall('report-1'));

        await expect(parseClaude(lines)).rejects.toMatchObject({ reason: 'duplicate-call-id' });
    });

    it('withholds a report whose acknowledgement never arrives and keeps the ordinary work', async () => {
        const lines = claudeComposite();
        lines.splice(4, 1);
        lines.push(...claudeNextTurn());
        const warnings: string[] = [];
        const turns = await parseClaude(lines, warnings);

        expect(turns).toHaveLength(2);
        expectOrdinaryClaudeWork(turns[0]);
        expect(turns[0]?.taskStateReport).toBeUndefined();
        expect(turns[0]?.taskStateReportFailure).toBe('missing-result');
        const withheld = warnings.filter((warning) => warning.includes('withheld task-state report'));
        expect(withheld.some((warning) => warning.includes('missing-result'))).toBe(true);
        expect(turns[1]?.userMessage).toBe('Next request');
        expect(turns[1]?.taskStateReportFailure).toBeUndefined();
    });

    it.each([
        ['malformed-input', { ...REPORT, mode: 'finished' }],
        ['malformed-input', { ...REPORT, confidence: 'high' }],
        ['malformed-input', { mode: 'postcompact_retained' }],
    ] as const)('withholds a %s report without dropping ordinary work', async (reason, input) => {
        const lines = claudeComposite();
        lines[3] = claudeReportCall('report-1', input);
        const turns = await parseClaude(lines);

        expectOrdinaryClaudeWork(turns[0]);
        expect(turns[0]?.taskStateReport).toBeUndefined();
        expect(turns[0]?.taskStateReportFailure).toBe(reason);
        expect(JSON.stringify(turns[0]?.toolCalls)).not.toContain('confidence');
    });

    it.each([
        { ...REPORT, objective: { text: 'x'.repeat(TASK_STATE_REPORT_ITEM_MAX_CHARS + 1), sources: [SOURCE] } },
        { ...REPORT, pending_items: Array.from({ length: TASK_STATE_REPORT_LIST_MAX_ITEMS + 1 }, () => REPORT.objective) },
    ])('withholds a field-oversized report while keeping ordinary work', async (input) => {
        const lines = claudeComposite();
        lines[3] = claudeReportCall('report-1', input);
        const turns = await parseClaude(lines);

        expectOrdinaryClaudeWork(turns[0]);
        expect(turns[0]?.taskStateReportFailure).toBe('oversized-input');
    });

    it('withholds conflicting reports in one turn', async () => {
        const lines = claudeComposite();
        lines.splice(5, 0, claudeReportCall('report-2', { ...REPORT, mode: 'postcompact_retained' }), claudeReportResult('report-2'));
        const turns = await parseClaude(lines);

        expectOrdinaryClaudeWork(turns[0]);
        expect(turns[0]?.taskStateReport).toBeUndefined();
        expect(turns[0]?.taskStateReportFailure).toBe('multiple-reports');
    });

    it.each([
        ['a different body', claudeReportResult('report-1', 'served elepha memory')],
        ['an error flag', claudeReportResult('report-1', [{ type: 'text', text: TASK_STATE_REPORT_ACK }], true)],
        ['an oversized body', claudeReportResult('report-1', `${TASK_STATE_REPORT_ACK}${' '.repeat(2048)}`)],
        ['an extra text-block field', claudeReportResult('report-1', [{ type: 'text', text: TASK_STATE_REPORT_ACK, extra: true }])],
        [
            'multiple text blocks',
            claudeReportResult('report-1', [
                { type: 'text', text: TASK_STATE_REPORT_ACK },
                { type: 'text', text: '' },
            ]),
        ],
    ])('withholds a report whose result carries %s', async (_label, result) => {
        const lines = claudeComposite();
        lines[4] = result;
        const turns = await parseClaude(lines);

        expectOrdinaryClaudeWork(turns[0]);
        expect(turns[0]?.taskStateReport).toBeUndefined();
        expect(turns[0]?.taskStateReportFailure).toBe('unexpected-result');
    });

    it('withholds a duplicated acknowledgement for the same report call', async () => {
        const lines = claudeComposite();
        lines.splice(5, 0, claudeReportResult('report-1'));
        const turns = await parseClaude(lines);

        expectOrdinaryClaudeWork(turns[0]);
        expect(turns[0]?.taskStateReportFailure).toBe('duplicate-call-id');
    });

    it('drops the whole turn when the report carries an elepha sentinel', async () => {
        const lines = claudeComposite();
        lines[3] = claudeReportCall('report-1', {
            ...REPORT,
            objective: { text: `${open('brief', '01JTEST')} copied context`, sources: [SOURCE] },
        });
        const turns = await parseClaude(lines);

        expect(turns[0]?.droppedReason).toBe('sentinel');
    });

    it.each([
        ['invalid field', 'report-1', { ...REPORT, extra: open('brief', '01JTEST') }],
        ['missing call id', '', { ...REPORT, extra: open('brief', '01JTEST') }],
    ])('drops a report turn with a sentinel despite %s', async (_label, id, input) => {
        const lines = claudeComposite();
        lines[3] = claudeReportCall(id, input);
        const turns = await parseClaude(lines);

        expect(turns[0]?.droppedReason).toBe('sentinel');
        expect(turns[0]?.taskStateReport).toBeUndefined();
    });

    it('drops an oversized raw object without scanning its content', async () => {
        const lines = claudeComposite();
        lines[3] = claudeReportCall('report-1', { ...REPORT, extra: 'x'.repeat(TASK_STATE_REPORT_INPUT_MAX_BYTES + 1) });
        const warnings: string[] = [];
        const turns = await parseClaude(lines, warnings);

        expect(turns[0]?.droppedReason).toBe('report-input-unscanned');
        expect(warnings.some((warning) => warning.includes('report input could not be fully scanned within bound'))).toBe(true);
        expect(warnings.some((warning) => warning.includes('(sentinel)'))).toBe(false);
    });

    it('does not claim a sentinel when one is beyond an oversized input bound', async () => {
        const lines = claudeComposite();
        lines[3] = claudeReportCall('report-1', {
            ...REPORT,
            extra: `${'x'.repeat(TASK_STATE_REPORT_INPUT_MAX_BYTES)}${open('brief', '01JTEST')}`,
        });
        const warnings: string[] = [];
        const turns = await parseClaude(lines, warnings);

        expect(turns[0]?.droppedReason).toBe('report-input-unscanned');
        expect(warnings.some((warning) => warning.includes('report input could not be fully scanned within bound'))).toBe(true);
        expect(warnings.some((warning) => warning.includes('(sentinel)'))).toBe(false);
    });

    it('drops a turn when a later conflicting report carries a sentinel', async () => {
        const lines = claudeComposite();
        lines.splice(5, 0, claudeReportCall('report-2', { ...REPORT, extra: open('brief', '01JTEST') }), claudeReportResult('report-2'));
        const turns = await parseClaude(lines);

        expect(turns[0]?.droppedReason).toBe('sentinel');
        expect(turns[0]?.taskStateReport).toBeUndefined();
    });
});

describe('task-state report Rule 4 surface', () => {
    it('includes report text in the quote-back surface', async () => {
        const injected = 'The team decided to keep every capture local and never upload transcripts anywhere.';
        const lines = claudeComposite();
        lines[3] = claudeReportCall('report-1', {
            ...REPORT,
            objective: { text: 'Continue the approved parser work.', sources: [{ role: 'user', quote: injected }] },
        });
        const [turn] = await parseClaude(lines);

        expect(turn?.taskStateReport?.objective?.sources?.[0]?.quote).toBe(injected);
        expect(isNearVerbatim(turnText(turn!), injected)).toBe(true);
        expect(isNearVerbatim(turnText({ ...turn!, taskStateReport: undefined }), injected)).toBe(false);
    });
});

describe('task-state report input bounds', () => {
    it('bounds a JSON-encoded argument string before decoding it', () => {
        const padded = `${' '.repeat(TASK_STATE_REPORT_INPUT_MAX_BYTES)}${JSON.stringify(REPORT)}`;
        expect(parseTaskStateReportInput(padded)).toEqual({ state: 'incomplete', reason: 'oversized-input' });
        expect(parseTaskStateReportInput(JSON.stringify(REPORT))).toMatchObject({ state: 'complete' });
    });

    it('rejects non-object and blank inputs instead of guessing', () => {
        expect(parseTaskStateReportInput('not json')).toEqual({ state: 'incomplete', reason: 'malformed-input' });
        expect(parseTaskStateReportInput([REPORT])).toEqual({ state: 'incomplete', reason: 'malformed-input' });
        expect(parseTaskStateReportInput({ ...REPORT, objective: { text: '   ', sources: [SOURCE] } })).toEqual({
            state: 'incomplete',
            reason: 'malformed-input',
        });
        expect(parseTaskStateReportInput({ ...REPORT, pending_items: [{ text: '', sources: [SOURCE] }] })).toEqual({
            state: 'incomplete',
            reason: 'malformed-input',
        });
    });

    it('accepts a source-free postcompact report and an entirely empty report', () => {
        const retained = {
            mode: 'postcompact_retained',
            request_id: REQUEST_ID,
            objective: { text: 'Finish the parser.' },
            decisions: [{ text: 'Keep the approved schema.' }],
            constraints: [],
            pending_items: [],
        };
        expect(parseTaskStateReportInput(retained)).toEqual({ state: 'complete', input: retained });
        const empty = { ...retained, objective: null, decisions: [] };
        expect(parseTaskStateReportInput(empty)).toEqual({ state: 'complete', input: empty });
        expect(
            parseTaskStateReportInput({
                ...REPORT,
                objective: { text: 'malformed-input', sources: [{ role: 'user', quote: 'oversized-input' }] },
            }),
        ).toMatchObject({ state: 'complete' });
    });

    it.each([
        { ...REPORT, objective: null },
        { ...REPORT, objective: { text: 'Finish the parser.' } },
        { ...REPORT, objective: { ...REPORT.objective, sources: [] } },
        { ...REPORT, objective: { ...REPORT.objective, sources: [{ role: 'system', quote: PROMPT }] } },
        { ...REPORT, objective: { ...REPORT.objective, sources: [{ role: 'user', quote: '  ' }] } },
        { ...REPORT, objective: { ...REPORT.objective, sources: [{ ...SOURCE, extra: true }] } },
        { ...REPORT, objective: { ...REPORT.objective, extra: true } },
        { ...REPORT, pending_items: undefined },
        {
            mode: 'postcompact_retained',
            request_id: REQUEST_ID,
            objective: { text: 'Finish', sources: [SOURCE] },
            decisions: [],
            constraints: [],
            pending_items: [],
        },
    ])('rejects malformed mode and source combinations', (input) => {
        expect(parseTaskStateReportInput(input)).toEqual({ state: 'incomplete', reason: 'malformed-input' });
    });

    it('bounds source count, quotes, and decoded bytes', () => {
        expect(
            parseTaskStateReportInput({
                ...REPORT,
                objective: { ...REPORT.objective, sources: Array.from({ length: TASK_STATE_REPORT_SOURCE_MAX_ITEMS + 1 }, () => SOURCE) },
            }),
        ).toEqual({ state: 'incomplete', reason: 'oversized-input' });
        expect(
            parseTaskStateReportInput({
                ...REPORT,
                objective: {
                    ...REPORT.objective,
                    sources: [{ role: 'user', quote: 'x'.repeat(TASK_STATE_REPORT_SOURCE_QUOTE_MAX_CHARS + 1) }],
                },
            }),
        ).toEqual({ state: 'incomplete', reason: 'oversized-input' });
        const large = {
            ...REPORT,
            objective: {
                text: '🦉'.repeat(TASK_STATE_REPORT_ITEM_MAX_CHARS / 2),
                sources: [{ role: 'user', quote: '🦉'.repeat(TASK_STATE_REPORT_SOURCE_QUOTE_MAX_CHARS / 2) }],
            },
            decisions: Array.from({ length: TASK_STATE_REPORT_LIST_MAX_ITEMS }, () => ({
                text: '🦉'.repeat(TASK_STATE_REPORT_ITEM_MAX_CHARS / 2),
                sources: Array.from({ length: TASK_STATE_REPORT_SOURCE_MAX_ITEMS }, () => ({
                    role: 'user',
                    quote: '🦉'.repeat(TASK_STATE_REPORT_SOURCE_QUOTE_MAX_CHARS / 2),
                })),
            })),
            constraints: Array.from({ length: TASK_STATE_REPORT_LIST_MAX_ITEMS }, () => ({
                text: '🦉'.repeat(TASK_STATE_REPORT_ITEM_MAX_CHARS / 2),
                sources: Array.from({ length: TASK_STATE_REPORT_SOURCE_MAX_ITEMS }, () => ({
                    role: 'user',
                    quote: '🦉'.repeat(TASK_STATE_REPORT_SOURCE_QUOTE_MAX_CHARS / 2),
                })),
            })),
            pending_items: [],
        };
        expect(Buffer.byteLength(JSON.stringify(large))).toBeGreaterThan(TASK_STATE_REPORT_INPUT_MAX_BYTES);
        expect(parseTaskStateReportInput(large)).toEqual({ state: 'incomplete', reason: 'oversized-input' });
    });

    it('compares source roles and quotes in duplicate envelopes', () => {
        const original = parseTaskStateReportInput(REPORT);
        const changedQuote = parseTaskStateReportInput({
            ...REPORT,
            objective: { ...REPORT.objective, sources: [{ role: 'user', quote: 'A different user turn.' }] },
        });
        const changedRole = parseTaskStateReportInput({
            ...REPORT,
            objective: { ...REPORT.objective, sources: [{ role: 'assistant', quote: PROMPT }] },
        });
        expect(original.state).toBe('complete');
        expect(changedQuote.state).toBe('complete');
        expect(changedRole.state).toBe('complete');
        if (original.state === 'complete' && changedQuote.state === 'complete' && changedRole.state === 'complete') {
            expect(sameTaskStateReportInput(original.input, changedQuote.input)).toBe(false);
            expect(sameTaskStateReportInput(original.input, changedRole.input)).toBe(false);
        }
    });
});

function codexLine(second: number, type: string, payload: unknown): unknown {
    return { timestamp: `2026-09-28T00:00:${String(second).padStart(2, '0')}.000Z`, type, payload };
}

function codexReportCall(callId: string, args: string): unknown {
    return codexLine(4, 'response_item', {
        type: 'function_call',
        namespace: 'mcp__elepha',
        name: 'report_task_state',
        arguments: args,
        call_id: callId,
    });
}

function codexReportOutput(callId: string, output: unknown = TASK_STATE_REPORT_ACK): unknown {
    return codexLine(5, 'response_item', { type: 'function_call_output', call_id: callId, output });
}

function codexDesktopReport(): unknown {
    return codexLine(4, 'event_msg', {
        type: 'item_completed',
        item: {
            type: 'McpToolCall',
            id: 'report-1',
            server: 'elepha',
            tool: 'report_task_state',
            arguments: REPORT,
            status: 'completed',
            result: { content: [{ type: 'text', text: TASK_STATE_REPORT_ACK }] },
            duration: { secs: 0, nanos: 5 },
        },
    });
}

function codexHead(originator: string): unknown[] {
    return [
        codexLine(0, 'session_meta', { id: '019fa000-0000-7000-8000-000000000321', cwd, originator }),
        codexLine(0, 'response_item', { type: 'message', role: 'user', content: [{ type: 'input_text', text: PROMPT }] }),
    ];
}

function codexAssistant(second: number, text: string): unknown {
    return codexLine(second, 'response_item', { type: 'message', role: 'assistant', content: [{ type: 'output_text', text }] });
}

// CLI rollout: user text, an ordinary exec_command pair, the report pair,
// and the assistant's closing text.
function codexCliComposite(): unknown[] {
    return [
        ...codexHead('codex-tui'),
        codexLine(1, 'response_item', {
            type: 'function_call',
            name: 'exec_command',
            arguments: JSON.stringify({ cmd: 'npm run typecheck' }),
            call_id: 'exec-1',
        }),
        codexLine(2, 'response_item', { type: 'function_call_output', call_id: 'exec-1', output: 'ok' }),
        codexReportCall('report-1', JSON.stringify(REPORT)),
        codexReportOutput('report-1'),
        codexAssistant(6, 'The parser slice is in place.'),
    ];
}

// Desktop rollout: the MCP call is dispatched through a custom exec call and
// completed as one McpToolCall item carrying both input and result.
function codexDesktopComposite(): unknown[] {
    return [
        ...codexHead('Codex Desktop'),
        codexLine(1, 'response_item', { type: 'custom_tool_call', name: 'exec', input: '{}', call_id: 'outer-exec-call' }),
        codexDesktopReport(),
        codexLine(5, 'response_item', { type: 'custom_tool_call_output', call_id: 'outer-exec-call', output: 'outer transport output' }),
        codexAssistant(6, 'The parser slice is in place.'),
    ];
}

async function parseCodex(lines: unknown[]): Promise<ParsedTurn[]> {
    const adapter = new CodexAdapter(() => {});
    return collect(adapter.parseTurns(fixture('rollout-report.jsonl', lines), undefined, { closeTrailingOnIdle: true }));
}

function expectOrdinaryCodexWork(turn: ParsedTurn | undefined, toolNames: string[]): void {
    expect(turn?.droppedReason).toBeUndefined();
    expect(turn?.userMessage).toBe(PROMPT);
    expect(turn?.assistantText).toBe('The parser slice is in place.');
    expect(turn?.toolCalls.map((call) => call.name)).toEqual(toolNames);
}

describe('Codex CLI task-state report', () => {
    it('keeps a report-only turn when the next user boundary arrives', async () => {
        const lines = [
            codexLine(0, 'session_meta', { id: '019fa000-0000-7000-8000-000000000321', cwd, originator: 'codex-tui' }),
            codexLine(0, 'response_item', { type: 'message', role: 'user', content: [] }),
            codexReportCall('report-1', JSON.stringify(REPORT)),
            codexReportOutput('report-1'),
            codexLine(7, 'response_item', { type: 'message', role: 'user', content: [{ type: 'input_text', text: 'Next request' }] }),
            codexAssistant(8, 'Next answer'),
        ];
        const turns = await parseCodex(lines);

        expect(turns).toHaveLength(2);
        expect(turns[0]).toMatchObject({ userMessage: '', assistantText: '', toolCalls: [], taskStateReport: EXPECTED_REPORT });
        expect(turns[0]?.droppedReason).toBeUndefined();
        expect(turns[1]?.userMessage).toBe('Next request');
        expect(turns[1]?.taskStateReport).toBeUndefined();
    });

    it('closes a complete report-only turn at an idle EOF', async () => {
        const lines = [
            codexLine(0, 'session_meta', { id: '019fa000-0000-7000-8000-000000000321', cwd, originator: 'codex-tui' }),
            codexLine(0, 'response_item', { type: 'message', role: 'user', content: [] }),
            codexReportCall('report-1', JSON.stringify(REPORT)),
            codexReportOutput('report-1'),
        ];
        const turns = await parseCodex(lines);

        expect(turns).toHaveLength(1);
        expect(turns[0]).toMatchObject({ userMessage: '', assistantText: '', toolCalls: [], taskStateReport: EXPECTED_REPORT });
        expect(turns[0]?.droppedReason).toBeUndefined();
    });

    it('drops a report-only turn whose input contains the Rule 4 sentinel', async () => {
        const report = { ...REPORT, objective: { text: open('brief', '01JTEST'), sources: [SOURCE] } };
        const turns = await parseCodex([
            codexLine(0, 'session_meta', { id: '019fa000-0000-7000-8000-000000000321', cwd, originator: 'codex-tui' }),
            codexLine(0, 'response_item', { type: 'message', role: 'user', content: [] }),
            codexReportCall('report-1', JSON.stringify(report)),
            codexReportOutput('report-1'),
        ]);

        expect(turns).toHaveLength(1);
        expect(turns[0]).toMatchObject({ droppedReason: 'sentinel', userMessage: '', assistantText: '', toolCalls: [] });
        expect(turns[0]?.taskStateReport).toBeUndefined();
    });

    it('keeps the ordinary turn, excludes the report from toolCalls, and captures the report', async () => {
        const turns = await parseCodex(codexCliComposite());

        expect(turns).toHaveLength(1);
        expectOrdinaryCodexWork(turns[0], ['exec_command']);
        expect(turns[0]?.taskStateReport).toEqual(EXPECTED_REPORT);
        expect(turns[0]?.taskStateReportFailure).toBeUndefined();
    });

    it('accepts a JSON-encoded MCP envelope around the acknowledgement', async () => {
        const lines = codexCliComposite();
        lines[5] = codexReportOutput('report-1', JSON.stringify({ content: [{ type: 'text', text: TASK_STATE_REPORT_ACK }] }));
        const turns = await parseCodex(lines);

        expect(turns[0]?.taskStateReport).toEqual(EXPECTED_REPORT);
    });

    it.each([
        { content: [{ type: 'text', text: TASK_STATE_REPORT_ACK }], isError: true },
        { content: [{ type: 'text', text: TASK_STATE_REPORT_ACK }], structuredContent: { private: 'extra' } },
        { content: [{ type: 'text', text: TASK_STATE_REPORT_ACK }], extra: 'unexpected' },
        { content: [{ type: 'text', text: TASK_STATE_REPORT_ACK, extra: true }] },
    ])('rejects a JSON-encoded acknowledgement envelope with extra payload', async (output) => {
        const lines = codexCliComposite();
        lines[5] = codexReportOutput('report-1', JSON.stringify(output));
        const turns = await parseCodex(lines);

        expectOrdinaryCodexWork(turns[0], ['exec_command']);
        expect(turns[0]?.taskStateReportFailure).toBe('unexpected-result');
    });

    it('drops the whole turn, report included, when it also calls a generic elepha tool', async () => {
        const lines = codexCliComposite();
        lines.splice(
            4,
            0,
            codexLine(3, 'response_item', {
                type: 'function_call',
                namespace: 'mcp__elepha',
                name: 'recall',
                arguments: '{"query":"parser"}',
                call_id: 'recall-1',
            }),
            codexLine(3, 'response_item', { type: 'function_call_output', call_id: 'recall-1', output: 'served elepha memory' }),
        );
        const turns = await parseCodex(lines);

        expect(turns[0]).toMatchObject({ droppedReason: 'elepha-mcp', userMessage: '', assistantText: '', toolCalls: [] });
        expect(turns[0]?.taskStateReport).toBeUndefined();
    });

    it('drops an oversized raw argument string before decoding it', async () => {
        const lines = codexCliComposite();
        lines[4] = codexReportCall('report-1', `${' '.repeat(TASK_STATE_REPORT_INPUT_MAX_BYTES)}${JSON.stringify(REPORT)}`);
        const turns = await parseCodex(lines);

        expect(turns[0]?.droppedReason).toBe('report-input-unscanned');
        expect(turns[0]?.taskStateReport).toBeUndefined();
    });

    it('drops an oversized JSON-encoded argument carrying a Unicode-escaped sentinel', async () => {
        const escaped = JSON.stringify({ ...REPORT, extra: open('brief', '01JTEST') }).replace('[[elepha:', '\\u005b\\u005belepha:');
        const lines = codexCliComposite();
        lines[4] = codexReportCall('report-1', `${' '.repeat(TASK_STATE_REPORT_INPUT_MAX_BYTES)}${escaped}`);
        const turns = await parseCodex(lines);

        expect(turns[0]?.droppedReason).toBe('report-input-unscanned');
    });

    it('detects a Unicode-escaped sentinel in a bounded JSON-encoded argument', async () => {
        const escaped = JSON.stringify({ ...REPORT, extra: open('brief', '01JTEST') }).replace('[[elepha:', '\\u005b\\u005belepha:');
        const lines = codexCliComposite();
        lines[4] = codexReportCall('report-1', escaped);
        const turns = await parseCodex(lines);

        expect(turns[0]?.droppedReason).toBe('sentinel');
    });

    it('withholds a report whose acknowledgement never arrives and keeps the ordinary work', async () => {
        const lines = codexCliComposite();
        lines.splice(5, 1);
        lines.push(
            codexLine(7, 'response_item', { type: 'message', role: 'user', content: [{ type: 'input_text', text: 'Next request' }] }),
            codexAssistant(8, 'Next answer'),
        );
        const turns = await parseCodex(lines);

        expect(turns).toHaveLength(2);
        expectOrdinaryCodexWork(turns[0], ['exec_command']);
        expect(turns[0]?.taskStateReportFailure).toBe('missing-result');
        expect(turns[1]?.taskStateReportFailure).toBeUndefined();
    });
});

describe('Codex Desktop task-state report', () => {
    it('keeps the ordinary turn and captures the report from the McpToolCall item', async () => {
        const turns = await parseCodex(codexDesktopComposite());

        expect(turns).toHaveLength(1);
        expectOrdinaryCodexWork(turns[0], ['exec']);
        expect(turns[0]?.taskStateReport).toEqual(EXPECTED_REPORT);
    });

    it.each([
        { content: [{ type: 'text', text: TASK_STATE_REPORT_ACK }], isError: true },
        { content: [{ type: 'text', text: TASK_STATE_REPORT_ACK }], structuredContent: { private: 'extra' } },
        { content: [{ type: 'text', text: TASK_STATE_REPORT_ACK }], extra: 'unexpected' },
    ])('rejects a Desktop acknowledgement with extra result data', async (result) => {
        const lines = codexDesktopComposite();
        (lines[3] as { payload: { item: { result: unknown } } }).payload.item.result = result;
        const turns = await parseCodex(lines);

        expectOrdinaryCodexWork(turns[0], ['exec']);
        expect(turns[0]?.taskStateReportFailure).toBe('unexpected-result');
    });

    it('accepts matching CLI and Desktop envelopes of the same call', async () => {
        const lines = codexDesktopComposite();
        lines.splice(3, 0, codexReportCall('report-1', JSON.stringify(REPORT)));
        lines.splice(5, 0, codexReportOutput('report-1', [{ type: 'text', text: TASK_STATE_REPORT_ACK }]));
        const turns = await parseCodex(lines);

        expectOrdinaryCodexWork(turns[0], ['exec']);
        expect(turns[0]?.taskStateReport).toEqual(EXPECTED_REPORT);
    });

    it('withholds the report when CLI and Desktop envelopes disagree', async () => {
        const lines = codexDesktopComposite();
        lines.splice(
            3,
            0,
            codexReportCall('report-1', JSON.stringify({ ...REPORT, objective: { ...REPORT.objective, text: 'Different.' } })),
        );
        lines.splice(5, 0, codexReportOutput('report-1'));
        const turns = await parseCodex(lines);

        expectOrdinaryCodexWork(turns[0], ['exec']);
        expect(turns[0]?.taskStateReport).toBeUndefined();
        expect(turns[0]?.taskStateReportFailure).toBe('conflicting-duplicate');
    });

    it('withholds the report when the CLI envelope never records its result', async () => {
        const lines = codexDesktopComposite();
        lines.splice(3, 0, codexReportCall('report-1', JSON.stringify(REPORT)));
        // The unanswered CLI call keeps the turn open until the next boundary.
        lines.push(
            codexLine(7, 'response_item', { type: 'message', role: 'user', content: [{ type: 'input_text', text: 'Next request' }] }),
            codexAssistant(8, 'Next answer'),
        );
        const turns = await parseCodex(lines);

        expect(turns).toHaveLength(2);
        expectOrdinaryCodexWork(turns[0], ['exec']);
        expect(turns[0]?.taskStateReportFailure).toBe('missing-result');
    });

    it('withholds the report when the Desktop item did not complete', async () => {
        const lines = codexDesktopComposite();
        const item = (lines[3] as { payload: { item: { status: string } } }).payload.item;
        item.status = 'failed';
        const turns = await parseCodex(lines);

        expectOrdinaryCodexWork(turns[0], ['exec']);
        expect(turns[0]?.taskStateReportFailure).toBe('unexpected-result');
    });

    it('drops the whole turn when a Desktop generic elepha item is also present', async () => {
        const lines = codexDesktopComposite();
        lines.splice(
            3,
            0,
            codexLine(3, 'event_msg', {
                type: 'item_completed',
                item: {
                    type: 'McpToolCall',
                    id: 'recall-1',
                    server: 'elepha',
                    tool: 'recall',
                    arguments: { query: 'parser' },
                    status: 'completed',
                    result: { content: [{ type: 'text', text: 'served elepha memory' }] },
                },
            }),
        );
        const turns = await parseCodex(lines);

        expect(turns[0]).toMatchObject({ droppedReason: 'elepha-mcp', userMessage: '', toolCalls: [] });
        expect(turns[0]?.taskStateReport).toBeUndefined();
    });
});
