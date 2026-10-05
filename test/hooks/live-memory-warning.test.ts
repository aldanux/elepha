import path from 'node:path';
import { describe, expect, it, onTestFinished, vi } from 'vitest';
import {
    LIVE_MEMORY_URGENT_WARNING_BYTES,
    LIVE_MEMORY_WARNING_BYTES,
    LIVE_MEMORY_WARNING_INTERVAL_MS,
} from '../../src/config/live-memory-retention.js';
import { getSetting, setSetting } from '../../src/config/settings.js';
import type { HookSource, HookTool } from '../../src/hooks/common.js';
import { runSessionStart, type SessionStartDependencies } from '../../src/hooks/session-start.js';
import { runUserPromptSubmit } from '../../src/hooks/user-prompt-submit.js';
import { liveMemoryWarningMessage, liveMemoryWarningStatusLine } from '../../src/serving/live-memory-warning.js';
import { openUnmanagedDb } from '../../src/storage/db.js';
import {
    LIVE_MEMORY_WARNING_POLICY,
    LIVE_MEMORY_WARNING_SCHEDULE_TABLE,
    type LiveMemoryWarningBand,
    type LiveMemoryWarningPolicy,
    liveMemoryWarningNextDue,
    RETIRED_LIVE_MEMORY_WARNING_TABLE,
} from '../../src/storage/live-memory-warning.js';
import { createTestDb, seedProject, type TestDatabase } from '../helpers/db.js';

const NOW = Date.parse('2026-09-29T00:00:00.000Z');
const WEEK = LIVE_MEMORY_WARNING_INTERVAL_MS;
const WEEKLY = LIVE_MEMORY_WARNING_BYTES;
const URGENT = LIVE_MEMORY_URGENT_WARNING_BYTES;
const BELOW = LIVE_MEMORY_WARNING_BYTES - 1;
const TOOLS = ['claude-code', 'codex'] as const;

type Result = { output: Record<string, unknown> } | { reason: string };

// An isolated database plus an explicit usage seam: nothing allocates
// gigabytes, and no real ledger is read or altered.
function fixture(seed?: (database: TestDatabase) => void) {
    const db = createTestDb('elepha-live-memory-warning-');
    seed?.(db);
    db.close();
    let usage = WEEKLY;
    const policy: LiveMemoryWarningPolicy = { enabled: true, readUsage: () => usage };
    const openDatabase = vi.fn(async (dbPath: string) => openUnmanagedDb(dbPath));
    const log = vi.fn();
    const inspect = <T>(read: (database: ReturnType<typeof openUnmanagedDb>) => T): T => {
        const database = openUnmanagedDb(db.dbPath);
        try {
            return read(database);
        } finally {
            database.close();
        }
    };
    return {
        ...db,
        policy,
        openDatabase,
        log,
        inspect,
        setUsage(value: number) {
            usage = value;
        },
        open(
            tool: HookTool,
            now: number,
            options: { source?: HookSource; payload?: Record<string, unknown> } & Partial<SessionStartDependencies> = {},
        ) {
            const { source = 'startup', payload = {}, ...extra } = options;
            return runSessionStart(
                JSON.stringify({
                    session_id: `native-${now}`,
                    cwd: process.cwd(),
                    hook_event_name: 'SessionStart',
                    source,
                    ...hostFields(tool),
                    ...payload,
                }),
                tool,
                {
                    dbPath: db.dbPath,
                    openDatabase: openDatabase as unknown as SessionStartDependencies['openDatabase'],
                    log,
                    daemonHealth: () => ({ state: 'RUNNING', healthy: true }),
                    readUpdateAvailable: () => undefined,
                    liveMemoryWarning: policy,
                    now: () => now,
                    ...extra,
                },
            );
        },
        prompt(tool: HookTool, prompt: string, configPath: string) {
            return runUserPromptSubmit(
                JSON.stringify({
                    session_id: 'native-open-chat',
                    cwd: process.cwd(),
                    hook_event_name: 'UserPromptSubmit',
                    prompt,
                    ...hostFields(tool),
                }),
                tool,
                {
                    dbPath: db.dbPath,
                    openDatabase: openDatabase as unknown as SessionStartDependencies['openDatabase'],
                    configPath,
                    log,
                    daemonHealth: () => ({ state: 'RUNNING', healthy: true }),
                    readUpdateAvailable: () => undefined,
                    now: () => NOW,
                },
            );
        },
        status() {
            return inspect((database) => liveMemoryWarningStatusLine(database, policy));
        },
        nextDue() {
            return inspect(liveMemoryWarningNextDue);
        },
    };
}

