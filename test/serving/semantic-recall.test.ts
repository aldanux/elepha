import { randomBytes } from 'node:crypto';
import { mkdirSync } from 'node:fs';
import path from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import {
    SEMANTIC_RECALL_MAX_HITS,
    SEMANTIC_SCAN_BUDGET_MS,
    SEMANTIC_SCAN_MAX_ROWS,
    SEMANTIC_SCAN_MAX_VECTOR_BYTES,
} from '../../src/config/constants.js';
import { setSetting } from '../../src/config/settings.js';
import * as providers from '../../src/embeddings/provider-config.js';
import { runUserPromptSubmit } from '../../src/hooks/user-prompt-submit.js';
import { ElephaMcpService } from '../../src/mcp/tools.js';
import { lexicalRecall, STRICT_RECALL_FALLBACK_NOTICE, tokenizeRecallQuery } from '../../src/serving/lexical-recall.js';
import * as semanticModule from '../../src/serving/semantic-recall.js';
import { renderSemanticUnion, SEMANTIC_DISCOVERY, semanticRecall, unionRecallIds } from '../../src/serving/semantic-recall.js';
import { SessionReader } from '../../src/serving/session-reader.js';
import { openUnmanagedDb } from '../../src/storage/db.js';
import { EMBEDDING_SOURCE_CHANGED, EmbeddingStore, lockedEmbedding } from '../../src/storage/embedding-store.js';
import {
    enableParanoidMode,
    lockMemory,
    registerParanoidDatabase,
    unlockMemory,
    withMemoryReadGeneration,
} from '../../src/storage/paranoid-gate.js';
import { ProjectResolver } from '../../src/storage/project-resolver.js';
import { createTestDb, seedConsentRoot, seedProject, seedSession } from '../helpers/db.js';

vi.mock('../../src/config/constants.js', async (importOriginal) => ({
    ...(await importOriginal<typeof import('../../src/config/constants.js')>()),
    SEMANTIC_SCAN_MAX_ROWS: 12,
}));

function scan(store: EmbeddingStore, projectIds: number[]) {
    const vectors: import('../../src/storage/embedding-store.js').StoredEmbedding[] = [];
    store.scan(projectIds, (vector) => vectors.push(vector));
    return vectors;
}

const configuration: providers.EmbeddingConfiguration = { provider: 'local', model: 'fixture', revision: 'v1', dimensions: 2 };
const NOW = Date.parse('2026-09-14T12:00:00Z');

function fixture() {
    const f = createTestDb('semantic-recall-');
    vi.stubEnv('ELEPHA_HOME', f.directory);
    const configPath = path.join(f.directory, 'config.json');
    const project = seedProject(f);
    mkdirSync(project.path, { recursive: true });
    seedConsentRoot(f, { path: project.path });
    const embeddings = new EmbeddingStore(f.db, configPath);
    const provider: providers.EmbeddingProvider = {
        configuration,
        embed: vi.fn(async () => [1, 0]),
        dispose: vi.fn(async () => {}),
    };
    const factory = vi.spyOn(providers, 'createEmbeddingProvider').mockResolvedValue(provider);
    function add(title: string, vector?: number[], model = configuration) {
        const session = seedSession(f, {
            project,
            title,
            nativeId: title,
            surface: 'cli',
            startedAt: '2026-09-14T00:00:00Z',
            lastTurnAt: '2026-09-14T00:00:00Z',
        });
        if (vector !== undefined) {
            setSetting('memory-plus', 'true', configPath);
            const source = embeddings.source(session.id)!;
            embeddings.write(
                source,
                model,
                vector,
                withMemoryReadGeneration(f.db, lockedEmbedding, (token) => token),
            );
        }
        return session;
    }
    return { ...f, configPath, project, embeddings, provider, factory, add };
}

function projects(f: ReturnType<typeof fixture>) {
    return new ProjectResolver(f.db).listConsentedStored(f.store.consent);
}

function text(result: { content: Array<{ type: string; text?: string }> }): string {
    return result.content.map((item) => item.text ?? '').join('\n');
}

