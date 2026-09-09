import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import * as cliProgress from '../../src/cli/progress.js';
import { printPurgePlan } from '../../src/cli/shared.js';
import type { ServiceBackend } from '../../src/install/service-backend.js';
import { openUnmanagedDb } from '../../src/storage/db.js';
import { MemoryStore } from '../../src/storage/memory-store.js';
import { withTempDir } from '../helpers/tmp.js';

const { backupDatabaseAndReport, daemonHealth, defaultDbPath, serviceBackend } = vi.hoisted(() => ({
    backupDatabaseAndReport: vi.fn(),
    daemonHealth: vi.fn(),
    defaultDbPath: vi.fn(),
    serviceBackend: vi.fn(),
}));

vi.mock('../../src/install/health-checks.js', () => ({ daemonHealth }));
vi.mock('../../src/install/service-backend.js', () => ({ serviceBackend }));
vi.mock('../../src/storage/backup.js', () => ({ backupDatabaseAndReport }));
vi.mock('../../src/storage/db.js', async (importOriginal) => ({
    ...(await importOriginal<typeof import('../../src/storage/db.js')>()),
    defaultDbPath,
}));

import { runDestructiveOp } from '../../src/cli/destructive-op.js';

function fakeService(calls: string[]): ServiceBackend {
    let loaded = true;
    let disabled = false;
    return {
        launcherPath: '',
        manifestPath: '',
        transactionPath: '',
        artifactPaths: [],
        hasArtifacts: () => true,
        isInstalled: () => true,
        installationMatches: () => true,
        install: () => {},
        uninstall: () => {},
        start: () => {
            calls.push('start');
            loaded = true;
        },
        stop: () => {
            calls.push('stop');
            loaded = false;
        },
        restart: () => {},
        status: () => ({ loaded, disabled, unknown: false }),
        healthy: () => true,
        waitForHealthy: () => true,
        healthFailure: () => new Error('unhealthy'),
        enable: () => {
            calls.push('enable');
            disabled = false;
        },
        disable: () => {
            calls.push('disable');
            disabled = true;
        },
    };
}

