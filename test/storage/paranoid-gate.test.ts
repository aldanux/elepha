import { spawnSync } from 'node:child_process';
import { createHmac } from 'node:crypto';
import { readFileSync, statSync, unlinkSync, writeFileSync } from 'node:fs';
import { createRequire, syncBuiltinESMExports } from 'node:module';
import path from 'node:path';
import { describe, expect, it, vi } from 'vitest';
import { refuseLockedCliRead } from '../../src/cli/read-gate.js';
import { DEFAULT_MEMORY_CONFIG } from '../../src/config/memory-config.js';
import { RollupService } from '../../src/daemon/rollup-service.js';
import { runSessionStart } from '../../src/hooks/session-start.js';
import { runUserPromptSubmit } from '../../src/hooks/user-prompt-submit.js';
import { ElephaMcpService } from '../../src/mcp/tools.js';
import { wrap } from '../../src/security/sentinel.js';
import { lexicalRecall, tokenizeRecallQuery } from '../../src/serving/lexical-recall.js';
import { SessionReader } from '../../src/serving/session-reader.js';
import type { DatabaseEncryptionRuntime } from '../../src/storage/database-encryption.js';
import { openDb } from '../../src/storage/db.js';
import { DurableCaptureBackfillStore } from '../../src/storage/durable-capture-backfill.js';
import { MemoryStore } from '../../src/storage/memory-store.js';
import {
    type AuthenticatedReadGeneration,
    disableParanoidMode,
    enableParanoidMode,
    isMemoryLocked,
    LOCKED_CONTENT_COVERAGE,
    LOCKED_MCP_RESULT,
    LOCKED_MEMORY_MESSAGE,
    lockMemory,
    paranoidStatePath,
    unlockMemory,
    withMemoryReadGenerationAsync,
} from '../../src/storage/paranoid-gate.js';
import { ProjectResolver } from '../../src/storage/project-resolver.js';
import { RollupStore } from '../../src/storage/rollup-store.js';
import type { ParsedTurn } from '../../src/types/index.js';
import { withGrantableTestDir } from '../helpers/tmp.js';

const PASSPHRASE = 'correct horse battery staple';
const FIXED_KEY = Buffer.alloc(32, 7);
const NOW = '2026-09-04T00:00:00.000Z';

function transitionParanoidStateInChild(dbPath: string, transition: 'lock' | 'lock_unlock'): void {
    const source = `
        import path from 'node:path';
        import { openDb } from ${JSON.stringify(new URL('../../src/storage/db.ts', import.meta.url).href)};
        import { lockMemory, unlockMemory } from ${JSON.stringify(new URL('../../src/storage/paranoid-gate.ts', import.meta.url).href)};

        const [dbPath, transition] = process.argv.slice(1);
        const directory = path.dirname(dbPath);
        const db = await openDb(dbPath, {
            encryption: {
                platform: 'linux',
                env: { CI: '1' },
                randomBytes: () => Buffer.alloc(32, 7),
                randomUUID: () => '11111111-1111-4111-8111-111111111111',
                keyFilePath: () => path.join(directory, 'elepha.keydata'),
            },
        });
        try {
            if (lockMemory(db) !== 'locked') throw new Error('child failed to lock memory');
            if (transition === 'lock_unlock' && unlockMemory(db, ${JSON.stringify(PASSPHRASE)}) !== 'unlocked') {
                throw new Error('child failed to unlock memory');
            }
        } finally {
            db.close();
        }
        process.stdout.write(String(process.pid));
    `;
    const child = spawnSync(process.execPath, ['--import', 'tsx', '--input-type=module', '--eval', source, dbPath, transition], {
        encoding: 'utf8',
    });
    expect(child.status, child.stderr || child.stdout).toBe(0);
    expect(Number(child.stdout)).not.toBe(process.pid);
}

interface TestGatePayload {
    mode: 'default' | 'paranoid';
    salt: string;
    verifier: string;
    epoch: number;
    state: 'locked' | 'unlocked';
}

interface TestGateFile extends TestGatePayload {
    hmac: string;
}

function readGateFile(dbPath: string): TestGateFile {
    return JSON.parse(readFileSync(paranoidStatePath(dbPath), 'utf8')) as TestGateFile;
}

