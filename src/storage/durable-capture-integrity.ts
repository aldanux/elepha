import type { Database } from 'better-sqlite3-multiple-ciphers';
import { applySanitize, planSanitize, verifySanitize } from './sanitize-backfill.js';

export const DURABLE_CAPTURE_SCHEMA_MISMATCH = 'Backup durable-capture schema does not match the current elepha schema after migration.';

interface SchemaObjectRow {
    type: string;
    name: string;
    tbl_name: string;
    sql: string | null;
    sql_length?: number;
}

const DURABLE_SCHEMA_OBJECTS = `
    name IN ('filtered_turns', 'durable_capture_status', 'durable_capture_usage')
    OR lower(name) GLOB 'filtered_turns_fts*'
    OR lower(tbl_name) GLOB 'filtered_turns_fts*'
    OR lower(tbl_name) IN ('filtered_turns', 'durable_capture_status', 'durable_capture_usage')
    OR (type IN ('trigger', 'index') AND lower(tbl_name) IN ('memories', 'session_rollups'))
`;

function normalizeIdentifier(token: string): string {
    if (token.startsWith('"')) {
        return token.slice(1, -1).replaceAll('""', '"').toLowerCase();
    }
    if (token.startsWith('`')) {
        return token.slice(1, -1).replaceAll('``', '`').toLowerCase();
    }
    if (token.startsWith('[')) {
        return token.slice(1, -1).replaceAll(']]', ']').toLowerCase();
    }
    return token.toLowerCase();
}

// Compare parsed SQL tokens so harmless formatting, keyword case, and
// identifier quoting differences from supported ALTER migrations do not make
// an otherwise canonical object fail raw byte equality. String literals stay
// case-sensitive because they carry CHECK and FTS command semantics.
function normalizeSchemaSql(sql: string | null): string {
    if (sql === null) {
        return '';
    }
    const tokens =
        sql.match(/'(?:''|[^'])*'|"(?:""|[^"])*"|`(?:``|[^`])*`|\[(?:\]\]|[^\]])*\]|[a-z_][a-z0-9_]*|\d+(?:\.\d+)?|<=|>=|<>|!=|==|\S/gi) ??
        [];
    return tokens.map((token) => (token.startsWith("'") ? token : normalizeIdentifier(token))).join(' ');
}

function objectSignature(rows: readonly SchemaObjectRow[]): string {
    return JSON.stringify(
        rows.map((row) => [row.type.toLowerCase(), row.name.toLowerCase(), row.tbl_name.toLowerCase(), normalizeSchemaSql(row.sql)]),
    );
}

function canonicalObjects(db: Database): SchemaObjectRow[] {
    return db
        .prepare(
            `SELECT type, name, tbl_name, sql
             FROM sqlite_master
             WHERE ${DURABLE_SCHEMA_OBJECTS}
             ORDER BY type, name`,
        )
        .all() as SchemaObjectRow[];
}

function boundedCandidateObjects(db: Database, objectLimit: number, sqlCharacterLimit: number): SchemaObjectRow[] {
    return db
        .prepare(
            `SELECT type, name, tbl_name,
                    substr(sql, 1, ?) AS sql,
                    length(COALESCE(sql, '')) AS sql_length
             FROM sqlite_master
             WHERE ${DURABLE_SCHEMA_OBJECTS}
             ORDER BY type, name
             LIMIT ?`,
        )
        .all(sqlCharacterLimit, objectLimit) as SchemaObjectRow[];
}

export function assertCanonicalDurableCaptureSchema(candidate: Database, canonical: Database): void {
    const expected = canonicalObjects(canonical);
    const sqlCharacterLimit = expected.reduce((sum, object) => sum + (object.sql?.length ?? 0), 0) + 1;
    const actual = boundedCandidateObjects(candidate, expected.length + 1, sqlCharacterLimit);
    if (
        actual.length !== expected.length ||
        actual.some((object) => (object.sql_length ?? 0) > sqlCharacterLimit) ||
        objectSignature(actual) !== objectSignature(expected)
    ) {
        throw new Error(DURABLE_CAPTURE_SCHEMA_MISMATCH);
    }
}

function exactUsage(db: Database): number {
    return Number(
        (
            db
                .prepare(
                    `SELECT COALESCE(SUM(
                         length(CAST(user_prompt AS BLOB)) +
                         length(CAST(assistant_response AS BLOB)) +
                         length(CAST(tool_calls AS BLOB))
                     ), 0) AS total_bytes
                     FROM filtered_turns`,
                )
                .get() as { total_bytes: number }
        ).total_bytes,
    );
}

// Private restore stages and exclusively-owned installed candidates are the
// only callers. Every operation is synchronous and database-only so the whole
// repair either commits together or leaves the candidate unchanged.
export function normalizeAndVerifyDurableCapture(db: Database): void {
    db.transaction(() => {
        applySanitize(db);
        db.exec("INSERT INTO filtered_turns_fts(filtered_turns_fts) VALUES ('rebuild')");
        const measured = exactUsage(db);
        db.prepare(
            `INSERT INTO durable_capture_usage (id, total_bytes) VALUES (1, ?)
             ON CONFLICT(id) DO UPDATE SET total_bytes = excluded.total_bytes`,
        ).run(measured);
        try {
            db.exec("INSERT INTO filtered_turns_fts(filtered_turns_fts, rank) VALUES ('integrity-check', 1)");
        } catch (error) {
            throw new Error('Durable capture FTS does not match its external content.', { cause: error });
        }
        if (verifySanitize(db).length > 0) {
            throw new Error('Durable capture normalization left active shell/control syntax.');
        }
        if (planSanitize(db).changes.length > 0) {
            throw new Error('Durable capture normalization is not idempotent.');
        }
        const usageRows = db.prepare('SELECT id, total_bytes FROM durable_capture_usage').all() as Array<{
            id: number;
            total_bytes: number;
        }>;
        if (usageRows.length !== 1 || usageRows[0]?.id !== 1 || usageRows[0].total_bytes !== exactUsage(db)) {
            throw new Error('Durable capture usage does not equal the exact stored byte sum.');
        }
    }).immediate();
}
