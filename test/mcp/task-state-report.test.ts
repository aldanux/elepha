import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';
import { describe, expect, it, vi } from 'vitest';
import {
    TASK_STATE_REPORT_ACK,
    TASK_STATE_REPORT_INPUT_MAX_BYTES,
    TASK_STATE_REPORT_ITEM_MAX_CHARS,
    TASK_STATE_REPORT_TOOL,
} from '../../src/config/constants.js';
import { createMcpServerForDatabase } from '../../src/mcp/server.js';
import { createTestDb } from '../helpers/db.js';

const precompact = {
    mode: 'precompact_manifest',
    request_id: '01J00000000000000000000000',
    objective: { text: 'Finish the MCP report tool.', sources: [{ role: 'user', quote: 'Finish the MCP report tool.' }] },
    decisions: [],
    constraints: [],
    pending_items: [],
};
const postcompact = {
    mode: 'postcompact_retained',
    request_id: '01J00000000000000000000000',
    objective: { text: 'Finish the MCP report tool.' },
    decisions: [],
    constraints: [],
    pending_items: [],
};

function responseText(response: unknown): string {
    const content = typeof response === 'object' && response !== null && 'content' in response ? response.content : undefined;
    const first = Array.isArray(content) ? content[0] : undefined;
    return typeof first === 'object' && first !== null && 'text' in first && typeof first.text === 'string' ? first.text : '';
}

describe('report_task_state MCP surface', () => {
    it('advertises both modes and acknowledges only fully valid reports without database work', async () => {
        const fixture = createTestDb('elepha-mcp-task-report-');
        const server = createMcpServerForDatabase(fixture.db);
        const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
        const client = new Client({ name: 'task-report-test', version: '1.0.0' });
        await server.connect(serverTransport);
        await client.connect(clientTransport);
        try {
            const listed = await client.listTools();
            const report = listed.tools.find((tool) => tool.name === TASK_STATE_REPORT_TOOL);
            expect(report).toBeDefined();
            expect(report?.inputSchema).toMatchObject({
                type: 'object',
                additionalProperties: false,
                required: ['mode', 'request_id', 'objective', 'decisions', 'constraints', 'pending_items'],
            });
            expect(report?.inputSchema.properties).toHaveProperty('mode');
            expect(report?.inputSchema.properties).toHaveProperty('objective');

            const prepare = vi.spyOn(fixture.db, 'prepare');
            const exec = vi.spyOn(fixture.db, 'exec');
            const validPrecompact = await client.callTool({ name: TASK_STATE_REPORT_TOOL, arguments: precompact });
            const validPostcompact = await client.callTool({ name: TASK_STATE_REPORT_TOOL, arguments: postcompact });
            for (const response of [validPrecompact, validPostcompact]) {
                expect(response).toEqual({ content: [{ type: 'text', text: TASK_STATE_REPORT_ACK }] });
            }

            const malformed = await client.callTool({
                name: TASK_STATE_REPORT_TOOL,
                arguments: { ...postcompact, objective: null, decisions: [{ text: 'Orphaned decision' }] },
            });
            expect(malformed).toMatchObject({ isError: true });
            expect(responseText(malformed)).toBe('task_state_report_malformed_input');

            const wrongModeItem = await client.callTool({
                name: TASK_STATE_REPORT_TOOL,
                arguments: { ...postcompact, objective: precompact.objective },
            });
            expect(wrongModeItem).toMatchObject({ isError: true });
            expect(responseText(wrongModeItem)).toBe('task_state_report_malformed_input');

            const oversizedItem = await client.callTool({
                name: TASK_STATE_REPORT_TOOL,
                arguments: { ...postcompact, objective: { text: 'x'.repeat(TASK_STATE_REPORT_ITEM_MAX_CHARS + 1) } },
            });
            expect(oversizedItem).toMatchObject({ isError: true });
            expect(responseText(oversizedItem)).toContain(TASK_STATE_REPORT_TOOL);

            const oversizedTotal = await client.callTool({
                name: TASK_STATE_REPORT_TOOL,
                arguments: {
                    ...postcompact,
                    objective: { text: 'x'.repeat(TASK_STATE_REPORT_INPUT_MAX_BYTES + 1) },
                },
            });
            expect(oversizedTotal).toMatchObject({ isError: true });
            expect(responseText(oversizedTotal)).toContain(TASK_STATE_REPORT_TOOL);

            for (const arguments_ of [
                { ...postcompact, unexpected: true },
                { ...postcompact, objective: { ...postcompact.objective, unexpected: true } },
                { ...precompact, objective: { ...precompact.objective, sources: [{ role: 'user', quote: 'evidence', unexpected: true }] } },
            ]) {
                const rejected = await client.callTool({ name: TASK_STATE_REPORT_TOOL, arguments: arguments_ });
                expect(rejected).toMatchObject({ isError: true });
                expect(responseText(rejected)).toContain(TASK_STATE_REPORT_TOOL);
                expect(responseText(rejected)).not.toContain(TASK_STATE_REPORT_ACK);
            }
            expect(prepare).not.toHaveBeenCalled();
            expect(exec).not.toHaveBeenCalled();
        } finally {
            await client.close();
            await server.close();
            fixture.close();
            vi.restoreAllMocks();
        }
    });
});