function writeAuthenticGateFile(dbPath: string, payload: TestGatePayload): void {
    const hmac = createHmac('sha256', FIXED_KEY)
        .update(Buffer.from(JSON.stringify(payload), 'utf8'))
        .digest('base64');
    writeFileSync(paranoidStatePath(dbPath), `${JSON.stringify({ ...payload, hmac })}\n`);
}

function authorityState(db: Awaited<ReturnType<typeof openDb>>): { enrolled: number; state: string; generation: number } {
    return db.prepare('SELECT enrolled, state, generation FROM paranoid_authority WHERE id = 1').get() as {
        enrolled: number;
        state: string;
        generation: number;
    };
}

function encryptionRuntime(directory: string): DatabaseEncryptionRuntime {
    return {
        platform: 'linux',
        env: { CI: '1' },
        randomBytes: () => Buffer.from(FIXED_KEY),
        randomUUID: () => '11111111-1111-4111-8111-111111111111',
        keyFilePath: () => path.join(directory, 'elepha.keydata'),
    };
}

function turn(nativeId: string, sourcePath: string, projectPath: string, turnIndex: number, content: string): ParsedTurn {
    return {
        tool: 'codex',
        sessionId: nativeId,
        sourcePath,
        projectPath,
        turnIndex,
        startedAt: NOW,
        endedAt: NOW,
        userMessage: `prompt ${content}`,
        assistantText: `response ${content}`,
        toolCalls: [],
        cursor: `${turnIndex}`,
        hasExternalContent: false,
        resumeMarkerBefore: false,
    };
}

async function fixture() {
    const directory = withGrantableTestDir('elepha-paranoid-');
    const dbPath = path.join(directory, 'elepha.db');
    const projectPath = path.join(directory, 'project');
    const sourcePath = path.join(directory, 'session.jsonl');
    const runtime = encryptionRuntime(directory);
    const db = await openDb(dbPath, { encryption: runtime });
    const store = new MemoryStore(db, { resolveGitRoot: () => null, resolveGitRemote: () => null });
    const project = store.upsertProject(projectPath);
    store.consent.grant(projectPath);
    const session = store.upsertSession('codex', 'locked-session', project.id, sourcePath, { customTitle: 'Locked session' });
    expect(
        store.recordTurn(
            turn(session.native_id, sourcePath, projectPath, 0, 'before lock'),
            session.id,
            project.id,
            {
                decisions: [],
                pending_items: [],
                status: 'ok',
            },
            true,
        ),
    ).toBe(true);
    const projectSet = new ProjectResolver(db, { resolveGitRoot: () => null })
        .listStored()
        .find((set) => set.projectIds.includes(project.id));
    if (projectSet === undefined) {
        throw new Error('seeded project set was not found');
    }
    const served = new SessionReader(db).sessionsFor(projectSet)[0];
    if (served === undefined) {
        throw new Error('seeded session was not found');
    }
    return { db, dbPath, directory, project, projectPath, projectSet, runtime, served, session, sourcePath, store };
}

function codexHookText(result: { output: Record<string, unknown> } | { reason: string }): string | undefined {
    if (!('output' in result)) {
        return undefined;
    }
    const specific = result.output.hookSpecificOutput as Record<string, unknown>;
    return typeof specific.additionalContext === 'string' ? specific.additionalContext : undefined;
}

