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
    name IN ('filtered_turns', 'durable_capture_status', 'durable_capture_usage', 'session_embeddings', 'open_turns')
    OR lower(name) GLOB 'filtered_turns_fts*'
    OR lower(tbl_name) GLOB 'filtered_turns_fts*'
    OR lower(tbl_name) IN ('filtered_turns', 'durable_capture_status', 'durable_capture_usage', 'open_turns')
    OR lower(tbl_name) = 'session_embeddings'
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
function schemaTokens(sql: string | null): string[] {
    if (sql === null) {
        return [];
    }
    const tokens =
        sql.match(
            /'(?:''|[^'])*'|"(?:""|[^"])*"|`(?:``|[^`])*`|\[(?:\]\]|[^\]])*\]|--[^\r\n]*|\/\*[\s\S]*?\*\/|[a-z_][a-z0-9_]*|\d+(?:\.\d+)?|<=|>=|<>|!=|==|\S/gi,
        ) ?? [];
    return tokens
        .filter((token) => !token.startsWith('--') && !token.startsWith('/*'))
        .map((token) => (token.startsWith("'") ? token : normalizeIdentifier(token)));
}

const LEGACY_SESSION_FK_CHILDREN = new Set(['memories', 'session_rollups', 'first_prompt_search_backfill_skips', 'open_turns']);

export function tableClauseSignature(sql: string | null, table: string, allowLegacySessionForeignKeys = false): string {
    const tokens = schemaTokens(sql);
    const tableName = table.toLowerCase();
    const reject = (): never => {
        throw new Error('Unsupported CREATE TABLE declaration.');
    };
    if (tokens[0] !== 'create' || tokens[1] !== 'table' || tokens[2] !== tableName || tokens[3] !== '(' || tokens.at(-1) !== ')') {
        reject();
    }
    const clauses: string[][] = [];
    let clause: string[] = [];
    let depth = 0;
    for (const token of tokens.slice(4, -1)) {
        depth += Number(token === '(') - Number(token === ')');
        if (depth < 0) {
            reject();
        }
        if (token === ',' && depth === 0) {
            if (clause.length === 0) {
                reject();
            }
            clauses.push(clause);
            clause = [];
        } else {
            clause.push(token);
        }
    }
    if (depth !== 0 || clause.length === 0) {
        reject();
    }
    clauses.push(clause);
    const normalized = clauses.map((tokens) => {
        if (
            tableName === 'sessions' &&
            (tokens[0] === 'rendered_chars' || tokens[0] === 'rendered_turns') &&
            tokens.length === 2 &&
            tokens[1] === 'integer'
        ) {
            return `${tokens.join(' ')} default 0`;
        }
        if (allowLegacySessionForeignKeys && LEGACY_SESSION_FK_CHILDREN.has(tableName)) {
            const reference = tokens.findIndex(
                (token, index) => index > 0 && tokens[index - 1] === 'references' && token === 'sessions_old',
            );
            if (reference >= 0) {
                tokens[reference] = 'sessions';
            }
        }
        return tokens.join(' ');
    });
    return JSON.stringify(normalized.sort((left, right) => (left < right ? -1 : left > right ? 1 : 0)));
}

function objectSignature(rows: readonly SchemaObjectRow[], normalizeLegacyOpenTurnSessionForeignKey = false): string {
    return JSON.stringify(
        rows.map((row) => {
            const tokens = schemaTokens(row.sql);
            if (normalizeLegacyOpenTurnSessionForeignKey && row.type === 'table' && row.name === 'open_turns') {
                const reference = tokens.findIndex(
                    (token, index) => index > 0 && tokens[index - 1] === 'references' && token === 'sessions_old',
                );
                if (reference >= 0) {
                    tokens[reference] = 'sessions';
                }
            }
            return [row.type.toLowerCase(), row.name.toLowerCase(), row.tbl_name.toLowerCase(), tokens.join(' ')];
        }),
    );
}

interface OpenTurnForeignKeyRow {
    table: string;
    from: string;
    to: string;
    on_update: string;
    on_delete: string;
    match: string;
}

function openTurnForeignKeySignature(db: Database): string {
    const rows = db.prepare('PRAGMA foreign_key_list(open_turns)').all() as OpenTurnForeignKeyRow[];
    return JSON.stringify(
        rows
            .map((row) => [row.table, row.from, row.to, row.on_update, row.on_delete, row.match])
            .sort((left, right) => JSON.stringify(left).localeCompare(JSON.stringify(right))),
    );
}