function hostFields(tool: HookTool): Record<string, unknown> {
    return tool === 'codex' ? { model: 'gpt-5.6', permission_mode: 'default' } : {};
}

function systemMessage(result: Result): string | undefined {
    if (!('output' in result)) return undefined;
    const value = result.output.systemMessage;
    return typeof value === 'string' ? value : undefined;
}

function additionalContext(result: Result): string | undefined {
    if (!('output' in result)) return undefined;
    const hook = result.output.hookSpecificOutput as { additionalContext?: unknown } | undefined;
    return typeof hook?.additionalContext === 'string' ? hook.additionalContext : undefined;
}

// Which band's warning, if any, the result shows the user.
function shown(result: Result, usage: number): LiveMemoryWarningBand | undefined {
    const message = systemMessage(result);
    if (message === undefined) return undefined;
    for (const band of ['weekly', 'urgent'] as const) {
        if (message.includes(liveMemoryWarningMessage(usage, band))) return band;
    }
    return undefined;
}

describe('live-memory warning policy gate', () => {
    // Automatic cleanup at capacity is active, so the installed policy warns;
    // a disabled policy still shows nothing and keeps no schedule.
    it('ships enabled, and a disabled policy shows no warning and keeps no schedule', async () => {
        expect(LIVE_MEMORY_WARNING_POLICY.enabled).toBe(true);
        const f = fixture();
        const disabled: LiveMemoryWarningPolicy = { enabled: false, readUsage: () => 10 * URGENT };
        for (const tool of TOOLS) {
            expect(systemMessage(await f.open(tool, NOW, { liveMemoryWarning: disabled }))).toBeUndefined();
        }
        expect(f.inspect((db) => liveMemoryWarningStatusLine(db, disabled))).toBeUndefined();
        expect(f.nextDue()).toBeUndefined();
    });
});

describe('live-memory warning bands', () => {
    it('warns from exactly 80%, turns urgent at exactly 95%, and is silent one byte below 80%', async () => {
        const cases: Array<[number, LiveMemoryWarningBand | undefined]> = [
            [BELOW, undefined],
            [WEEKLY, 'weekly'],
            [URGENT - 1, 'weekly'],
            [URGENT, 'urgent'],
        ];
        for (const tool of TOOLS) {
            for (const [usage, band] of cases) {
                const f = fixture();
                f.setUsage(usage);
                expect(shown(await f.open(tool, NOW), usage)).toBe(band);
                expect(f.status()).toBe(band === undefined ? undefined : liveMemoryWarningMessage(usage, band));
            }
        }
    });

    it('carries the warning only on the user-visible channel, never in model context', async () => {
        for (const tool of TOOLS) {
            const f = fixture();
            const result = await f.open(tool, NOW);
            expect(shown(result, WEEKLY)).toBe('weekly');
            expect(additionalContext(result) ?? '').not.toContain(liveMemoryWarningMessage(WEEKLY, 'weekly'));
        }
    });
});