async function expectRepresentativeReadsLocked(seeded: Awaited<ReturnType<typeof fixture>>): Promise<void> {
    expect(isMemoryLocked(seeded.db)).toBe(true);
    const cliOutput: string[] = [];
    expect(refuseLockedCliRead(seeded.db, (message) => cliOutput.push(message))).toBe(true);
    expect(cliOutput).toEqual([LOCKED_MEMORY_MESSAGE]);

    const reader = new SessionReader(seeded.db);
    const prepare = vi.spyOn(seeded.db, 'prepare');
    await expect(reader.render(seeded.served)).resolves.toEqual({
        state: 'locked',
        reason: 'locked',
        content_coverage: LOCKED_CONTENT_COVERAGE,
    });
    // The authoritative singleton is the gate check; no session, memory, FTS,
    // or transcript read may occur before it returns locked.
    expect(prepare.mock.calls.map(([sql]) => sql)).toEqual([
        'SELECT enrolled, state, generation, credential_tag FROM paranoid_authority WHERE id = 1',
    ]);
    prepare.mockRestore();

    const query = tokenizeRecallQuery('before lock');
    if (query === undefined) {
        throw new Error('query unexpectedly empty');
    }
    await expect(lexicalRecall(reader, [seeded.projectSet], query, 'global', undefined, undefined, 'lax')).resolves.toEqual({
        body: LOCKED_MEMORY_MESSAGE,
        sessionIds: [],
        state: 'locked',
        content_coverage: LOCKED_CONTENT_COVERAGE,
    });

    const mcp = new ElephaMcpService(seeded.db);
    const publicId = Buffer.from(JSON.stringify({ tool: 'codex', nativeId: seeded.session.native_id, segmentIndex: 0 })).toString(
        'base64url',
    );
    for (const response of [
        mcp.listProjects(),
        mcp.listSessions({ project: seeded.projectPath }),
        await mcp.getSession({ id: publicId }),
    ]) {
        expect(response.content).toEqual([{ type: 'text', text: LOCKED_MEMORY_MESSAGE }]);
        expect(response.structuredContent).toEqual(LOCKED_MCP_RESULT);
    }

    const startup = await runSessionStart(
        JSON.stringify({
            session_id: 'current',
            cwd: seeded.projectPath,
            hook_event_name: 'SessionStart',
            source: 'startup',
            model: 'gpt-5.6',
            permission_mode: 'default',
        }),
        'codex',
        {
            dbPath: seeded.dbPath,
            openDatabase: ((dbPath: string) => openDb(dbPath, { encryption: seeded.runtime })) as typeof openDb,
            readConfig: () => ({ config: { ...DEFAULT_MEMORY_CONFIG } }),
            projectResolver: () => {
                throw new Error('locked output must not resolve or read protected projects');
            },
        },
    );
    const startupInjection = seeded.db
        .prepare('SELECT injection_id, body FROM injections WHERE tool = ? AND native_session_id = ? ORDER BY id')
        .get('codex', 'current') as { injection_id: string; body: string } | undefined;
    expect(startupInjection?.body).toBe(LOCKED_MEMORY_MESSAGE);
    expect(codexHookText(startup)).toBe(
        startupInjection === undefined ? undefined : wrap('notify', startupInjection.injection_id, LOCKED_MEMORY_MESSAGE),
    );

    const prompt = await runUserPromptSubmit(
        JSON.stringify({
            session_id: 'current',
            cwd: seeded.projectPath,
            hook_event_name: 'UserPromptSubmit',
            prompt: 'elepha:list',
            model: 'gpt-5.6',
            permission_mode: 'default',
        }),
        'codex',
        {
            dbPath: seeded.dbPath,
            openDatabase: ((dbPath: string) => openDb(dbPath, { encryption: seeded.runtime })) as typeof openDb,
            projectResolver: () => {
                throw new Error('locked output must not resolve or read protected projects');
            },
        },
    );
    const promptInjections = seeded.db
        .prepare('SELECT injection_id, body FROM injections WHERE tool = ? AND native_session_id = ? ORDER BY id')
        .all('codex', 'current') as Array<{ injection_id: string; body: string }>;
    expect(promptInjections.map((injection) => injection.body)).toEqual([LOCKED_MEMORY_MESSAGE]);
    expect(codexHookText(prompt)).toMatch(/^\[\[elepha:brief:[0-9A-Z]{26}]]\n/);
    expect(codexHookText(prompt)?.split('\n').slice(1, -1).join('\n')).toBe(LOCKED_MEMORY_MESSAGE);

    const provider = { rollup: vi.fn(), merge: vi.fn() };
    const rollup = new RollupService({ store: seeded.store, rollups: new RollupStore(seeded.db), provider });
    await expect(rollup.rollupSession(seeded.session, 'primary', null, 'final')).resolves.toEqual({
        wrote: false,
        complete: false,
        deferred: 'locked',
    });
    expect(provider.rollup).not.toHaveBeenCalled();
    expect(provider.merge).not.toHaveBeenCalled();
}

