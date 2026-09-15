import { mkdirSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import {
    SESSION_KIND_RECONCILIATION_BATCH_SIZE,
    SESSION_KIND_RECONCILIATION_BUDGET_MS,
    SESSION_KIND_REVISION,
} from '../../src/config/constants.js';
import { DEFAULT_MEMORY_CONFIG } from '../../src/config/memory-config.js';
import { IngestionDaemon } from '../../src/daemon/index.js';
import { openProviderTranscript } from '../../src/security/provider-transcript.js';
import { SESSION_KIND_RECONCILIATION_LOG_PREFIX, sessionKindStatus } from '../../src/storage/session-kind-reconciliation.js';
import { createTestDb, seedProject, seedSession } from '../helpers/db.js';

describe('startup session classification', () => {
    afterEach(() => vi.unstubAllEnvs());

    it('continues startup discovery when classification repair rejects', async () => {
        const f = createTestDb('elepha-classification-startup-failure-');
        const project = seedProject(f);
        f.store.consent.grant(project.path);
        const providerRoot = path.join(f.directory, 'provider');
        mkdirSync(providerRoot);
        const session = seedSession(f, { project, sourcePath: path.join(providerRoot, 'unavailable.jsonl'), kind: 'main' });
        f.db.prepare('UPDATE sessions SET kind_revision = 0 WHERE id = ?').run(session.id);
        let finish: () => void = () => {};
        const discovered = new Promise<void>((resolve) => {
            finish = resolve;
        });
        const logError = vi.fn();
        const readCorpus = vi.fn(async () => {
            finish();
            return [];
        });
        const daemon = new IngestionDaemon({
            store: f.store,
            adapters: [],
            watchRoots: [providerRoot],
            watcherUsePolling: true,
            readConfig: () => ({ config: DEFAULT_MEMORY_CONFIG }),
            heartbeatPath: path.join(f.directory, 'heartbeat.json'),
            daemonLogPaths: { stdout: path.join(f.directory, 'stdout.log'), stderr: path.join(f.directory, 'stderr.log') },
            updateCheck: () => undefined,
            openTranscript: async () => {
                throw new Error('fixture opener failure');
            },
            readCorpus,
            logError,
        });
        daemon.start();
        try {
            await discovered;
        } finally {
            await daemon.stop();
        }
        expect(readCorpus).toHaveBeenCalled();
        expect(logError.mock.calls.some(([message]) => message.includes('fixture opener failure'))).toBe(true);
        expect(sessionKindStatus(f.db)).toMatchObject({ pending: 1, updating: false });
    });

    it('automatically continues after the pass budget without retrying a persistent incident', async () => {
        const f = createTestDb('elepha-classification-continuation-');
        const project = seedProject(f);
        f.store.consent.grant(project.path);
        const codexHome = path.join(f.directory, '.codex');
        const providerRoot = path.join(codexHome, 'sessions');
        mkdirSync(providerRoot, { recursive: true });
        vi.stubEnv('CODEX_HOME', codexHome);
        const count = SESSION_KIND_RECONCILIATION_BATCH_SIZE + 3;
        for (let index = 0; index < count; index++) {
            const nativeId = `guardian-${index}`;
            const sourcePath = path.join(providerRoot, `${nativeId}.jsonl`);
            if (index > 0)
                writeFileSync(
                    sourcePath,
                    `${JSON.stringify({
                        type: 'session_meta',
                        payload: {
                            id: nativeId,
                            cwd: project.path,
                            thread_source: 'guardian_review',
                        },
                    })}\n${JSON.stringify({ type: 'event_msg', payload: { turn_id: 'native' } })}\n`,
                );
            const session = seedSession(f, { project, sourcePath, nativeId, kind: 'main' });
            f.db.prepare('UPDATE sessions SET kind_revision = 0 WHERE id = ?').run(session.id);
        }
        let clock = 0;
        let opens = 0;
        const opened = vi.fn(async (tool: Parameters<typeof openProviderTranscript>[0], file: string) => {
            opens++;
            if (opens === SESSION_KIND_RECONCILIATION_BATCH_SIZE) clock += SESSION_KIND_RECONCILIATION_BUDGET_MS;
            return openProviderTranscript(tool, file);
        });
        let finish: () => void = () => {};
        const completed = new Promise<void>((resolve) => {
            finish = resolve;
        });
        let passes = 0;
        const daemon = new IngestionDaemon({
            store: f.store,
            adapters: [],
            watchRoots: [],
            readConfig: () => ({ config: DEFAULT_MEMORY_CONFIG }),
            heartbeatPath: path.join(f.directory, 'heartbeat.json'),
            daemonLogPaths: { stdout: path.join(f.directory, 'stdout.log'), stderr: path.join(f.directory, 'stderr.log') },
            updateCheck: () => undefined,
            openTranscript: opened,
            sessionKindReconciliationNow: () => clock,
            log: (message) => {
                if (message.startsWith(SESSION_KIND_RECONCILIATION_LOG_PREFIX) && message.includes('checked,')) {
                    passes++;
                    if (passes === 2) finish();
                }
            },
        });
        daemon.start();
        try {
            await completed;
        } finally {
            await daemon.stop();
        }
        expect(passes).toBe(2);
        expect(opens).toBe(count);
        expect(opened.mock.calls.filter(([, file]) => file.endsWith('guardian-0.jsonl'))).toHaveLength(1);
        expect(sessionKindStatus(f.db)).toEqual({ pending: 1, incidents: 1, updating: false });
        expect(f.db.prepare("SELECT COUNT(*) AS n FROM sessions WHERE kind = 'adjudicator'").get()).toEqual({ n: count - 1 });
    });

    it('reconciles historical guardian rows before startup discovery and skips them on restart', async () => {
        const f = createTestDb('elepha-startup-classification-');
        const project = seedProject(f);
        f.store.consent.grant(project.path);
        const codexHome = path.join(f.directory, '.codex');
        const providerRoot = path.join(codexHome, 'sessions');
        mkdirSync(providerRoot, { recursive: true });
        vi.stubEnv('CODEX_HOME', codexHome);
        const sourcePath = path.join(providerRoot, 'rollout-session.jsonl');
        writeFileSync(
            sourcePath,
            `${[
                JSON.stringify({ type: 'session_meta', payload: { id: 'guardian', cwd: project.path, thread_source: 'guardian_review' } }),
                JSON.stringify({ type: 'event_msg', payload: { turn_id: 'native-task' } }),
            ].join('\n')}\n`,
        );
        const session = seedSession(f, { project, sourcePath, nativeId: 'guardian', kind: 'main' });
        expect(session.kind_revision).toBe(SESSION_KIND_REVISION);
        f.db.prepare('UPDATE sessions SET kind_revision = 0 WHERE id = ?').run(session.id);
        for (let startup = 0; startup < 2; startup++) {
            const opened = vi.fn(openProviderTranscript);
            let resolveDiscovery: () => void = () => {};
            let rejectDiscovery: (error: unknown) => void = () => {};
            const discovered = new Promise<void>((resolve, reject) => {
                resolveDiscovery = resolve;
                rejectDiscovery = reject;
            });
            const daemon = new IngestionDaemon({
                store: f.store,
                adapters: [],
                watchRoots: [providerRoot],
                watcherUsePolling: true,
                readConfig: () => ({ config: DEFAULT_MEMORY_CONFIG }),
                heartbeatPath: path.join(f.directory, 'heartbeat.json'),
                daemonLogPaths: { stdout: path.join(f.directory, 'stdout.log'), stderr: path.join(f.directory, 'stderr.log') },
                updateCheck: () => undefined,
                openTranscript: opened,
                readCorpus: async () => {
                    try {
                        expect(f.db.prepare('SELECT kind, kind_revision FROM sessions WHERE id = ?').get(session.id)).toEqual({
                            kind: 'adjudicator',
                            kind_revision: SESSION_KIND_REVISION,
                        });
                        resolveDiscovery();
                    } catch (error) {
                        rejectDiscovery(error);
                    }
                    return [];
                },
            });
            daemon.start();
            try {
                await discovered;
            } finally {
                await daemon.stop();
            }
            expect(opened).toHaveBeenCalledTimes(startup === 0 ? 1 : 0);
        }
    });
});
