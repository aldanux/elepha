import { mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { describe, expect, it, vi } from 'vitest';
import { ClaudeCodeAdapter } from '../../src/adapters/claude-code.js';
import { CodexAdapter } from '../../src/adapters/codex.js';
import { MAX_UNKNOWN_LINE_DISCRIMINATOR_CHARS } from '../../src/config/constants.js';
import { deduplicateDaemonUnknownLineWarnings } from '../../src/daemon/index.js';
import type { ParsedTurn } from '../../src/types/index.js';

async function drain(iter: AsyncIterable<ParsedTurn>): Promise<void> {
    for await (const _ of iter) void _;
}

async function collect(iter: AsyncIterable<ParsedTurn>): Promise<ParsedTurn[]> {
    const turns: ParsedTurn[] = [];
    for await (const turn of iter) turns.push(turn);
    return turns;
}

function tmpFile(name: string): string {
    const dir = mkdtempSync(path.join(tmpdir(), 'elepha-unknown-'));
    return path.join(dir, name);
}

describe('unrecognized line shapes are loud, not silently skipped', () => {
    it('ClaudeCodeAdapter warns on a top-level type outside its known-skip set', async () => {
        const warn = vi.fn();
        const adapter = new ClaudeCodeAdapter(warn);
        const file = tmpFile('session.jsonl');
        writeFileSync(
            file,
            `${JSON.stringify({ type: 'totally-new-line-type', sessionId: 'sid', cwd: '/x', timestamp: '2026-08-01T00:00:00.000Z' })}\n${JSON.stringify(
                { type: 'user', cwd: '/x', timestamp: '2026-08-01T00:00:01.000Z', message: { role: 'user', content: 'hi' } },
            )}\n`,
        );

        await drain(adapter.parseTurns(file, undefined, { closeTrailingOnIdle: false }));

        expect(warn).toHaveBeenCalledTimes(1);
        expect(warn.mock.calls[0]![0]).toContain('totally-new-line-type');
        expect(warn.mock.calls[0]![0]).toContain(file);
    });

    it('ClaudeCodeAdapter does not warn on any of its known-skip types', async () => {
        const warn = vi.fn();
        const adapter = new ClaudeCodeAdapter(warn);
        const file = tmpFile('session.jsonl');
        const knownSkipTypes = [
            'mode',
            'permission-mode',
            'attachment',
            'file-history-snapshot',
            'file-history-delta',
            'last-prompt',
            'ai-title',
            'system',
            'agent-name',
            'queue-operation',
            'pr-link',
            'fork-context-ref',
        ];
        const lines = knownSkipTypes.map((type) =>
            JSON.stringify({ type, sessionId: 'sid', cwd: '/x', timestamp: '2026-08-01T00:00:00.000Z' }),
        );
        writeFileSync(file, `${lines.join('\n')}\n`);

        await drain(adapter.parseTurns(file, undefined, { closeTrailingOnIdle: true }));

        expect(warn).not.toHaveBeenCalled();
    });

    it('ClaudeCodeAdapter silently skips atis-latch without producing a turn or content', async () => {
        const warn = vi.fn();
        const adapter = new ClaudeCodeAdapter(warn);
        const file = tmpFile('session.jsonl');
        writeFileSync(file, `${JSON.stringify({ type: 'atis-latch', atis: '', sessionId: 'sid' })}\n`);

        const turns = await collect(adapter.parseTurns(file, undefined, { closeTrailingOnIdle: true }));

        expect(warn).not.toHaveBeenCalled();
        expect(turns).toEqual([]);
    });

    it('ClaudeCodeAdapter silently skips bridge-session metadata without producing a turn or content', async () => {
        const warn = vi.fn();
        const adapter = new ClaudeCodeAdapter(warn);
        const file = tmpFile('session.jsonl');
        writeFileSync(
            file,
            `${JSON.stringify({
                type: 'bridge-session',
                bridgeSessionId: 'bridge-id',
                sessionId: 'session-id',
                lastSequenceNum: 35,
                ownerAccountUuid: 'account-id',
                ownerOrganizationUuid: 'organization-id',
            })}\n`,
        );

        const turns = await collect(adapter.parseTurns(file, undefined, { closeTrailingOnIdle: true }));

        expect(warn).not.toHaveBeenCalled();
        expect(turns).toEqual([]);
    });

    it('CodexAdapter warns on an unrecognized top-level type, event_msg subtype, and response_item subtype', async () => {
        const warn = vi.fn();
        const adapter = new CodexAdapter(warn);
        const file = tmpFile('rollout-2026-08-01T00-00-00-00000000-0000-0000-0000-000000000000.jsonl');
        const lines = [
            { timestamp: '2026-08-01T00:00:00.000Z', type: 'brand-new-top-level-type', payload: {} },
            { timestamp: '2026-08-01T00:00:01.000Z', type: 'event_msg', payload: { type: 'brand-new-event-subtype' } },
            { timestamp: '2026-08-01T00:00:02.000Z', type: 'response_item', payload: { type: 'brand-new-response-item-subtype' } },
        ];
        writeFileSync(file, `${lines.map((l) => JSON.stringify(l)).join('\n')}\n`);

        await drain(adapter.parseTurns(file, undefined, { closeTrailingOnIdle: true }));

        expect(warn).toHaveBeenCalledTimes(3);
        const messages = warn.mock.calls.map((c) => c[0] as string);
        expect(messages.some((m) => m.includes('brand-new-top-level-type'))).toBe(true);
        expect(messages.some((m) => m.includes('brand-new-event-subtype'))).toBe(true);
        expect(messages.some((m) => m.includes('brand-new-response-item-subtype'))).toBe(true);
    });

    it('bounds and sanitizes untrusted discriminators before daemon warning deduplication', async () => {
        const warn = vi.fn();
        const daemonWarn = deduplicateDaemonUnknownLineWarnings(warn);
        const sharedPrefix = `attacker\n\u0000\u001b${'x'.repeat(MAX_UNKNOWN_LINE_DISCRIMINATOR_CHARS * 2)}`;
        const claudeType = `${sharedPrefix}-claude`;
        const eventType = `${sharedPrefix}-event`;
        const responseType = { secret: 'must-not-reach-the-log' };
        const topLevelType = `${sharedPrefix}-top-level`;
        const claudeFile = tmpFile('session.jsonl');
        const codexFile = tmpFile('rollout-2026-08-01T00-00-00-00000000-0000-0000-0000-000000000002.jsonl');

        writeFileSync(claudeFile, `${JSON.stringify({ type: claudeType })}\n${JSON.stringify({ type: claudeType })}\n`);
        writeFileSync(
            codexFile,
            `${[
                { type: 'event_msg', payload: { type: eventType } },
                { type: 'response_item', payload: { type: responseType } },
                { type: topLevelType, payload: {} },
            ]
                .map((line) => JSON.stringify(line))
                .join('\n')}\n`,
        );

        await drain(new ClaudeCodeAdapter(daemonWarn).parseTurns(claudeFile, undefined, { closeTrailingOnIdle: true }));
        await drain(new CodexAdapter(daemonWarn).parseTurns(codexFile, undefined, { closeTrailingOnIdle: true }));

        expect(warn).toHaveBeenCalledTimes(4);
        const messages = warn.mock.calls.map(([message]) => message as string);
        const renderedDiscriminators = messages.map((message) => message.match(/"(.*)" in /)?.[1]);
        expect(renderedDiscriminators).not.toContain(undefined);
        expect(new Set(renderedDiscriminators)).toHaveLength(4);
        const longDiscriminators = [renderedDiscriminators[0]!, renderedDiscriminators[1]!, renderedDiscriminators[3]!];
        expect(new Set(longDiscriminators.map((discriminator) => discriminator.slice(0, -8)))).toHaveLength(1);
        expect(new Set(longDiscriminators)).toHaveLength(3);
        expect(renderedDiscriminators[2]).toMatch(/^object…#[0-9a-f]{8}$/);
        for (const discriminator of renderedDiscriminators as string[]) {
            expect([...discriminator].length).toBeLessThanOrEqual(MAX_UNKNOWN_LINE_DISCRIMINATOR_CHARS);
            expect(discriminator).toMatch(/…#[0-9a-f]{8}$/);
            expect(discriminator).not.toMatch(/[\p{Cc}\u2028\u2029]/u);
        }
        expect(messages.join('\n')).not.toContain('must-not-reach-the-log');
    });

    it('CodexAdapter does not warn on any of its known-skip subtypes', async () => {
        const warn = vi.fn();
        const adapter = new CodexAdapter(warn);
        const file = tmpFile('rollout-2026-08-01T00-00-00-00000000-0000-0000-0000-000000000001.jsonl');
        const lines = [
            { timestamp: '2026-08-01T00:00:00.000Z', type: 'session_meta', payload: { cwd: '/x' } },
            { timestamp: '2026-08-01T00:00:01.000Z', type: 'turn_context', payload: { cwd: '/x' } },
            { timestamp: '2026-08-01T00:00:02.000Z', type: 'world_state', payload: {} },
            { timestamp: '2026-08-01T00:00:03.000Z', type: 'compacted', payload: {} },
            { timestamp: '2026-08-01T00:00:04.000Z', type: 'inter_agent_communication_metadata', payload: {} },
            { timestamp: '2026-08-01T00:00:05.000Z', type: 'event_msg', payload: { type: 'token_count' } },
            { timestamp: '2026-08-01T00:00:06.000Z', type: 'event_msg', payload: { type: 'agent_message' } },
            { timestamp: '2026-08-01T00:00:07.000Z', type: 'event_msg', payload: { type: 'task_started' } },
            { timestamp: '2026-08-01T00:00:08.000Z', type: 'response_item', payload: { type: 'reasoning' } },
            { timestamp: '2026-08-01T00:00:09.000Z', type: 'response_item', payload: { type: 'custom_tool_call_output' } },
            { timestamp: '2026-08-01T00:00:09.500Z', type: 'response_item', payload: { type: 'agent_message' } },
            { timestamp: '2026-08-01T00:00:10.000Z', type: 'response_item', payload: { type: 'function_call_output' } },
            { timestamp: '2026-08-01T00:00:11.000Z', type: 'response_item', payload: { type: 'message', role: 'user' } },
            { timestamp: '2026-08-01T00:00:12.000Z', type: 'response_item', payload: { type: 'message', role: 'developer' } },
        ];
        writeFileSync(file, `${lines.map((l) => JSON.stringify(l)).join('\n')}\n`);

        await drain(adapter.parseTurns(file, undefined, { closeTrailingOnIdle: true }));

        expect(warn).not.toHaveBeenCalled();
    });
});
