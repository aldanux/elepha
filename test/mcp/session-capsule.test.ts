import { mkdirSync } from 'node:fs';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';
import { afterEach, describe, expect, it, vi } from 'vitest';
import {
    FIRST_PROMPT_SEARCH_CAP,
    PROJECT_AUTHORIZATION_ROW_MAX_BYTES,
    SESSION_CAPSULE_MAX_CONTEXT_CHARS,
    SESSION_CAPSULE_METADATA_MAX_BYTES,
    SESSION_CAPSULE_PENDING_CHARS,
} from '../../src/config/constants.js';
import { createMcpServer } from '../../src/mcp/server.js';
import { ElephaMcpService } from '../../src/mcp/tools.js';
import { detectShellSyntax } from '../../src/security/sanitize.js';
import {
    CAPSULE_FIXED_METADATA_BUDGET,
    CAPSULE_INVALID_SELECTION,
    CAPSULE_METADATA_BYTE_BUDGET,
    CAPSULE_OPENING_LABEL,
} from '../../src/serving/session-capsule.js';
import { publicSessionId } from '../../src/serving/session-id.js';
import { SessionReader } from '../../src/serving/session-reader.js';
import { LOCKED_MCP_RESULT, registerParanoidDatabase } from '../../src/storage/paranoid-gate.js';
import { ProjectResolver } from '../../src/storage/project-resolver.js';
import { createTestDb, seedConsentRoot, seedMemory, seedProject, seedRollup, seedSession } from '../helpers/db.js';

function fixture() {
    const f = createTestDb('session-capsule-');
    const project = seedProject(f);
    mkdirSync(project.path, { recursive: true });
    seedConsentRoot(f, { path: project.path });
    const session = seedSession(f, { project, title: 'Recovery work' });
    seedMemory(f, { project, session, turnIndex: 4 });
    seedRollup(f, {
        project,
        session,
        decisions: [
            { what: 'Old decision', why: 'Old rationale', turnIndex: 0 },
            { what: 'Recent decision', why: 'Recent rationale', turnIndex: 4 },
            { what: 'Middle decision', why: 'Middle rationale', turnIndex: 2 },
            { what: 'Another decision', why: 'Another rationale', turnIndex: 3 },
        ],
        instructions: [{ what: 'Standing instructions must not enter the capsule' }],
    });
    f.db
        .prepare('UPDATE session_rollups SET summary = ?, pending_items = ?, rolled_up_through_turn_index = 3 WHERE session_id = ?')
        .run('Recovery was implemented.', '["Verify restart recovery"]', session.id);
    return { ...f, project, session, id: publicSessionId(session), service: new ElephaMcpService(f.db) };
}

function text(result: Record<string, unknown>): string {
    return (result.content as Array<{ text: string }>).map((entry) => entry.text).join('\n');
}

afterEach(() => vi.restoreAllMocks());