async function hook(f: ReturnType<typeof fixture>, prompt = 'elepha:query receipt') {
    function openDatabase(dbPath: ':memory:'): ReturnType<typeof openUnmanagedDb>;
    function openDatabase(dbPath?: string): Promise<ReturnType<typeof openUnmanagedDb>>;
    function openDatabase(dbPath?: string) {
        const db = openUnmanagedDb(dbPath);
        return dbPath === ':memory:' ? db : Promise.resolve(db);
    }
    const result = await runUserPromptSubmit(
        JSON.stringify({
            session_id: 'current',
            cwd: f.project.path,
            hook_event_name: 'UserPromptSubmit',
            prompt,
            model: 'fixture-model',
            permission_mode: 'default',
        }),
        'codex',
        {
            dbPath: f.dbPath,
            configPath: f.configPath,
            openDatabase,
            now: () => NOW,
            log: vi.fn(),
        },
    );
    if (!('output' in result)) throw new Error(result.reason);
    return (result.output.hookSpecificOutput as { additionalContext: string }).additionalContext;
}

afterEach(() => {
    vi.restoreAllMocks();
    vi.unstubAllEnvs();
});

describe('semantic retrieval and explicit search integration', () => {
    it.each([false, true])('does zero provider or vector work on both off paths (stored vectors: %s)', async (stored) => {
        const f = fixture();
        f.add('receipt shared', stored ? [1, 0] : undefined);
        if (stored) setSetting('memory-plus', 'false', f.configPath);
        vi.stubEnv('OPENAI_API_KEY', 'present-but-must-not-be-used');
        const scan = vi.spyOn(EmbeddingStore.prototype, 'scan');
        const reader = new SessionReader(f.db);
        const query = tokenizeRecallQuery('receipt')!;
        const lexical = await lexicalRecall(reader, projects(f), query, 'global', undefined, NOW, 'strict');
        expect((await semanticRecall(f.db, [f.project.id], query.display)).candidates).toEqual([]);
        expect(renderSemanticUnion(f.db, projects(f), query, 'global', lexical, { candidates: [] }, NOW)).toBe(lexical);
        const mcp = text(await new ElephaMcpService(f.db).recall({ query: 'receipt' }));
        expect(mcp).toContain('Title: receipt shared');
        expect(mcp).not.toContain(SEMANTIC_DISCOVERY);
        const output = await hook(f);
        // Nonces are intentionally fresh on each render; all remaining bytes match.
        const withoutNonce = (body: string) => body.replace(/[a-f0-9]{8}(?:-[a-f0-9]{4}){3}-[a-f0-9]{12}/g, 'NONCE');
        expect(withoutNonce(output)).toContain(withoutNonce(lexical.body));
        expect(f.factory).not.toHaveBeenCalled();
        expect(scan).not.toHaveBeenCalled();
        expect(f.provider.embed).not.toHaveBeenCalled();
    });

    it('ranks known cosines, keeps only the top five, and rejects incompatible model spaces', async () => {
        const f = fixture();
        const opposite = f.add('opposite', [-1, 0]);
        const perpendicular = f.add('perpendicular', [0, 2]);
        const middle = f.add('middle', [3, 4]);
        const close = f.add('close', [4, 3]);
        const nearest = f.add('nearest', [3, 0]);
        const tied = f.add('tied', [2, 0]);
        f.add('different model', [1, 0], { ...configuration, model: 'other' });
        f.add('different revision', [1, 0], { ...configuration, revision: 'v2' });
        f.add('different dimensions', [1, 0, 0], { ...configuration, dimensions: 3 });
        const before = f.db.prepare('SELECT * FROM session_embeddings ORDER BY session_id').all();
        const result = await semanticRecall(f.db, [f.project.id], 'recovery');
        expect(result.candidates.map((candidate) => candidate.sessionId)).toEqual([
            tied.id,
            nearest.id,
            close.id,
            middle.id,
            perpendicular.id,
        ]);
        expect(result.candidates.map((candidate) => candidate.similarity)).toEqual([1, 1, 0.8, 0.6, 0]);
        expect(result.candidates).toHaveLength(SEMANTIC_RECALL_MAX_HITS);
        expect(result.candidates.some((candidate) => candidate.sessionId === opposite.id)).toBe(false);
        expect(f.provider.embed).toHaveBeenCalledWith('recovery', expect.any(Function), 'query');
        expect(f.provider.dispose).toHaveBeenCalledOnce();
        expect(f.db.prepare('SELECT * FROM session_embeddings ORDER BY session_id').all()).toEqual(before);
    });

    it.each([8, 12])('streams and ranks %s vectors by similarity then newest stored session', async (count) => {
        const f = fixture();
        const expected = Array.from({ length: count }, (_, index) => {
            const vector = [(index % 4) - 1, (index % 3) + 1];
            const session = f.add(`stream ${index}`, vector);
            return { sessionId: session.id, similarity: vector[0] / Math.hypot(...vector) };
        })
            .sort((a, b) => b.similarity - a.similarity || b.sessionId - a.sessionId)
            .slice(0, SEMANTIC_RECALL_MAX_HITS);
        vi.spyOn(performance, 'now').mockReturnValue(0);
        let decodedSinceScore = 0;
        let peak = 0;
        let decoded = 0;
        const readFloat = Buffer.prototype.readFloatLE;
        vi.spyOn(Buffer.prototype, 'readFloatLE').mockImplementation(function (this: Buffer, offset = 0) {
            if (offset === 0) {
                decoded++;
                peak = Math.max(peak, ++decodedSinceScore);
            }
            return readFloat.call(this, offset);
        });
        const hypot = Math.hypot;
        vi.spyOn(Math, 'hypot').mockImplementation((...values) => {
            decodedSinceScore = 0;
            return hypot(...values);
        });
        const result = await semanticRecall(f.db, [f.project.id], 'recovery');
        expect(result.candidates).toEqual(expected);
        expect(result.truncation).toBeUndefined();
        expect(decoded).toBe(count);
        expect(peak).toBe(1);
    });

    it.each([1, 10])('caps decoded rows, omits oldest stored sessions and serves the loss at %s times the row budget', async (multiple) => {
        const f = fixture();
        const old = f.add('old best match', [1, 0]);
        for (let index = 0; index < SEMANTIC_SCAN_MAX_ROWS * multiple; index++) f.add(`new ${index}`, [1, 0]);
        vi.spyOn(performance, 'now').mockReturnValue(0);
        const decode = vi.spyOn(Buffer.prototype, 'readFloatLE');
        const result = await semanticRecall(f.db, [f.project.id], 'recovery');
        expect(decode).toHaveBeenCalledTimes(SEMANTIC_SCAN_MAX_ROWS * configuration.dimensions);
        expect(result.candidates.some((candidate) => candidate.sessionId === old.id)).toBe(false);
        const marker = semanticModule.semanticScanTruncation('rows');
        for (const output of [
            text(await new ElephaMcpService(f.db).recall({ query: 'recovery' })),
            await hook(f, 'elepha:query recovery'),
            await hook(f, 'elepha:query:here recovery'),
            await hook(f, 'Find a previous recovery decision'),
        ])
            expect(output).toContain(marker);
    });

    it('reports elapsed-time truncation even when no compatible candidates were found', async () => {
        const f = fixture();
        f.add('older match', [1, 0]);
        f.add('new incompatible', [1, 0], { ...configuration, revision: 'old' });
        let elapsed = 0;
        vi.spyOn(performance, 'now').mockImplementation(() => elapsed);
        const readFloat = Buffer.prototype.readFloatLE;
        vi.spyOn(Buffer.prototype, 'readFloatLE').mockImplementation(function (this: Buffer, offset = 0) {
            elapsed = SEMANTIC_SCAN_BUDGET_MS;
            return readFloat.call(this, offset);
        });
        const output = text(await new ElephaMcpService(f.db).recall({ query: 'recovery' }));
        expect(output).not.toContain('Title: older match');
        expect(output).toContain(semanticModule.semanticScanTruncation('time'));
        elapsed = 0;
        expect(await hook(f, 'Find a previous recovery decision')).toContain(semanticModule.semanticScanTruncation('time'));
    });

    it('rejects oversized stored vectors before decoding their elements', async () => {
        const f = fixture();
        f.add('oversized', [1, 0]);
        f.db
            .prepare('UPDATE session_embeddings SET dimensions = ?, vector = zeroblob(?)')
            .run(SEMANTIC_SCAN_MAX_VECTOR_BYTES / 4 + 1, SEMANTIC_SCAN_MAX_VECTOR_BYTES + 4);
        const decode = vi.spyOn(Buffer.prototype, 'readFloatLE');
        await expect(semanticRecall(f.db, [f.project.id], 'recovery')).rejects.toThrow('stored embedding exceeds');
        expect(decode).not.toHaveBeenCalled();
    });

    it('unions lexical and semantic sessions once in semantic order on MCP and both query commands', async () => {
        const f = fixture();
        const lexicalOnly = f.add('receipt lexical-only');
        const shared = f.add('receipt shared', [4, 3]);
        const semanticOnly = f.add('Payment recovery', [1, 0]);
        const query = tokenizeRecallQuery('receipt')!;
        const lexical = await lexicalRecall(new SessionReader(f.db), projects(f), query, 'global', undefined, NOW, 'lax');
        expect(lexical.sessionIds).toEqual([lexicalOnly.id, shared.id]);
        const semantic = await semanticRecall(f.db, [f.project.id], query.display);
        const expected = [semanticOnly.id, shared.id, lexicalOnly.id];
        expect(unionRecallIds(lexical.sessionIds, semantic.candidates)).toEqual(expected);
        const union = renderSemanticUnion(f.db, projects(f), query, 'global', lexical, semantic, NOW);
        expect(union.sessionIds).toEqual(expected);
        const mcp = text(await new ElephaMcpService(f.db).recall({ query: 'receipt' }));
        for (const output of [mcp, await hook(f), await hook(f, 'elepha:query:here receipt')]) {
            const titles = ['Payment recovery', 'receipt shared', 'receipt lexical-only'];
            expect(titles.map((title) => output.indexOf(title))).toEqual(
                titles.map((title) => output.indexOf(title)).sort((a, b) => a - b),
            );
            for (const title of titles) expect(output.match(new RegExp(`(?:Title: |· )${title}`, 'g'))).toHaveLength(1);
            expect(output.split(SEMANTIC_DISCOVERY)).toHaveLength(3);
        }
        expect(mcp).toContain('Tool/surface: Codex CLI');
        const sessionId = mcp.match(/^Session: (.+)$/m)![1];
        expect(JSON.parse(Buffer.from(sessionId, 'base64url').toString())).toEqual({
            tool: 'codex',
            nativeId: 'Payment recovery',
            segmentIndex: 0,
        });
        expect(mcp).toContain('Date: 2026-09-14');
        expect(mcp).toContain('First prompt: Payment recovery');
        expect(f.store.shownSessionLists.forChat('codex', 'current')).toEqual(expected);
    });

    it('preserves all lexical-only hits when five semantic sessions fill the semantic quota', async () => {
        const f = fixture();
        const lexical = Array.from({ length: 5 }, (_, index) => f.add(`receipt ${index}`).id);
        const semantic = Array.from({ length: 5 }, (_, index) => f.add(`semantic ${index}`, [1, index]).id);
        await hook(f);
        expect(f.store.shownSessionLists.forChat('codex', 'current')).toEqual([...semantic, ...lexical]);
    });

    it('preserves the five-of-six lexical total and strict fallback when a semantic-only hit joins', async () => {
        const f = fixture();
        const lexicalSessions = Array.from({ length: 6 }, (_, index) => f.add(`receipt recovery ledger ${index}`));
        f.add('Payment history', [1, 0]);
        const query = tokenizeRecallQuery('receipt recovery ledger missing')!;
        const lexical = await lexicalRecall(new SessionReader(f.db), projects(f), query, 'global', undefined, NOW, 'strict');
        expect(lexical.body).toContain('(5 shown of 6)');
        expect(lexical.body).toContain('+1 more matches');
        expect(lexical.body).toContain(STRICT_RECALL_FALLBACK_NOTICE);
        const semantic = await semanticRecall(f.db, [f.project.id], query.display);
        const union = renderSemanticUnion(f.db, projects(f), query, 'global', lexical, semantic, NOW);
        for (const output of [
            union.body,
            await hook(f, `elepha:query ${query.display}`),
            await hook(f, `elepha:query:here ${query.display}`),
        ]) {
            expect.soft(output).toContain('(6 shown of 7)');
            expect.soft(output).toContain('+1 more matches');
            expect.soft(output).toContain(STRICT_RECALL_FALLBACK_NOTICE);
        }
        // A semantic hit can recover the lexical match that the lexical cap hid.
        const recovered = renderSemanticUnion(
            f.db,
            projects(f),
            query,
            'global',
            lexical,
            { candidates: [...semantic.candidates, { sessionId: lexicalSessions[5].id, similarity: 0.9 }] },
            NOW,
        );
        expect(recovered.body).toContain('(7 shown of 7)');
        expect(recovered.body).not.toContain('+1 more matches');
        expect(recovered.body).toContain(STRICT_RECALL_FALLBACK_NOTICE);
    });

    it('keeps the newest tied vectors and serves the hit-cap loss on every semantic surface', async () => {
        const f = fixture();
        const sessions = Array.from({ length: SEMANTIC_RECALL_MAX_HITS + 1 }, (_, index) => f.add(`tied ${index}`, [1, 0]));
        const result = await semanticRecall(f.db, [f.project.id], 'recovery');
        expect.soft(result.candidates.map((candidate) => candidate.sessionId)).toEqual(
            sessions
                .slice(1)
                .reverse()
                .map((session) => session.id),
        );
        for (const output of [
            text(await new ElephaMcpService(f.db).recall({ query: 'recovery' })),
            await hook(f, 'elepha:query recovery'),
            await hook(f, 'elepha:query:here recovery'),
            await hook(f, 'Find a previous recovery decision'),
        ]) {
            expect.soft(output).toContain(semanticModule.semanticHitCapTruncation(1));
            expect.soft(output).not.toContain(semanticModule.semanticScanTruncation('rows'));
            expect.soft(output).not.toContain(semanticModule.semanticScanTruncation('time'));
        }
    });

    it('composes scan truncation, semantic hit-cap loss and omitted lexical matches', async () => {
        const f = fixture();
        for (let index = 0; index < 6; index++) f.add(`receipt recovery ledger ${index}`);
        for (let index = 0; index <= SEMANTIC_SCAN_MAX_ROWS; index++) f.add(`semantic ${index}`, [1, 0]);
        vi.spyOn(performance, 'now').mockReturnValue(0);
        for (const output of [
            await hook(f, 'elepha:query receipt recovery ledger missing'),
            await hook(f, 'elepha:query:here receipt recovery ledger missing'),
        ]) {
            expect.soft(output).toContain('(10 shown of 11)');
            expect.soft(output).toContain('+1 more matches');
            expect.soft(output).toContain(STRICT_RECALL_FALLBACK_NOTICE);
            expect.soft(output).toContain(semanticModule.semanticScanTruncation('rows'));
            expect.soft(output).toContain(semanticModule.semanticHitCapTruncation(SEMANTIC_SCAN_MAX_ROWS - SEMANTIC_RECALL_MAX_HITS));
        }
    });

    it('scopes semantic-only hits to the requested project on MCP and query:here', async () => {
        const f = fixture();
        f.add('Payment recovery', [1, 0]);
        const other = seedProject(f, { path: path.join(f.directory, 'other') });
        mkdirSync(other.path);
        seedConsentRoot(f, { path: other.path });
        const otherSession = seedSession(f, { project: other, nativeId: 'other', title: 'Deployment options' });
        f.embeddings.write(
            f.embeddings.source(otherSession.id)!,
            configuration,
            [1, 0],
            withMemoryReadGeneration(f.db, lockedEmbedding, (token) => token),
        );
        const service = new ElephaMcpService(f.db);
        expect(text(await service.recall({ query: 'receipt', project: other.path }))).not.toContain('Payment recovery');
        expect(text(await service.recall({ query: 'receipt', project: f.project.path }))).toContain('Payment recovery');
        expect(text(await service.recall({ query: 'receipt', project: other.path }))).toContain('Deployment options');
        const here = await hook(f, 'elepha:query:here receipt');
        expect(here).toContain('Payment recovery');
        expect(here).not.toContain('Deployment options');
        expect(await hook(f)).toContain('Deployment options');
    });

    it.each(['revoke', 'incognito', 'disable', 'lock-unlock'] as const)('revalidates after awaited query inference: %s', async (action) => {
        const f = fixture();
        const session = f.add('receipt shared', [1, 0]);
        registerParanoidDatabase(f.db, f.dbPath, randomBytes(32));
        enableParanoidMode(f.db, 'passphrase');
        unlockMemory(f.db, 'passphrase');
        vi.mocked(f.provider.embed).mockImplementation(async () => {
            if (action === 'revoke') f.store.consent.revoke(f.project.path);
            if (action === 'incognito') f.store.recordIncognitoTranscript(session.tool, session.native_id);
            if (action === 'disable') setSetting('memory-plus', 'false', f.configPath);
            if (action === 'lock-unlock') {
                lockMemory(f.db);
                unlockMemory(f.db, 'passphrase');
            }
            return [1, 0];
        });
        const result = new ElephaMcpService(f.db).recall({ query: 'receipt' });
        if (action === 'disable' || action === 'lock-unlock') await expect(result).rejects.toThrow();
        else expect(text(await result)).not.toContain('receipt shared');
        expect(f.provider.dispose).toHaveBeenCalledOnce();
    });

    it.each(['revoke', 'incognito'] as const)('drops stale lexical and semantic hook hits after %s during inference', async (action) => {
        const f = fixture();
        const session = f.add('receipt shared', [1, 0]);
        vi.mocked(f.provider.embed).mockImplementation(async () => {
            if (action === 'revoke') f.store.consent.revoke(f.project.path);
            else f.store.recordIncognitoTranscript(session.tool, session.native_id);
            return [1, 0];
        });
        expect(await hook(f)).not.toContain('receipt shared');
        expect(f.store.shownSessionLists.forChat('codex', 'current')).toEqual([]);
    });

    it('rechecks consent after asynchronous provider disposal', async () => {
        const f = fixture();
        f.add('Payment recovery', [1, 0]);
        vi.mocked(f.provider.dispose).mockImplementation(async () => {
            f.store.consent.revoke(f.project.path);
        });
        expect((await semanticRecall(f.db, [f.project.id], 'receipt')).candidates).toEqual([]);
    });

    it('reports inference failure and always disposes the provider', async () => {
        const f = fixture();
        f.add('Payment recovery', [1, 0]);
        vi.mocked(f.provider.embed).mockRejectedValue(new Error('provider unavailable'));
        await expect(semanticRecall(f.db, [f.project.id], 'receipt')).rejects.toThrow('provider unavailable');
        expect(f.provider.dispose).toHaveBeenCalledOnce();
    });
});

