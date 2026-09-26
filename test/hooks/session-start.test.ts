import { readFileSync } from 'node:fs';
import path from 'node:path';
import { describe, expect, it, vi } from 'vitest';
import { HOOK_WATCHDOG_TIMEOUT_MS, PACKAGE_VERSION } from '../../src/config/constants.js';
import {
    envelope,
    handleWatchdogTimeout,
    parsePayload,
    runSessionStart,
    type SessionStartDependencies,
} from '../../src/hooks/session-start.js';
import { CLOSE, OPEN } from '../../src/security/sentinel.js';
import { openUnmanagedDb } from '../../src/storage/db.js';
import { createTestDb } from '../helpers/db.js';

const NOW = Date.parse('2026-09-08T00:00:00.000Z');
const HEALTH_WARNING = '⚠ elepha: capture may be stalled — daemon heartbeat is stale. → Run (Terminal): elepha doctor';
const UPDATE_NOTICE = '⬆ elepha 99.0.0 available — → Run (Terminal): elepha self-update';

function emptyDbPath(): string {
    const fixture = createTestDb('elepha-session-start-');
    fixture.close();
    return fixture.dbPath;
}

function sessionStartPayload(source: 'startup' | 'clear' | 'resume' | 'compact' = 'startup', sessionId = 'native-session'): string {
    return JSON.stringify({
        session_id: sessionId,
        cwd: process.cwd(),
        hook_event_name: 'SessionStart',
        source,
        model: 'gpt-5.6',
        permission_mode: 'default',
    });
}

function hookText(result: Awaited<ReturnType<typeof runSessionStart>>): string | undefined {
    if (!('output' in result)) return undefined;
    expect(result.output.hookSpecificOutput).not.toHaveProperty('additionalContext');
    const value = result.output.systemMessage;
    return typeof value === 'string' ? value : undefined;
}

function innerBody(output: string): string {
    expect(output).toMatch(/^\[\[elepha:notify:[0-9A-Z]{26}]]\n/);
    expect(output.endsWith(`\n${CLOSE}`)).toBe(true);
    return output.split('\n').slice(1, -1).join('\n');
}

const NO_NOTICE: Pick<SessionStartDependencies, 'daemonHealth' | 'readUpdateAvailable'> = {
    daemonHealth: () => ({ state: 'RUNNING', healthy: true }),
    readUpdateAvailable: () => undefined,
};