describe('metadata-only session capsule', () => {
    it('returns the capsule without loading content, retaining newest decision provenance and rollup coverage', async () => {
        const f = fixture();
        const prepare = vi.spyOn(f.db, 'prepare');
        const render = vi.spyOn(SessionReader.prototype, 'render');
        const window = vi.spyOn(SessionReader.prototype, 'evidenceWindow');
        const first = vi.spyOn(SessionReader.prototype, 'firstInteraction');
        const result = await f.service.getSession({ id: f.id, view: 'capsule' });
        const body = text(result);
        expect(body).toContain('Recovery was implemented.');
        expect(body).toContain('Recent decision');
        expect(body).toContain('Recent rationale');
        expect(body).not.toContain('Old decision');
        expect(body).not.toContain('Standing instructions must not enter the capsule');
        expect(body).toContain('Verify restart recovery');
        expect(body).toContain('1 newer stored turn');
        expect(body).toContain('1 decision(s) omitted');
        expect(result.structuredContent).toBeUndefined();
        expect(render).not.toHaveBeenCalled();
        expect(window).not.toHaveBeenCalled();
        expect(first).not.toHaveBeenCalled();
        expect(prepare.mock.calls.map(([sql]) => sql).join('\n')).not.toMatch(/s\.\*|ft\.(user_prompt|assistant_response)|source_path/);
    });

    it.each([{ query: 'recovery' }, { last_n: 2 }])('rejects a mixed capsule selector before loading content: %s', async (selector) => {
        const f = fixture();
        const render = vi.spyOn(SessionReader.prototype, 'render');
        const first = vi.spyOn(SessionReader.prototype, 'firstInteraction');
        const result = await f.service.getSession({ id: f.id, view: 'capsule', ...selector });
        expect(result.structuredContent).toMatchObject({ reason: CAPSULE_INVALID_SELECTION });
        expect(text(result)).not.toContain('Recovery was implemented.');
        expect(render).not.toHaveBeenCalled();
        expect(first).not.toHaveBeenCalled();
    });

    it('projects no variable text when the combined UTF-8 row budget binds', async () => {
        const f = fixture();
        const large = '漢'.repeat(Math.floor(SESSION_CAPSULE_METADATA_MAX_BYTES / 6));
        const decisions = JSON.stringify([{ what: large, why: 'Preserve this reason' }]);
        expect(Buffer.byteLength(large)).toBeLessThan(SESSION_CAPSULE_METADATA_MAX_BYTES);
        expect(Buffer.byteLength(decisions)).toBeLessThan(SESSION_CAPSULE_METADATA_MAX_BYTES);
        f.db.prepare('UPDATE session_rollups SET summary = ?, decisions = ? WHERE session_id = ?').run(large, decisions, f.session.id);
        const row = new SessionReader(f.db).capsuleByNaturalKey({ tool: f.session.tool, nativeId: f.session.native_id, segmentIndex: 0 });
        expect(row?.metadata_bytes).toBeGreaterThan(SESSION_CAPSULE_METADATA_MAX_BYTES);
        expect(row).toMatchObject({ summary: null, decisions: null, pending_items: null, native_id: null, project_name: null });
        const body = text(await f.service.getSession({ id: f.id, view: 'capsule' }));
        expect(body).toContain(CAPSULE_METADATA_BYTE_BUDGET);
        expect(body).not.toContain('漢');
        expect(body.length).toBeLessThanOrEqual(SESSION_CAPSULE_MAX_CONTEXT_CHARS);
    });

    it('never hydrates oversized project display metadata during the complete capsule call', async () => {
        const f = fixture();
        const oversized = 'display-private-'.repeat(SESSION_CAPSULE_METADATA_MAX_BYTES);
        f.db.prepare('UPDATE projects SET display_name = ? WHERE id = ?').run(oversized, f.project.id);
        const prepare = vi.spyOn(f.db, 'prepare');
        const result = await f.service.getSession({ id: f.id, view: 'capsule' });
        expect(text(result)).toContain(CAPSULE_METADATA_BYTE_BUDGET);
        expect(text(result)).not.toContain('display-private-');
        expect(prepare.mock.calls.map(([sql]) => sql).join('\n')).not.toMatch(/SELECT\s+\*\s+FROM\s+projects/i);
    });

    it('fails closed instead of hydrating an oversized project grouping identity', async () => {
        const f = fixture();
        f.db
            .prepare('UPDATE projects SET git_remote = ? WHERE id = ?')
            .run('identity-'.repeat(SESSION_CAPSULE_METADATA_MAX_BYTES), f.project.id);
        const prepare = vi.spyOn(f.db, 'prepare');
        const result = await f.service.getSession({ id: f.id, view: 'capsule' });
        expect(result.structuredContent).toEqual({ empty: true, reason: 'unknown_session' });
        expect(text(result)).not.toContain('identity-');
        const authorizationSql = prepare.mock.calls.find(([sql]) => /FROM projects ORDER BY id/.test(sql))?.[0];
        expect(authorizationSql).toBeDefined();
        expect(f.db.prepare(authorizationSql ?? '').all()).toEqual([
            { id: f.project.id, path: null, git_remote: null, git_root: null, git_root_commit: null },
        ]);
    });

    it('applies one UTF-8 ceiling to the sum of authorization fields before hydration', async () => {
        const f = fixture();
        const large = '漢'.repeat(Math.floor(PROJECT_AUTHORIZATION_ROW_MAX_BYTES / 6));
        expect(Buffer.byteLength(large)).toBeLessThan(PROJECT_AUTHORIZATION_ROW_MAX_BYTES);
        f.db.prepare('UPDATE projects SET git_remote = ?, git_root_commit = ? WHERE id = ?').run(large, large, f.project.id);
        const result = await f.service.getSession({ id: f.id, view: 'capsule' });
        expect(result.structuredContent).toEqual({ empty: true, reason: 'unknown_session' });
    });

    it('does not let unrelated oversized display metadata affect or enter the target capsule', async () => {
        const f = fixture();
        const other = seedProject(f, { path: `${f.directory}/unrelated` });
        f.db
            .prepare('UPDATE projects SET display_name = ?, first_seen_at = ? WHERE id = ?')
            .run(
                'unrelated-private-'.repeat(SESSION_CAPSULE_METADATA_MAX_BYTES),
                'unrelated-time-'.repeat(SESSION_CAPSULE_METADATA_MAX_BYTES),
                other.id,
            );
        const prepare = vi.spyOn(f.db, 'prepare');
        const body = text(await f.service.getSession({ id: f.id, view: 'capsule' }));
        expect(body).toContain('Recovery was implemented.');
        expect(body).not.toContain('unrelated-private-');
        expect(body).not.toContain('unrelated-time-');
        expect(prepare.mock.calls.map(([sql]) => sql).join('\n')).not.toMatch(/SELECT\s+\*\s+FROM\s+projects/i);
    });

    it.each(['git_remote', 'git_root_commit', 'git_root', 'prefix'] as const)(
        'preserves approved-member and denied-member semantics for stored %s groups',
        async (identity) => {
            const f = fixture();
            const peerPath = identity === 'prefix' ? `${f.project.path}/child` : `${f.directory}/peer`;
            const peer = seedProject(f, { path: peerPath });
            mkdirSync(peer.path, { recursive: true });
            if (identity !== 'prefix') {
                f.db.prepare(`UPDATE projects SET ${identity} = ? WHERE id IN (?, ?)`).run('captured-identity', f.project.id, peer.id);
                // Shared Git identity alone does not authorize the peer row.
                seedConsentRoot(f, { path: peer.path });
            }
            f.db.prepare('UPDATE sessions SET project_id = ? WHERE id = ?').run(peer.id, f.session.id);
            const resolver = new ProjectResolver(f.db);
            const oldAuthorized = () =>
                new ProjectResolver(f.db).listConsentedStored(f.store.consent).flatMap((project) => project.projectIds);
            expect(oldAuthorized()).toContain(peer.id);
            expect(resolver.isStoredProjectConsented(peer.id, f.store.consent)).toBe(true);
            expect(text(await f.service.getSession({ id: f.id, view: 'capsule' }))).toContain('Recovery was implemented.');

            seedConsentRoot(f, { path: peer.path, state: 'denied' });
            expect(oldAuthorized()).not.toContain(peer.id);
            expect(resolver.isStoredProjectConsented(peer.id, f.store.consent)).toBe(false);
            const denied = await f.service.getSession({ id: f.id, view: 'capsule' });
            expect(denied.structuredContent).toEqual({ empty: true, reason: 'unknown_session' });
        },
    );

    it('uses the stored opening document without inventing an outcome when no rollup exists', async () => {
        const f = fixture();
        const session = seedSession(f, { project: f.project, nativeId: 'no-rollup', title: 'Opening-only session' });
        const opening = 'x'.repeat(FIRST_PROMPT_SEARCH_CAP);
        f.db.prepare('UPDATE sessions SET first_prompt_search = ? WHERE id = ?').run(opening, session.id);
        const body = text(await f.service.getSession({ id: publicSessionId(session), view: 'capsule' }));
        expect(body).toContain(CAPSULE_OPENING_LABEL);
        expect(body).toContain(opening);
        expect(body).not.toContain('Recovery was implemented.');
        expect(body.length).toBeLessThanOrEqual(SESSION_CAPSULE_MAX_CONTEXT_CHARS);
    });

    it('retains missing rationale, reports malformed values, and keeps the newest recorded file references', async () => {
        const f = fixture();
        f.db
            .prepare('UPDATE session_rollups SET decisions = ?, pending_items = ? WHERE session_id = ?')
            .run(
                JSON.stringify([null, { what: 'Without rationale', turnIndex: 9 }, { what: 'Escaped $(data)', why: 4 }]),
                '["Pending snapshot",42]',
                f.session.id,
            );
        f.db
            .prepare('UPDATE sessions SET trailing_files = ? WHERE id = ?')
            .run(JSON.stringify(['new-1', 'new-2', 'new-3', 'new-4', 'new-5', 'old-6']), f.session.id);
        const body = text(await f.service.getSession({ id: f.id, view: 'capsule' }));
        expect(body).toContain('Without rationale\n  Why: not recorded');
        expect(body).toContain('2 malformed field(s)/item(s) excluded');
        expect(body).toContain('1 malformed field(s)/item(s) excluded');
        expect(body).toContain('new-1');
        expect(body).toContain('new-5');
        expect(body).not.toContain('old-6');
        expect(detectShellSyntax(body)).toBe(false);
    });

    it('omits an oversized pending snapshot atomically with its item count', async () => {
        const f = fixture();
        f.db
            .prepare('UPDATE session_rollups SET pending_items = ? WHERE session_id = ?')
            .run(JSON.stringify([`Pending-atomic ${'p'.repeat(SESSION_CAPSULE_PENDING_CHARS)}`, 'Second pending']), f.session.id);
        const body = text(await f.service.getSession({ id: f.id, view: 'capsule' }));
        expect(body).not.toContain('Pending-atomic');
        expect(body).not.toContain('Second pending');
        expect(body).toContain('2 item(s) omitted; 0 malformed field(s)/item(s) excluded; size_budget');
    });

    it('returns a bounded named result when fixed identity metadata cannot fit', async () => {
        const f = fixture();
        f.db.prepare('UPDATE sessions SET title = ? WHERE id = ?').run('t'.repeat(SESSION_CAPSULE_MAX_CONTEXT_CHARS), f.session.id);
        const body = text(await f.service.getSession({ id: f.id, view: 'capsule' }));
        expect(body).toContain(CAPSULE_FIXED_METADATA_BUDGET);
        expect(body).not.toContain('Recovery was implemented.');
        expect(body.length).toBeLessThanOrEqual(SESSION_CAPSULE_MAX_CONTEXT_CHARS);
    });

    it('bounds unknown capsule identities without changing the existing unknown-session reason', async () => {
        const f = fixture();
        const result = await f.service.getSession({ id: 'x'.repeat(SESSION_CAPSULE_MAX_CONTEXT_CHARS * 2), view: 'capsule' });
        expect(result.structuredContent).toEqual({ empty: true, reason: 'unknown_session' });
        expect(text(result).length).toBeLessThanOrEqual(SESSION_CAPSULE_MAX_CONTEXT_CHARS);
    });

    it.each(['revoke', 'incognito', 'adjudicator', 'purge'] as const)('revalidates %s after initial authorization', async (action) => {
        const f = fixture();
        const authorize = ProjectResolver.prototype.isStoredProjectConsented;
        let first = true;
        vi.spyOn(ProjectResolver.prototype, 'isStoredProjectConsented').mockImplementation(function (this: ProjectResolver, ...args) {
            const authorized = authorize.apply(this, args);
            if (first) {
                first = false;
                if (action === 'revoke') f.store.consent.revoke(f.project.path);
                if (action === 'incognito') f.store.recordIncognitoTranscript(f.session.tool, f.session.native_id);
                if (action === 'adjudicator') f.db.prepare("UPDATE sessions SET kind = 'adjudicator' WHERE id = ?").run(f.session.id);
                if (action === 'purge')
                    f.db
                        .prepare('INSERT INTO purged_transcripts (tool, native_id, purged_at) VALUES (?, ?, ?)')
                        .run(f.session.tool, f.session.native_id, '2026-09-19');
            }
            return authorized;
        });
        const result = await f.service.getSession({ id: f.id, view: 'capsule' });
        expect(result.structuredContent).toMatchObject({ reason: 'unknown_session' });
        expect(text(result)).not.toContain('Recovery was implemented.');
    });

    it('does not expose metadata when the paranoid authority is locked', async () => {
        const f = fixture();
        registerParanoidDatabase(f.db, f.dbPath, Buffer.alloc(32, 7));
        f.db.prepare("UPDATE paranoid_authority SET state = 'locked', enrolled = 1, generation = generation + 1 WHERE id = 1").run();
        const result = await f.service.getSession({ id: f.id, view: 'capsule' });
        expect(result.structuredContent).toEqual(LOCKED_MCP_RESULT);
        expect(text(result)).not.toContain('Recovery was implemented.');
    });

    it('discards a capsule if the authenticated read generation changes after projection', async () => {
        const f = fixture();
        registerParanoidDatabase(f.db, f.dbPath, Buffer.alloc(32, 7));
        const read = SessionReader.prototype.capsuleByNaturalKey;
        vi.spyOn(SessionReader.prototype, 'capsuleByNaturalKey').mockImplementation(function (this: SessionReader, key) {
            const value = read.call(this, key);
            f.db.prepare("UPDATE paranoid_authority SET state = 'locked', enrolled = 1, generation = generation + 1 WHERE id = 1").run();
            return value;
        });
        const result = await f.service.getSession({ id: f.id, view: 'capsule' });
        expect(result.structuredContent).toEqual(LOCKED_MCP_RESULT);
        expect(text(result)).not.toContain('Recovery was implemented.');
    });

    it('shows validated incomplete observations separately without reading their staged bodies', async () => {
        const f = fixture();
        f.db
            .prepare(`INSERT INTO open_turns
            (tool, native_session_id, session_id, project_id, source_generation, turn_index, candidate_cursor,
             source_path, source_dev, source_ino, source_size, source_mtime_ms, source_revision, source_digest,
             failed_at, observed_at, staged_at, receipt_coverage, decisions, durable_assistant_response)
            VALUES (?, ?, ?, ?, 1, 5, '{}', 'unused', '1', '1', 0, 0, 'revision', 'digest',
             '2026-09-19T00:00:00Z', '2026-09-19T00:00:01Z', '2026-09-19T00:00:02Z', 'complete', ?, ?)`)
            .run(
                f.session.tool,
                f.session.native_id,
                f.session.id,
                f.project.id,
                '[{"what":"Unfinished staged decision"}]',
                'Staged body must not be loaded',
            );
        const body = text(await f.service.getSession({ id: f.id, view: 'capsule' }));
        expect(body).toContain('Incomplete last observation: true');
        expect(body).toContain('2026-09-19T00:00:02Z');
        expect(body).not.toContain('Unfinished staged decision');
        expect(body).not.toContain('Staged body must not be loaded');
        f.db.prepare('UPDATE open_turns SET validation_epoch = validation_epoch + 1 WHERE session_id = ?').run(f.session.id);
        expect(text(await f.service.getSession({ id: f.id, view: 'capsule' }))).toContain('Incomplete last observation: false');
    });

    it('retains atomic newest decisions and complete framing when the combined response budget binds', async () => {
        const f = fixture();
        f.db
            .prepare('UPDATE sessions SET title = ?, trailing_files = ? WHERE id = ?')
            .run('i'.repeat(1800), JSON.stringify(Array.from({ length: 5 }, (_, i) => `${i}-${'f'.repeat(180)}`)), f.session.id);
        f.db
            .prepare('UPDATE session_rollups SET summary = ?, decisions = ?, pending_items = ? WHERE session_id = ?')
            .run(
                's'.repeat(1900),
                JSON.stringify([1, 2, 3].map((turnIndex) => ({ what: `Decision-${turnIndex}`, why: 'r'.repeat(500), turnIndex }))),
                JSON.stringify(['p'.repeat(1900)]),
                f.session.id,
            );
        const body = text(await f.service.getSession({ id: f.id, view: 'capsule' }));
        expect(body.length).toBeLessThanOrEqual(SESSION_CAPSULE_MAX_CONTEXT_CHARS);
        expect(body).toContain('response_budget');
        expect(body).not.toContain(CAPSULE_FIXED_METADATA_BUDGET);
        const opening = body.match(/\[\[elepha-data ([\w-]+)\]\]/)?.[1];
        expect(opening).toBeDefined();
        expect(body).toContain(`[[elepha-end ${opening}]]`);
        if (body.includes('Decision-1')) expect(body).toContain('Decision-3');
        if (body.includes('Decision-3')) expect(body).toContain(`Why: ${'r'.repeat(500)}`);
    });

    it('preserves the existing content result for omitted and explicit content view', async () => {
        const f = fixture();
        for (const selection of [{}, { query: 'recovery' }, { last_n: 2 }]) {
            const before = await f.service.getSession({ id: f.id, ...selection });
            const after = await f.service.getSession({ id: f.id, view: 'content', ...selection });
            const normalize = (value: string) => value.replace(/[0-9a-f]{8}(?:-[0-9a-f]{4}){3}-[0-9a-f]{12}/g, 'nonce');
            expect(normalize(text(after))).toBe(normalize(text(before)));
            expect(after.structuredContent).toEqual(before.structuredContent);
        }
    });

    it('serializes the additive capsule view as model-visible MCP text', async () => {
        const f = fixture();
        const server = createMcpServer(f.service);
        const client = new Client({ name: 'capsule-test', version: '1.0.0' });
        const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
        await server.connect(serverTransport);
        await client.connect(clientTransport);
        try {
            const result = await client.callTool({ name: 'get_session', arguments: { id: f.id, view: 'capsule' } });
            expect(result.structuredContent).toBeUndefined();
            expect(text(result)).toContain('Recovery was implemented.');
        } finally {
            await client.close();
            await server.close();
        }
    });
});