describe('weekly cadence from 80% to below 95%', () => {
    it('warns at the first new chat, then not again until seven days later', async () => {
        const f = fixture();
        expect(shown(await f.open('claude-code', NOW), WEEKLY)).toBe('weekly');
        // Installation-wide: a chat opened in the other host is covered by the same slot.
        expect(shown(await f.open('codex', NOW + 1), WEEKLY)).toBeUndefined();
        expect(shown(await f.open('claude-code', NOW + WEEK - 1), WEEKLY)).toBeUndefined();
        expect(shown(await f.open('codex', NOW + WEEK), WEEKLY)).toBe('weekly');
        expect(shown(await f.open('codex', NOW + WEEK + 1), WEEKLY)).toBeUndefined();
    });

    it('shows one warning after missed weeks and restarts the interval from that opening', async () => {
        const f = fixture();
        await f.open('codex', NOW);
        const idle = NOW + 5 * WEEK + 3;
        expect(shown(await f.open('codex', idle), WEEKLY)).toBe('weekly');
        // No backlog: the skipped weekly slots are not replayed.
        expect(shown(await f.open('codex', idle + 1), WEEKLY)).toBeUndefined();
        expect(shown(await f.open('codex', idle + WEEK - 1), WEEKLY)).toBeUndefined();
        expect(shown(await f.open('codex', idle + WEEK), WEEKLY)).toBe('weekly');
    });

    it('warns when the stored due time is more than one interval ahead of the clock', async () => {
        const f = fixture();
        await f.open('codex', NOW + 52 * WEEK);
        // The clock moved back a year; the warning must not wait for it.
        expect(shown(await f.open('codex', NOW), WEEKLY)).toBe('weekly');
    });

    it('lets concurrent openings consume one due slot once', async () => {
        const f = fixture();
        const results = await Promise.all([f.open('claude-code', NOW), f.open('codex', NOW), f.open('codex', NOW)]);
        expect(results.filter((result) => shown(result, WEEKLY) === 'weekly')).toHaveLength(1);
    });
});

describe('urgent band at 95% and above', () => {
    it('warns at every new chat opening regardless of the weekly cadence', async () => {
        const f = fixture();
        expect(shown(await f.open('claude-code', NOW), WEEKLY)).toBe('weekly');
        f.setUsage(URGENT);
        for (const [offset, tool] of [
            [1, 'claude-code'],
            [2, 'codex'],
            [3, 'codex'],
        ] as const) {
            expect(shown(await f.open(tool, NOW + offset), URGENT)).toBe('urgent');
        }
        const concurrent = await Promise.all([f.open('claude-code', NOW + 4), f.open('codex', NOW + 4)]);
        expect(concurrent.map((result) => shown(result, URGENT))).toEqual(['urgent', 'urgent']);
    });

    it('keeps one weekly cadence when usage moves between the bands', async () => {
        const f = fixture();
        await f.open('codex', NOW);
        f.setUsage(URGENT);
        const lastUrgent = NOW + 3 * 24 * 60 * 60 * 1000;
        expect(shown(await f.open('codex', lastUrgent), URGENT)).toBe('urgent');
        // Back in the weekly band, the next notice follows the last one shown.
        f.setUsage(WEEKLY);
        expect(shown(await f.open('codex', NOW + WEEK), WEEKLY)).toBeUndefined();
        expect(shown(await f.open('codex', lastUrgent + WEEK), WEEKLY)).toBe('weekly');
    });
});

describe('rearming below 80%', () => {
    it('rearms at an opening below the threshold, so the next crossing warns immediately', async () => {
        const f = fixture();
        await f.open('claude-code', NOW);
        expect(shown(await f.open('claude-code', NOW + 1), WEEKLY)).toBeUndefined();
        f.setUsage(BELOW);
        expect(systemMessage(await f.open('claude-code', NOW + 2))).toBeUndefined();
        expect(f.nextDue()).toBeUndefined();
        f.setUsage(WEEKLY + 5);
        expect(shown(await f.open('codex', NOW + 3), WEEKLY + 5)).toBe('weekly');
    });
});