describe('runDestructiveOp daemon liveness gate', () => {
    let error: ReturnType<typeof vi.spyOn>;

    beforeEach(() => {
        vi.clearAllMocks();
        error = vi.spyOn(console, 'error').mockImplementation(() => undefined);
        process.exitCode = undefined;
    });

    afterEach(() => {
        vi.restoreAllMocks();
        process.exitCode = undefined;
    });

    it('returns true for a dry run without inspecting or pausing capture', async () => {
        const apply = vi.fn();

        await expect(
            runDestructiveOp({
                applyRequested: false,
                db: { pragma: vi.fn() } as unknown as ReturnType<typeof openUnmanagedDb>,
                plan: () => ({ rows: 1 }),
                describe: vi.fn(),
                isEmpty: () => false,
                messages: { dryRun: 'dry run' },
                apply,
                verify: vi.fn(),
            }),
        ).resolves.toBe(true);

        expect(daemonHealth).not.toHaveBeenCalled();
        expect(serviceBackend).not.toHaveBeenCalled();
        expect(apply).not.toHaveBeenCalled();
    });

    it('returns false after confirmation when a healthy daemon has no managed service to pause', async () => {
        daemonHealth.mockReturnValue({ state: 'RUNNING (pid 42, heartbeat 1s ago)', healthy: true });
        serviceBackend.mockReturnValue({ isInstalled: () => false });
        const confirm = vi.fn(async () => true);
        const apply = vi.fn();
        const verify = vi.fn();

        await expect(
            runDestructiveOp({
                applyRequested: true,
                db: { pragma: vi.fn() } as unknown as ReturnType<typeof openUnmanagedDb>,
                operationLabel: 'purge',
                plan: () => ({ rows: 1 }),
                describe: vi.fn(),
                isEmpty: () => false,
                confirm,
                messages: { dryRun: 'dry run' },
                apply,
                verify,
            }),
        ).resolves.toBe(false);

        expect(confirm).toHaveBeenCalledOnce();
        expect(error).toHaveBeenCalledWith('Refusing purge: a running daemon could not be paused automatically. Stop it and retry.');
        expect(process.exitCode).toBe(1);
        expect(backupDatabaseAndReport).not.toHaveBeenCalled();
        expect(apply).not.toHaveBeenCalled();
        expect(verify).not.toHaveBeenCalled();
    });

    it('closes the operation database before resuming capture', async () => {
        const calls: string[] = [];
        serviceBackend.mockReturnValue(fakeService(calls));
        defaultDbPath.mockReturnValue('test/fixtures/missing-elepha.db');
        daemonHealth
            .mockReturnValueOnce({
                state: 'RUNNING (pid 42, heartbeat 1s ago)',
                healthy: true,
                heartbeat: { pid: 42, startedAt: '2026-08-28T00:00:00.000Z', updatedAt: '2026-08-28T00:00:01.000Z' },
            })
            .mockReturnValueOnce({
                state: 'NOT RUNNING (pid 42 from last heartbeat is gone - crashed?)',
                healthy: false,
                heartbeat: { pid: 42, startedAt: '2026-08-28T00:00:00.000Z', updatedAt: '2026-08-28T00:00:01.000Z' },
            })
            .mockReturnValueOnce({
                state: 'NOT RUNNING (pid 42 from last heartbeat is gone - crashed?)',
                healthy: false,
                heartbeat: { pid: 42, startedAt: '2026-08-28T00:00:00.000Z', updatedAt: '2026-08-28T00:00:01.000Z' },
            })
            .mockReturnValueOnce({
                state: 'RUNNING (pid 43, heartbeat 0s ago)',
                healthy: true,
                heartbeat: { pid: 43, startedAt: '2026-08-28T00:01:00.000Z', updatedAt: '2026-08-28T00:01:00.000Z' },
            });
        const close = vi.fn(() => {
            calls.push('close');
        });
        const db = { close } as unknown as ReturnType<typeof openUnmanagedDb>;

        await expect(
            runDestructiveOp({
                applyRequested: true,
                db,
                plan: () => ({ rows: 1 }),
                describe: vi.fn(),
                isEmpty: () => false,
                messages: { dryRun: 'dry run' },
                apply: () => {
                    calls.push('apply');
                },
                verify: () => {
                    calls.push('verify');
                },
            }),
        ).resolves.toBe(true);

        expect(close).toHaveBeenCalledOnce();
        expect(calls).toEqual(['stop', 'disable', 'apply', 'verify', 'close', 'enable', 'start']);
    });

    it('keeps the destructive preview, confirmation and real backup report outside progress', async () => {
        const directory = withTempDir('capture-progress-');
        const dbPath = path.join(directory, 'elepha.db');
        defaultDbPath.mockReturnValue(dbPath);
        const backup = await vi.importActual<typeof import('../../src/storage/backup.js')>('../../src/storage/backup.js');
        backupDatabaseAndReport.mockImplementationOnce(backup.backupDatabaseAndReport);
        const db = openUnmanagedDb(dbPath);
        const store = new MemoryStore(db);
        const projectPath = path.join(directory, 'project');
        const project = store.upsertProject(projectPath);
        store.upsertSession('codex', 'selected', project.id, path.join(directory, 'session.jsonl'));
        const plan = store.planPurge({ projectIds: [project.id] });
        const calls: string[] = [];
        const service = fakeService(calls);
        serviceBackend.mockReturnValue(service);
        daemonHealth.mockImplementation(() => ({
            healthy: service.status().loaded,
            state: 'test service',
            heartbeat: service.status().loaded ? { pid: 42, startedAt: '2026-08-28T00:00:00.000Z' } : undefined,
        }));
        let active = false;
        vi.spyOn(cliProgress, 'startCliProgress').mockImplementation(() => {
            expect(active).toBe(false);
            active = true;
            calls.push('progress');
            return {
                done: () => {
                    active = false;
                    calls.push('done');
                },
                fail: vi.fn(),
            };
        });
        const log = vi.spyOn(console, 'log').mockImplementation(() => {
            expect(active).toBe(false);
        });
        const backupLog = vi.fn((message: string) => {
            expect(active).toBe(false);
            expect(service.status()).toMatchObject({ loaded: false, disabled: true });
            calls.push('backup');
            console.log(message);
        });
        try {
            await expect(
                runDestructiveOp({
                    applyRequested: true,
                    db,
                    plan: () => plan,
                    describe: printPurgePlan,
                    isEmpty: () => false,
                    confirm: async () => {
                        expect(active).toBe(false);
                        calls.push('confirm');
                        return true;
                    },
                    backupLog,
                    messages: { dryRun: 'dry run' },
                    apply: () => {
                        calls.push('apply');
                    },
                    verify: () => {
                        calls.push('verify');
                    },
                }),
            ).resolves.toBe(true);
            const [backupPath] = backup.listManagedBackups(dbPath);
            expect(backupPath).toBeDefined();
            expect(backupLog).toHaveBeenCalledWith(`\nBacked up ${dbPath} to ${backupPath}.`);
            expect(log).toHaveBeenCalledWith('In total: 1 session(s), 0 turn(s).');
            expect(log).toHaveBeenCalledWith(`  ${projectPath}  (project entry will be removed — no sessions left)`);
            expect(calls).toEqual([
                'confirm',
                'progress',
                'stop',
                'disable',
                'done',
                'backup',
                'apply',
                'verify',
                'progress',
                'enable',
                'start',
                'done',
            ]);
            expect(active).toBe(false);
            expect(db.open).toBe(false);
        } finally {
            if (db.open) db.close();
        }
    });
});