function hasRepairableLegacyOpenTurnSessionForeignKey(db: Database): boolean {
    const expected = JSON.stringify(
        [
            ['projects', 'project_id', 'id', 'NO ACTION', 'CASCADE', 'NONE'],
            ['sessions_old', 'session_id', 'id', 'NO ACTION', 'CASCADE', 'NONE'],
        ].sort((left, right) => JSON.stringify(left).localeCompare(JSON.stringify(right))),
    );
    const parentExists = db.prepare("SELECT 1 FROM sqlite_master WHERE type IN ('table', 'view') AND lower(name) = 'sessions_old'").get();
    const hasRows = db.prepare('SELECT 1 FROM open_turns LIMIT 1').get();
    return parentExists === undefined && hasRows === undefined && openTurnForeignKeySignature(db) === expected;
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

export function assertCanonicalDurableCaptureSchema(
    candidate: Database,
    canonical: Database,
    options: { allowRepairableLegacyOpenTurnSessionForeignKey?: boolean } = {},
): void {
    const expected = canonicalObjects(canonical);
    const sqlCharacterLimit = expected.reduce((sum, object) => sum + (object.sql?.length ?? 0), 0) + 1;
    const actual = boundedCandidateObjects(candidate, expected.length + 1, sqlCharacterLimit);
    const normalizeLegacyOpenTurnSessionForeignKey =
        options.allowRepairableLegacyOpenTurnSessionForeignKey === true && hasRepairableLegacyOpenTurnSessionForeignKey(candidate);
    if (
        actual.length !== expected.length ||
        actual.some((object) => (object.sql_length ?? 0) > sqlCharacterLimit) ||
        objectSignature(actual, normalizeLegacyOpenTurnSessionForeignKey) !== objectSignature(expected)
    ) {
        throw new Error(DURABLE_CAPTURE_SCHEMA_MISMATCH);
    }
}

export function repairLegacyOpenTurnSessionForeignKey(candidate: Database, canonical: Database): boolean {
    if (!hasRepairableLegacyOpenTurnSessionForeignKey(candidate)) {
        return false;
    }
    const canonicalOpenTurnObjects = canonicalObjects(canonical).filter(
        (object) => object.name === 'open_turns' || object.tbl_name === 'open_turns',
    );
    const table = canonicalOpenTurnObjects.find((object) => object.type === 'table' && object.name === 'open_turns');
    if (table?.sql === null || table?.sql === undefined) {
        throw new Error(DURABLE_CAPTURE_SCHEMA_MISMATCH);
    }
    candidate
        .transaction(() => {
            candidate.exec('DROP TABLE open_turns');
            candidate.exec(table.sql as string);
            for (const object of canonicalOpenTurnObjects) {
                if (object !== table && object.sql !== null) {
                    candidate.exec(object.sql);
                }
            }
        })
        .immediate();
    return true;
}

function exactUsage(db: Database): number {
    const filtered = Number(
        (
            db
                .prepare(
                    `SELECT COALESCE(SUM(
                         length(CAST(user_prompt AS BLOB)) +
                         length(CAST(assistant_response AS BLOB)) +
                         COALESCE(length(CAST(assistant_structure AS BLOB)), 0) +
                         length(CAST(tool_calls AS BLOB))
                     ), 0) AS total_bytes
                 FROM filtered_turns`,
                )
                .get() as { total_bytes: number }
        ).total_bytes,
    );
    const staged = Number(
        (
            db
                .prepare(
                    `SELECT COALESCE(SUM(
                         length(CAST(durable_user_prompt AS BLOB)) +
                         length(CAST(durable_assistant_response AS BLOB)) +
                         COALESCE(length(CAST(durable_assistant_structure AS BLOB)), 0) +
                         length(CAST(durable_tool_calls AS BLOB))
                     ), 0) AS total_bytes
                 FROM open_turns
                 WHERE durable_user_prompt IS NOT NULL`,
                )
                .get() as { total_bytes: number }
        ).total_bytes,
    );
    return filtered + staged;
}

// Private restore stages and exclusively-owned installed candidates are the
// only callers. Every operation is synchronous and database-only so the whole
// repair either commits together or leaves the candidate unchanged.
export function normalizeAndVerifyDurableCapture(db: Database): void {
    db.transaction(() => {
        // A restored cache has no current provider/source/consent proof. Rebuild
        // vectors explicitly from the restored, normalized source material.
        db.exec('DELETE FROM session_embeddings');
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