describe('only a new top-level chat opening warns', () => {
    it('does not warn on resume, clear, compact or fork, and leaves the due slot for the next new chat', async () => {
        for (const usage of [WEEKLY, URGENT]) {
            const f = fixture();
            f.setUsage(usage);
            for (const source of ['resume', 'clear', 'compact'] as const) {
                for (const tool of TOOLS) {
                    expect(systemMessage(await f.open(tool, NOW, { source }))).toBeUndefined();
                }
            }
            expect(systemMessage(await f.open('claude-code', NOW, { source: 'fork' }))).toBeUndefined();
            expect(f.nextDue()).toBeUndefined();
            expect(shown(await f.open('codex', NOW + 1), usage)).toBe(usage === URGENT ? 'urgent' : 'weekly');
        }
    });

    it('never warns a child agent and leaves the due slot untouched', async () => {
        const f = fixture();
        f.setUsage(URGENT);
        for (const tool of TOOLS) {
            await expect(f.open(tool, NOW, { payload: { agent_id: 'agent-child', agent_type: 'Explore' } })).resolves.toEqual({
                reason: 'subagent_context',
            });
        }
        f.setUsage(WEEKLY);
        expect(shown(await f.open('claude-code', NOW + 1), WEEKLY)).toBe('weekly');
    });

    it('never warns in OpenCode, which has no verified user-visible channel', async () => {
        const f = fixture();
        f.setUsage(URGENT);
        expect(systemMessage(await f.open('opencode', NOW))).toBeUndefined();
        expect(f.nextDue()).toBeUndefined();
    });

    it('never warns on a prompt, with Memory-Plus on or off, and a prompt does not consume the slot', async () => {
        for (const memoryPlus of ['false', 'true']) {
            const f = fixture();
            f.setUsage(URGENT);
            const configPath = path.join(f.directory, 'config.json');
            setSetting('memory-plus', memoryPlus, configPath);
            for (const tool of TOOLS) {
                for (const prompt of ['ordinary question', 'elepha:help']) {
                    const result = await f.prompt(tool, prompt, configPath);
                    expect(systemMessage(result)).toBeUndefined();
                    expect(additionalContext(result) ?? '').not.toContain(liveMemoryWarningMessage(URGENT, 'urgent'));
                }
            }
            f.setUsage(WEEKLY);
            expect(shown(await f.open('codex', NOW + 1), WEEKLY)).toBe('weekly');
        }
    });

    it('warns at a new chat opening whatever the Memory-Plus setting', async () => {
        const original = getSetting('memory-plus').value;
        onTestFinished(() => {
            setSetting('memory-plus', String(original));
        });
        for (const memoryPlus of ['false', 'true']) {
            setSetting('memory-plus', memoryPlus);
            const f = fixture();
            expect(shown(await f.open('claude-code', NOW), WEEKLY)).toBe('weekly');
        }
    });
});

describe('elepha status', () => {
    it('reports the applicable warning on every run without consulting or advancing the schedule', async () => {
        const f = fixture();
        for (let run = 0; run < 3; run++) {
            expect(f.status()).toBe(liveMemoryWarningMessage(WEEKLY, 'weekly'));
        }
        expect(f.nextDue()).toBeUndefined();
        expect(shown(await f.open('codex', NOW), WEEKLY)).toBe('weekly');

        // Not due for chats, still shown by status; the due time is unchanged.
        const due = f.nextDue();
        expect(f.status()).toBe(liveMemoryWarningMessage(WEEKLY, 'weekly'));
        f.setUsage(URGENT);
        expect(f.status()).toBe(liveMemoryWarningMessage(URGENT, 'urgent'));
        // Below 80% status shows nothing and does not rearm either.
        f.setUsage(BELOW);
        expect(f.status()).toBeUndefined();
        expect(f.nextDue()).toBe(due);
    });
});

