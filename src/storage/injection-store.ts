import { createHash } from 'node:crypto';
import type { Database, Statement } from 'better-sqlite3';
import { normalizeForNearVerbatim } from '../security/self-ingestion.js';
import type { ToolName } from '../types/index.js';

export interface InjectionRow {
    id: number;
    tool: ToolName;
    native_session_id: string;
    injected_at: string;
    injection_id: string;
    body_hash: string;
    body: string;
}

export interface RecordInjectionInput {
    tool: ToolName;
    nativeSessionId: string;
    injectedAt: string;
    injectionId: string;
    body: string;
}

export class InjectionStore {
    private readonly stmts: { insertInjection: Statement; injectionsForSession: Statement };

    constructor(db: Database) {
        this.stmts = {
            insertInjection: db.prepare(
                `INSERT OR IGNORE INTO injections (tool, native_session_id, injected_at, injection_id, body_hash, body)
                 VALUES (@tool, @native_session_id, @injected_at, @injection_id, @body_hash, @body)`,
            ),
            injectionsForSession: db.prepare(
                `SELECT * FROM injections
                 WHERE tool = ? AND native_session_id = ? AND injected_at <= ?
                 ORDER BY injected_at ASC, id ASC`,
            ),
        };
    }

    // Stores a future injection's exact body once; normalized-hash uniqueness makes repeats safe.
    recordInjection(input: RecordInjectionInput): boolean {
        const bodyHash = createHash('sha256').update(normalizeForNearVerbatim(input.body)).digest('hex');
        const result = this.stmts.insertInjection.run({
            tool: input.tool,
            native_session_id: input.nativeSessionId,
            injected_at: input.injectedAt,
            injection_id: input.injectionId,
            body_hash: bodyHash,
            body: input.body,
        });
        if (result.changes > 0) {
            return true;
        }
        // INSERT OR IGNORE is not proof: SQLite can ignore for a different
        // constraint or a damaged statement. A repeated body is durable only
        // when the exact scoped row is observable before stdout is written.
        return this.injectionsForSession(input.tool, input.nativeSessionId, input.injectedAt).some(
            (row) => row.body_hash === bodyHash && row.body === input.body,
        );
    }

    injectionsForSession(tool: ToolName, nativeSessionId: string, atOrBefore: string): InjectionRow[] {
        return this.stmts.injectionsForSession.all(tool, nativeSessionId, atOrBefore) as InjectionRow[];
    }
}