describe('consented vector scan', () => {
    it.each(['revoke', 'incognito', 'purged', 'source-changed'] as const)('does not return stored but ineligible vectors: %s', (action) => {
        const f = fixture();
        const session = f.add('Payment recovery', [1, 0]);
        if (action === 'revoke') f.db.prepare("UPDATE consent_roots SET state = 'denied'").run();
        if (action === 'incognito')
            f.db.prepare('INSERT INTO incognito_transcripts VALUES (?, ?, ?)').run('codex', session.native_id, 'now');
        if (action === 'purged') f.db.prepare('INSERT INTO purged_transcripts VALUES (?, ?, ?)').run('codex', session.native_id, 'now');
        if (action === 'source-changed') f.db.prepare("UPDATE sessions SET title = 'Changed'").run();
        expect(f.db.prepare('SELECT COUNT(*) AS count FROM session_embeddings').get()).toEqual({ count: 1 });
        expect(scan(f.embeddings, [f.project.id])).toEqual([]);
    });

    it('rejects revocation between listing projects and reading vectors, even when the vector survives', () => {
        const f = fixture();
        f.add('Payment recovery', [1, 0]);
        const original = ProjectResolver.prototype.listConsentedStored;
        vi.spyOn(ProjectResolver.prototype, 'listConsentedStored').mockImplementation(function (this: ProjectResolver, consent) {
            const listed = original.call(this, consent);
            f.db.prepare("UPDATE consent_roots SET state = 'denied'").run();
            return listed;
        });
        expect(() => scan(f.embeddings, [f.project.id])).toThrow(EMBEDDING_SOURCE_CHANGED);
        expect(f.db.prepare('SELECT COUNT(*) AS count FROM session_embeddings').get()).toEqual({ count: 1 });
    });

    it('returns vector identity and dimensions only within the requested project set', () => {
        const f = fixture();
        const session = f.add('Payment recovery', [3, 4]);
        expect(scan(f.embeddings, [])).toEqual([]);
        expect(scan(f.embeddings, [f.project.id])).toEqual([
            { sessionId: session.id, model: 'fixture', revision: 'v1', dimensions: 2, vector: [3, 4] },
        ]);
    });
});