describe('failure handling', () => {
    it('rolls the schedule back when the notice cannot be recorded against the chat', async () => {
        const f = fixture();
        expect(await f.open('codex', NOW, { writeInjection: () => false })).toEqual({ reason: 'injection_record_failed' });
        expect(f.nextDue()).toBeUndefined();
        expect(shown(await f.open('codex', NOW + 1), WEEKLY)).toBe('weekly');
    });

    it('logs an unreadable usage and still delivers the opening without the warning', async () => {
        const f = fixture();
        const broken: LiveMemoryWarningPolicy = {
            enabled: true,
            readUsage: () => {
                throw new Error('ledger missing');
            },
        };
        const result = await f.open('claude-code', NOW, {
            liveMemoryWarning: broken,
            daemonHealth: () => ({ state: 'NOT_RUNNING', healthy: false }),
        });
        expect(systemMessage(result)).toBeDefined();
        expect(shown(result, WEEKLY)).toBeUndefined();
        expect(f.log).toHaveBeenCalledWith(expect.stringContaining('live_memory_warning failed'));
        expect(shown(await f.open('claude-code', NOW + 1), WEEKLY)).toBe('weekly');
    });
});

describe('schedule migration', () => {
    it('retires the single-epoch receipt table on reopen, keeps other data, and starts the schedule armed', async () => {
        let projectId = 0;
        const f = fixture((database) => {
            projectId = seedProject(database).id;
        });
        f.inspect((db) => {
            db.exec(`DROP TABLE ${LIVE_MEMORY_WARNING_SCHEDULE_TABLE}`);
            // The previous 3B shape, with a delivered receipt that must not
            // suppress a warning under the new schedule.
            db.exec(`CREATE TABLE ${RETIRED_LIVE_MEMORY_WARNING_TABLE} (
              id               INTEGER PRIMARY KEY CHECK (id = 1),
              epoch            INTEGER NOT NULL CHECK (epoch >= 1),
              started_at       TEXT NOT NULL,
              started_bytes    INTEGER NOT NULL CHECK (started_bytes >= 0),
              rearmed_at       TEXT,
              claim_token      TEXT,
              claim_expires_ms INTEGER,
              delivered_at     TEXT,
              delivered_host   TEXT CHECK (delivered_host IN ('claude-code','codex')),
              delivered_bytes  INTEGER CHECK (delivered_bytes >= 0),
              CHECK ((claim_token IS NULL) = (claim_expires_ms IS NULL)),
              CHECK ((delivered_at IS NULL) = (delivered_host IS NULL) AND (delivered_at IS NULL) = (delivered_bytes IS NULL))
            )`);
            db.prepare(
                `INSERT INTO ${RETIRED_LIVE_MEMORY_WARNING_TABLE}
                 (id, epoch, started_at, started_bytes, delivered_at, delivered_host, delivered_bytes)
                 VALUES (1, 3, ?, ?, ?, 'codex', ?)`,
            ).run(new Date(NOW).toISOString(), WEEKLY, new Date(NOW).toISOString(), WEEKLY);
        });

        const tables = () =>
            f.inspect(
                (db) =>
                    db
                        .prepare(`SELECT name FROM sqlite_master WHERE type = 'table' AND name IN (?, ?) ORDER BY name`)
                        .all(RETIRED_LIVE_MEMORY_WARNING_TABLE, LIVE_MEMORY_WARNING_SCHEDULE_TABLE) as Array<{ name: string }>,
            );
        expect(tables()).toEqual([{ name: LIVE_MEMORY_WARNING_SCHEDULE_TABLE }]);
        expect(f.inspect((db) => db.prepare('SELECT id FROM projects').all())).toEqual([{ id: projectId }]);

        expect(shown(await f.open('codex', NOW + 1), WEEKLY)).toBe('weekly');
        const due = f.nextDue();
        expect(due).toBe(NOW + 1 + WEEK);
        // An idempotent reopen keeps the schedule.
        expect(tables()).toEqual([{ name: LIVE_MEMORY_WARNING_SCHEDULE_TABLE }]);
        expect(f.nextDue()).toBe(due);
        expect(shown(await f.open('codex', NOW + 2), WEEKLY)).toBeUndefined();
    });
});