describe('SessionStart operational notices', () => {
    it('validates every installed source and preserves both envelope contracts', () => {
        const fixtures = {
            'claude-code': JSON.parse(
                readFileSync(path.resolve(__dirname, '..', 'fixtures', 'hooks', 'claude-session-start.json'), 'utf8'),
            ),
            codex: JSON.parse(readFileSync(path.resolve(__dirname, '..', 'fixtures', 'hooks', 'codex-session-start.json'), 'utf8')),
        };
        for (const source of ['startup', 'clear', 'resume', 'compact'] as const) {
            expect(parsePayload(JSON.stringify({ ...fixtures['claude-code'], source }), 'claude-code')).toMatchObject({ source });
            expect(parsePayload(JSON.stringify({ ...fixtures.codex, source }), 'codex')).toMatchObject({ source });
        }
        expect(parsePayload('{}', 'claude-code')).toBeUndefined();
        expect(parsePayload(JSON.stringify({ ...fixtures['claude-code'], source: 'fork' }), 'claude-code')).toMatchObject({
            source: 'fork',
        });
        expect(parsePayload(JSON.stringify({ ...fixtures.codex, source: 'fork' }), 'codex')).toBeUndefined();
        expect(envelope('claude-code', { additionalContext: 'body' })).toEqual({
            hookSpecificOutput: { hookEventName: 'SessionStart', additionalContext: 'body' },
        });
        expect(envelope('codex', { additionalContext: 'body' })).toEqual({
            continue: true,
            hookSpecificOutput: { hookEventName: 'SessionStart', additionalContext: 'body' },
            stopReason: null,
            suppressOutput: false,
        });
        expect(envelope('claude-code', { systemMessage: 'body' })).toEqual({
            hookSpecificOutput: { hookEventName: 'SessionStart' },
            systemMessage: 'body',
        });
        expect(envelope('codex', { systemMessage: 'body' })).toEqual({
            continue: true,
            hookSpecificOutput: { hookEventName: 'SessionStart' },
            stopReason: null,
            suppressOutput: false,
            systemMessage: 'body',
        });
    });

    it('rejects missing and wrong-typed required stdin fields without an output envelope', () => {
        const valid = {
            session_id: 's',
            cwd: '/project',
            hook_event_name: 'SessionStart',
            source: 'startup',
            model: 'gpt-5.6',
            permission_mode: 'default',
        };
        expect(parsePayload(JSON.stringify({ ...valid, session_id: 1 }), 'codex')).toBeUndefined();
        expect(parsePayload(JSON.stringify({ ...valid, cwd: null }), 'codex')).toBeUndefined();
        expect(parsePayload(JSON.stringify({ ...valid, hook_event_name: 'Stop' }), 'codex')).toBeUndefined();
        expect(parsePayload(JSON.stringify({ ...valid, source: 'other' }), 'codex')).toBeUndefined();
        expect(parsePayload(JSON.stringify({ ...valid, model: null }), 'codex')).toBeUndefined();
        expect(parsePayload(JSON.stringify({ ...valid, permission_mode: 'unsafe' }), 'codex')).toBeUndefined();
        for (const tool of ['claude-code', 'codex'] as const) {
            expect(parsePayload(JSON.stringify({ ...valid, agent_id: 'agent-child', agent_type: 'Explore' }), tool)).toMatchObject({
                agent_id: 'agent-child',
                agent_type: 'Explore',
            });
            for (const field of ['agent_id', 'agent_type'] as const) {
                for (const value of [null, 7, '', ' ']) {
                    expect(parsePayload(JSON.stringify({ ...valid, [field]: value }), tool)).toBeUndefined();
                }
            }
        }
        expect(parsePayload(JSON.stringify({ ...valid, agent_type: 'custom-main-agent' }), 'claude-code')).toMatchObject({
            agent_type: 'custom-main-agent',
        });
    });

    it('opens the database to discover rules even when no operational notice applies', async () => {
        const openDatabase = vi.fn(async (dbPath: string) => openUnmanagedDb(dbPath));

        for (const source of ['startup', 'clear', 'resume', 'compact'] as const) {
            await expect(
                runSessionStart(sessionStartPayload(source), 'codex', {
                    ...NO_NOTICE,
                    dbPath: emptyDbPath(),
                    openDatabase: openDatabase as unknown as SessionStartDependencies['openDatabase'],
                }),
            ).resolves.toEqual({
                reason: 'no_notice',
            });
        }

        expect(openDatabase).toHaveBeenCalledTimes(4);
    });

    it('emits only the daemon-health warning on every source and never an auto-brief or status line', async () => {
        for (const source of ['startup', 'clear', 'resume', 'compact'] as const) {
            const result = await runSessionStart(sessionStartPayload(source), 'codex', {
                dbPath: emptyDbPath(),
                now: () => NOW,
                daemonHealth: () => ({ state: 'STUCK', healthy: false }),
                readUpdateAvailable: () => undefined,
                writeInjection: () => true,
            });
            const output = hookText(result);
            expect(output).toBeDefined();
            expect(innerBody(output ?? '')).toBe(HEALTH_WARNING);
            expect(output).not.toContain(`${OPEN}brief:`);
            expect(output).not.toContain('🐘 elepha');
            expect(output).not.toContain('[[elepha-data ');
        }
    });

    it('emits only the update notice through systemMessage and records its exact body for both tools', async () => {
        for (const tool of ['claude-code', 'codex'] as const) {
            const dbPath = emptyDbPath();
            const result = await runSessionStart(sessionStartPayload('startup', `native-${tool}`), tool, {
                dbPath,
                now: () => NOW,
                daemonHealth: () => ({ state: 'RUNNING', healthy: true }),
                readUpdateAvailable: () => ({ version: '99.0.0', checkedAt: '2026-09-08T00:00:00.000Z' }),
            });
            const output = hookText(result);
            expect(output).toBeDefined();
            expect(innerBody(output ?? '')).toBe(UPDATE_NOTICE);

            const db = openUnmanagedDb(dbPath);
            const injection = db
                .prepare('SELECT body FROM injections WHERE tool = ? AND native_session_id = ?')
                .get(tool, `native-${tool}`) as { body: string };
            db.close();
            expect(injection.body).toBe(UPDATE_NOTICE);
        }
    });

    it('composes update and daemon-health notices without any brief content', async () => {
        const result = await runSessionStart(sessionStartPayload('resume'), 'codex', {
            dbPath: emptyDbPath(),
            now: () => NOW,
            daemonHealth: () => ({ state: 'NOT RUNNING', healthy: false }),
            readUpdateAvailable: () => ({ version: '99.0.0', checkedAt: '2026-09-08T00:00:00.000Z' }),
            writeInjection: () => true,
        });
        const output = hookText(result);
        expect(output).toBeDefined();
        expect(innerBody(output ?? '')).toBe(
            `${UPDATE_NOTICE}\n⚠ elepha: capture is paused — daemon not running. → Run (Terminal): elepha doctor`,
        );
        expect(output).not.toContain(`${OPEN}brief:`);
    });

    it('fails open to no_notice when notice probes throw or name the running version', async () => {
        await expect(
            runSessionStart(sessionStartPayload(), 'codex', {
                dbPath: emptyDbPath(),
                daemonHealth: () => {
                    throw new Error('heartbeat unreadable');
                },
                readUpdateAvailable: () => {
                    throw new Error('marker unreadable');
                },
            }),
        ).resolves.toEqual({ reason: 'no_notice' });
        await expect(
            runSessionStart(sessionStartPayload(), 'codex', {
                dbPath: emptyDbPath(),
                daemonHealth: () => ({ state: 'RUNNING', healthy: true }),
                readUpdateAvailable: () => ({ version: PACKAGE_VERSION, checkedAt: '2026-09-08T00:00:00.000Z' }),
            }),
        ).resolves.toEqual({ reason: 'no_notice' });
    });

    it('returns distinct failures when a notice cannot be recorded', async () => {
        const missing = path.join(process.cwd(), 'test', '.tmp', `missing-session-start-${Date.now()}.db`);
        await expect(
            runSessionStart(sessionStartPayload(), 'codex', {
                dbPath: missing,
                daemonHealth: () => ({ state: 'STUCK', healthy: false }),
                readUpdateAvailable: () => undefined,
            }),
        ).resolves.toEqual({ reason: 'database_unavailable' });

        const log: string[] = [];
        await expect(
            runSessionStart(sessionStartPayload(), 'claude-code', {
                dbPath: emptyDbPath(),
                daemonHealth: () => ({ state: 'STUCK', healthy: false }),
                readUpdateAvailable: () => undefined,
                writeInjection: () => false,
                log: (line) => log.push(line),
            }),
        ).resolves.toEqual({ reason: 'injection_record_failed' });
        expect(log).toEqual(['session-start claude-code source=startup session_id=native-session: failed reason=injection_record_failed']);
    });

    it('logs the watchdog timeout before exiting successfully without stdout', () => {
        const log: string[] = [];
        const exits: number[] = [];
        handleWatchdogTimeout(
            'claude-code',
            (line) => log.push(line),
            (code) => exits.push(code),
        );
        expect(log).toEqual([
            `session-start claude-code source=unknown session_id=unknown: watchdog timeout after ${HOOK_WATCHDOG_TIMEOUT_MS}ms`,
        ]);
        expect(exits).toEqual([0]);
    });
});