describe('paranoid read gate', () => {
    it.each([
        { generationAdvance: 1, lockedAfterward: true, transition: 'lock' as const },
        { generationAdvance: 2, lockedAfterward: false, transition: 'lock_unlock' as const },
    ])(
        'invalidates SQL-backed public response after a separate-process $transition transition',
        async ({ generationAdvance, lockedAfterward, transition }) => {
            const seeded = await fixture();
            enableParanoidMode(seeded.db, PASSPHRASE);
            expect(unlockMemory(seeded.db, PASSPHRASE)).toBe('unlocked');
            const before = authorityState(seeded.db);
            let pausedAfterProtectedRead = false;
            const mcp = new ElephaMcpService(seeded.db, {
                result: (text, structuredContent) => {
                    if (!pausedAfterProtectedRead && Array.isArray(structuredContent?.sessions)) {
                        expect(structuredContent.sessions).toEqual([expect.objectContaining({ title: 'prompt before lock' })]);
                        pausedAfterProtectedRead = true;
                        transitionParanoidStateInChild(seeded.dbPath, transition);
                    }
                    return { content: [{ type: 'text', text }], structuredContent };
                },
                textResult: (text) => ({ content: [{ type: 'text', text }] }),
            });

            const response = mcp.listSessions({ project: seeded.projectPath, include_all: true });

            expect(pausedAfterProtectedRead).toBe(true);
            expect(authorityState(seeded.db)).toEqual({
                enrolled: 1,
                state: lockedAfterward ? 'locked' : 'unlocked',
                generation: before.generation + generationAdvance,
            });
            expect(isMemoryLocked(seeded.db)).toBe(lockedAfterward);
            expect(response.content).toEqual([{ type: 'text', text: LOCKED_MEMORY_MESSAGE }]);
            expect(response.structuredContent).toEqual(LOCKED_MCP_RESULT);
            seeded.db.close();
        },
    );

    it('rejects the original CLI generation after ABA before rollup service entry', async () => {
        const seeded = await fixture();
        enableParanoidMode(seeded.db, PASSPHRASE);
        expect(unlockMemory(seeded.db, PASSPHRASE)).toBe('unlocked');
        const before = authorityState(seeded.db);
        const originalGeneration = await withMemoryReadGenerationAsync(
            seeded.db,
            () => {
                throw new Error('expected an unlocked read generation');
            },
            async (generation) => generation,
        );
        transitionParanoidStateInChild(seeded.dbPath, 'lock_unlock');
        expect(authorityState(seeded.db)).toEqual({ enrolled: 1, state: 'unlocked', generation: before.generation + 2 });

        const providerResult = {
            status: 'ok' as const,
            output: { title: 'T', summary: 'S', decisions: [], pending_items: [], droppedDecisions: 0 },
        };
        const provider = { rollup: vi.fn().mockResolvedValue(providerResult), merge: vi.fn().mockResolvedValue(providerResult) };
        const service = new RollupService({ store: seeded.store, rollups: new RollupStore(seeded.db), provider });
        const rollupWithGeneration = service.rollupSession.bind(service) as (
            session: typeof seeded.session,
            kind: 'primary',
            parentSessionId: null,
            state: 'final',
            generation: AuthenticatedReadGeneration,
        ) => ReturnType<RollupService['rollupSession']>;

        await expect(rollupWithGeneration(seeded.session, 'primary', null, 'final', originalGeneration)).resolves.toEqual({
            wrote: false,
            complete: false,
            deferred: 'locked',
        });
        expect(provider.rollup).not.toHaveBeenCalled();
        expect(provider.merge).not.toHaveBeenCalled();
        seeded.db.close();
    });

    it('C11 sentinel-wraps locked hook output while the gate blocks every protected serving surface', async () => {
        const seeded = await fixture();
        enableParanoidMode(seeded.db, PASSPHRASE);

        expect(statSync(paranoidStatePath(seeded.dbPath)).mode & 0o777).toBe(0o600);
        const externalState = JSON.parse(readFileSync(paranoidStatePath(seeded.dbPath), 'utf8')) as Record<string, unknown>;
        expect(externalState).toMatchObject({
            mode: 'paranoid',
            epoch: 1,
            state: 'locked',
        });
        expect(Object.keys(externalState).sort()).toEqual(['epoch', 'hmac', 'mode', 'salt', 'state', 'verifier']);
        expect(() => enableParanoidMode(seeded.db, 'replacement passphrase')).toThrow('Paranoid mode is already enabled.');
        await expectRepresentativeReadsLocked(seeded);

        expect(
            seeded.store.recordTurn(
                turn(seeded.session.native_id, seeded.sourcePath, seeded.projectPath, 1, 'during lock'),
                seeded.session.id,
                seeded.project.id,
                {
                    decisions: [],
                    pending_items: [],
                    status: 'ok',
                },
                true,
            ),
        ).toBe(true);

        const historical = seeded.store.upsertSession(
            'codex',
            'backfill-session',
            seeded.project.id,
            path.join(seeded.directory, 'backfill.jsonl'),
        );
        expect(
            seeded.store.recordTurn(
                turn(historical.native_id, historical.source_path, seeded.projectPath, 0, 'backfill'),
                historical.id,
                seeded.project.id,
                {
                    decisions: [],
                    pending_items: [],
                    status: 'ok',
                },
            ),
        ).toBe(true);
        const backfill = new DurableCaptureBackfillStore(seeded.db, seeded.store.consent);
        const candidate = backfill.listCandidates([seeded.project.id], 10).find((item) => item.id === historical.id);
        if (candidate === undefined) {
            throw new Error('backfill candidate was not found');
        }
        expect(backfill.begin(candidate, NOW)?.missingTurnIndexes).toEqual(new Set([0]));
        expect(
            backfill.record(
                candidate,
                0,
                {
                    filterVersion: 1,
                    included: true,
                    userPrompt: 'backfilled prompt',
                    assistantResponse: 'backfilled response',
                    toolCalls: [],
                    omittedToolCallCount: 0,
                },
                NOW,
            ),
        ).toEqual({ state: 'recorded', sessionId: historical.id });
        backfill.finish(candidate, new Set([historical.id]), 'success', NOW);

        const purged = seeded.store.upsertSession(
            'codex',
            'purged-session',
            seeded.project.id,
            path.join(seeded.directory, 'purged.jsonl'),
        );
        expect(
            seeded.store.recordTurn(
                turn(purged.native_id, purged.source_path, seeded.projectPath, 0, 'purged'),
                purged.id,
                seeded.project.id,
                {
                    decisions: [],
                    pending_items: [],
                    status: 'ok',
                },
                true,
            ),
        ).toBe(true);
        const purgePlan = seeded.store.planPurge({ projectIds: [seeded.project.id] });
        const onlyPurged = {
            ...purgePlan,
            sessions: purgePlan.sessions.filter((session) => session.id === purged.id),
            emptiedProjects: [],
        };
        expect(seeded.store.applyPurgePlan(onlyPurged, NOW).sessions.map((session) => session.id)).toEqual([purged.id]);

        expect(unlockMemory(seeded.db, 'wrong passphrase')).toBe('incorrect');
        expect(isMemoryLocked(seeded.db)).toBe(true);
        expect(unlockMemory(seeded.db, PASSPHRASE)).toBe('unlocked');
        expect(isMemoryLocked(seeded.db)).toBe(false);
        const rendered = await new SessionReader(seeded.db).render(seeded.served);
        expect(rendered.episode?.text).toContain('response during lock');

        expect(lockMemory(seeded.db)).toBe('locked');
        expect(isMemoryLocked(seeded.db)).toBe(true);
        expect(disableParanoidMode(seeded.db, 'wrong passphrase')).toBe('incorrect');
        expect(isMemoryLocked(seeded.db)).toBe(true);
        expect(disableParanoidMode(seeded.db, PASSPHRASE)).toBe('disabled');
        expect(isMemoryLocked(seeded.db)).toBe(false);
        expect(JSON.parse(readFileSync(paranoidStatePath(seeded.dbPath), 'utf8'))).toMatchObject({
            mode: 'default',
            epoch: 4,
            state: 'unlocked',
        });
        seeded.db.close();
    });

    it('fails every representative read closed after an enrolled locked gate disappears', async () => {
        const seeded = await fixture();
        enableParanoidMode(seeded.db, PASSPHRASE);
        unlinkSync(paranoidStatePath(seeded.dbPath));

        await expectRepresentativeReadsLocked(seeded);
        seeded.db.close();
    });

    it.each([
        {
            name: 'malformed',
            mutate: (seeded: Awaited<ReturnType<typeof fixture>>) => writeFileSync(paranoidStatePath(seeded.dbPath), '{not-json\n'),
        },
        {
            name: 'invalid-hmac',
            mutate: (seeded: Awaited<ReturnType<typeof fixture>>) => {
                const file = paranoidStatePath(seeded.dbPath);
                const state = JSON.parse(readFileSync(file, 'utf8')) as Record<string, unknown>;
                state.state = 'unlocked';
                writeFileSync(file, `${JSON.stringify(state)}\n`);
            },
        },
        {
            name: 'database-file-mismatch',
            mutate: (seeded: Awaited<ReturnType<typeof fixture>>) => {
                seeded.db.prepare("UPDATE paranoid_authority SET state = 'unlocked' WHERE id = 1").run();
            },
        },
        {
            name: 'invalid database credential tag',
            mutate: (seeded: Awaited<ReturnType<typeof fixture>>) => {
                seeded.db.prepare("UPDATE paranoid_authority SET credential_tag = 'not-base64' WHERE id = 1").run();
            },
        },
    ])('treats $name external gate state as locked', async ({ mutate }) => {
        const seeded = await fixture();
        enableParanoidMode(seeded.db, PASSPHRASE);
        mutate(seeded);

        expect(isMemoryLocked(seeded.db)).toBe(true);
        await expect(new SessionReader(seeded.db).render(seeded.served)).resolves.toMatchObject({ state: 'locked', reason: 'locked' });
        seeded.db.close();
    });

    it('treats an injected unreadable external gate as locked', async () => {
        const seeded = await fixture();
        enableParanoidMode(seeded.db, PASSPHRASE);
        const gatePath = paranoidStatePath(seeded.dbPath);
        const mutableFs = createRequire(import.meta.url)('node:fs') as typeof import('node:fs');
        const originalOpenSync = mutableFs.openSync;
        mutableFs.openSync = ((file, flags, mode) => {
            if (path.resolve(file.toString()) === gatePath) {
                const error = new Error('injected unreadable paranoid gate') as NodeJS.ErrnoException;
                error.code = 'EACCES';
                throw error;
            }
            return originalOpenSync(file, flags, mode);
        }) as typeof import('node:fs').openSync;
        syncBuiltinESMExports();

        try {
            expect(isMemoryLocked(seeded.db)).toBe(true);
            await expect(new SessionReader(seeded.db).render(seeded.served)).resolves.toMatchObject({ state: 'locked', reason: 'locked' });
        } finally {
            mutableFs.openSync = originalOpenSync;
            syncBuiltinESMExports();
            seeded.db.close();
        }
    });

    it('adopts an authentic legacy gate once and preserves that authority on reopen', async () => {
        const seeded = await fixture();
        enableParanoidMode(seeded.db, PASSPHRASE);
        seeded.db.exec('ALTER TABLE paranoid_authority DROP COLUMN credential_tag');
        seeded.db.close();

        const upgraded = await openDb(seeded.dbPath, { encryption: seeded.runtime });
        const upgradedTag = upgraded.prepare('SELECT credential_tag FROM paranoid_authority WHERE id = 1').get() as {
            credential_tag: string;
        };
        expect(Buffer.from(upgradedTag.credential_tag, 'base64')).toHaveLength(32);
        expect(isMemoryLocked(upgraded)).toBe(true);
        upgraded.close();

        const upgradedReopen = await openDb(seeded.dbPath, { encryption: seeded.runtime });
        expect(upgradedReopen.prepare('SELECT credential_tag FROM paranoid_authority WHERE id = 1').get()).toEqual(upgradedTag);
        expect(isMemoryLocked(upgradedReopen)).toBe(true);
        upgradedReopen.exec('DROP TABLE IF EXISTS paranoid_authority');
        upgradedReopen.close();

        const adopted = await openDb(seeded.dbPath, { encryption: seeded.runtime });
        expect(adopted.prepare('SELECT enrolled, state, generation FROM paranoid_authority WHERE id = 1').get()).toEqual({
            enrolled: 1,
            state: 'locked',
            generation: 1,
        });
        expect(isMemoryLocked(adopted)).toBe(true);
        adopted.close();

        const reopened = await openDb(seeded.dbPath, { encryption: seeded.runtime });
        expect(reopened.prepare('SELECT enrolled, state, generation FROM paranoid_authority WHERE id = 1').get()).toEqual({
            enrolled: 1,
            state: 'locked',
            generation: 1,
        });
        expect(isMemoryLocked(reopened)).toBe(true);
        reopened.prepare('DELETE FROM paranoid_authority WHERE id = 1').run();
        reopened.close();

        const missingAuthority = await openDb(seeded.dbPath, { encryption: seeded.runtime });
        expect(missingAuthority.prepare('SELECT * FROM paranoid_authority WHERE id = 1').get()).toBeUndefined();
        expect(isMemoryLocked(missingAuthority)).toBe(true);
        missingAuthority.close();
    });

    it('does not adopt an invalid present legacy gate and fails closed on reopen', async () => {
        const seeded = await fixture();
        enableParanoidMode(seeded.db, PASSPHRASE);
        const file = paranoidStatePath(seeded.dbPath);
        const state = JSON.parse(readFileSync(file, 'utf8')) as Record<string, unknown>;
        state.state = 'unlocked';
        writeFileSync(file, `${JSON.stringify(state)}\n`);
        seeded.db.exec('DROP TABLE IF EXISTS paranoid_authority');
        seeded.db.close();

        const reopened = await openDb(seeded.dbPath, { encryption: seeded.runtime });
        expect(reopened.prepare('SELECT enrolled, state, generation FROM paranoid_authority WHERE id = 1').get()).toEqual({
            enrolled: 1,
            state: 'locked',
            generation: 0,
        });
        expect(isMemoryLocked(reopened)).toBe(true);
        reopened.close();

        unlinkSync(file);
        const missingGate = await openDb(seeded.dbPath, { encryption: seeded.runtime });
        expect(isMemoryLocked(missingGate)).toBe(true);
        expect(missingGate.prepare('SELECT enrolled, state, generation FROM paranoid_authority WHERE id = 1').get()).toEqual({
            enrolled: 1,
            state: 'locked',
            generation: 0,
        });
        missingGate.close();
    });

    it('does not adopt an upgrade credential tag from an authentic mismatched gate', async () => {
        const seeded = await fixture();
        enableParanoidMode(seeded.db, PASSPHRASE);
        seeded.db.exec(`
          ALTER TABLE paranoid_authority DROP COLUMN credential_tag;
          UPDATE paranoid_authority SET state = 'unlocked';
        `);
        seeded.db.close();

        const reopened = await openDb(seeded.dbPath, { encryption: seeded.runtime });
        expect(reopened.prepare('SELECT credential_tag FROM paranoid_authority WHERE id = 1').get()).toEqual({
            credential_tag: null,
        });
        expect(isMemoryLocked(reopened)).toBe(true);
        reopened.close();
    });

    it('rejects an authentic replayed lower generation after later lock generations complete', async () => {
        const seeded = await fixture();
        enableParanoidMode(seeded.db, PASSPHRASE);
        expect(unlockMemory(seeded.db, PASSPHRASE)).toBe('unlocked');
        const replayed = readFileSync(paranoidStatePath(seeded.dbPath));
        const replayedEpoch = readGateFile(seeded.dbPath).epoch;
        expect(replayedEpoch).toBe(2);

        expect(lockMemory(seeded.db)).toBe('locked');
        expect(lockMemory(seeded.db)).toBe('locked');
        expect(authorityState(seeded.db)).toEqual({ enrolled: 1, state: 'locked', generation: replayedEpoch + 2 });
        writeFileSync(paranoidStatePath(seeded.dbPath), replayed);

        expect(isMemoryLocked(seeded.db)).toBe(true);
        expect(authorityState(seeded.db)).toEqual({ enrolled: 1, state: 'locked', generation: replayedEpoch + 2 });
        seeded.db.close();
    });

    it.each([
        {
            name: 'unexpected higher generation',
            mutate: (payload: TestGatePayload): TestGatePayload => ({ ...payload, epoch: payload.epoch + 1 }),
        },
        {
            name: 'same-generation verifier payload mismatch',
            mutate: (payload: TestGatePayload): TestGatePayload => ({
                ...payload,
                verifier: Buffer.alloc(32, 19).toString('base64'),
            }),
        },
    ])('locks an authentic $name', async ({ mutate }) => {
        const seeded = await fixture();
        enableParanoidMode(seeded.db, PASSPHRASE);
        expect(unlockMemory(seeded.db, PASSPHRASE)).toBe('unlocked');
        const { hmac: _hmac, ...payload } = readGateFile(seeded.dbPath);
        writeAuthenticGateFile(seeded.dbPath, mutate(payload));

        expect(isMemoryLocked(seeded.db)).toBe(true);
        seeded.db.close();
    });

    it('makes database authority restrictive before installing the external lock state', async () => {
        const seeded = await fixture();
        enableParanoidMode(seeded.db, PASSPHRASE);
        expect(unlockMemory(seeded.db, PASSPHRASE)).toBe('unlocked');
        const gatePath = paranoidStatePath(seeded.dbPath);
        const before = readGateFile(seeded.dbPath);
        const mutableFs = createRequire(import.meta.url)('node:fs') as typeof import('node:fs');
        const originalRenameSync = mutableFs.renameSync;
        mutableFs.renameSync = ((oldPath, newPath) => {
            if (path.resolve(newPath.toString()) === gatePath) {
                const error = new Error('injected external lock installation failure') as NodeJS.ErrnoException;
                error.code = 'EIO';
                throw error;
            }
            return originalRenameSync(oldPath, newPath);
        }) as typeof import('node:fs').renameSync;
        syncBuiltinESMExports();

        try {
            expect(() => lockMemory(seeded.db)).toThrow('injected external lock installation failure');
        } finally {
            mutableFs.renameSync = originalRenameSync;
            syncBuiltinESMExports();
        }

        expect(readGateFile(seeded.dbPath)).toEqual(before);
        expect(authorityState(seeded.db)).toEqual({ enrolled: 1, state: 'locked', generation: before.epoch + 1 });
        expect(isMemoryLocked(seeded.db)).toBe(true);
        expect(lockMemory(seeded.db)).toBe('locked');
        expect(readGateFile(seeded.dbPath)).toMatchObject({ epoch: before.epoch + 1, state: 'locked' });
        seeded.db.close();
    });

    it('installs a permissive external unlock before database authority and verifies recovery passphrases', async () => {
        const seeded = await fixture();
        enableParanoidMode(seeded.db, PASSPHRASE);
        seeded.db.exec(`
          CREATE TEMP TRIGGER fail_paranoid_authority_update
          BEFORE UPDATE ON paranoid_authority
          BEGIN
            SELECT RAISE(ABORT, 'injected authority failure');
          END
        `);

        expect(() => unlockMemory(seeded.db, PASSPHRASE)).toThrow('injected authority failure');
        seeded.db.exec('DROP TRIGGER fail_paranoid_authority_update');

        expect(readGateFile(seeded.dbPath)).toMatchObject({ epoch: 2, state: 'unlocked' });
        expect(authorityState(seeded.db)).toEqual({ enrolled: 1, state: 'locked', generation: 1 });
        expect(isMemoryLocked(seeded.db)).toBe(true);
        expect(unlockMemory(seeded.db, 'wrong passphrase')).toBe('incorrect');
        expect(isMemoryLocked(seeded.db)).toBe(true);
        expect(unlockMemory(seeded.db, PASSPHRASE)).toBe('unlocked');
        expect(authorityState(seeded.db)).toEqual({ enrolled: 1, state: 'unlocked', generation: 2 });
        expect(isMemoryLocked(seeded.db)).toBe(false);
        seeded.db.close();
    });
});
