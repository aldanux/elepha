import path from 'node:path';
import type Database from 'better-sqlite3-multiple-ciphers';
import {
    PROJECT_AUTHORIZATION_ROW_MAX_BYTES,
    STANDING_RULE_IMPORT_MAX_BYTES,
    STANDING_RULES_MAX_ACTIVE,
    STANDING_RULES_MAX_TOTAL_CHARS,
} from '../config/constants.js';
import { SUPPORTED_TOOLS } from '../types/index.js';
import { ProjectResolver } from './project-resolver.js';
import type { SessionRuleRow } from './session-rules-store.js';
import { prepareImportedStandingRule, type StandingRuleRow } from './standing-rules-store.js';

export const CANDIDATE_SEMANTIC_TABLES = ['sessions', 'memories', 'session_rollups', 'consent_roots'] as const;

export type CandidateSemanticTable = (typeof CANDIDATE_SEMANTIC_TABLES)[number];

type SqlValue = string | number | bigint | Buffer | null;
type CandidateRow = Record<string, SqlValue>;

interface JsonStringArrayRule {
    column: string;
}

interface EnumRule {
    column: string;
    values: readonly SqlValue[];
    nullable?: boolean;
}

interface TableRules {
    jsonStringArrays?: readonly JsonStringArrayRule[];
    enums?: readonly EnumRule[];
}

const MAX_REPORTED_VIOLATIONS = 20;

const RULES: Record<CandidateSemanticTable, TableRules> = {
    sessions: {
        jsonStringArrays: [{ column: 'trailing_files' }],
        enums: [
            { column: 'tool', values: SUPPORTED_TOOLS },
            { column: 'surface', values: ['cli', 'desktop'], nullable: true },
            { column: 'kind', values: ['main', 'subagent', 'fork', 'adjudicator'], nullable: true },
        ],
    },
    memories: {
        jsonStringArrays: [{ column: 'files_touched' }],
        enums: [{ column: 'has_external_content', values: [0, 1] }],
    },
    session_rollups: {
        jsonStringArrays: [{ column: 'files_touched' }],
        enums: [
            { column: 'kind', values: ['primary', 'subagent'] },
            { column: 'rollup_state', values: ['live', 'final'] },
        ],
    },
    consent_roots: {
        enums: [
            { column: 'state', values: ['approved', 'denied', 'pending'] },
            { column: 'source', values: ['discovery', 'cli', 'grandfathered'] },
        ],
    },
};

function isJsonStringArray(value: SqlValue): boolean {
    if (typeof value !== 'string') {
        return false;
    }
    try {
        const parsed: unknown = JSON.parse(value);
        return Array.isArray(parsed) && parsed.every((item) => typeof item === 'string');
    } catch {
        return false;
    }
}

function selectedColumns(rules: TableRules): string[] {
    return [...(rules.jsonStringArrays ?? []), ...(rules.enums ?? [])].map((rule) => `"${rule.column}"`);
}

// Validates untrusted backup values without materializing candidate tables in memory.
export function validateCandidateSemantics(db: Database.Database, tables: readonly CandidateSemanticTable[]): string[] {
    const violations: string[] = [];
    const addViolation = (violation: string): boolean => {
        if (violations.length < MAX_REPORTED_VIOLATIONS) {
            violations.push(violation);
            return false;
        }
        violations.push(`candidate: additional violations omitted after the first ${MAX_REPORTED_VIOLATIONS}`);
        return true;
    };

    for (const table of tables) {
        const rules = RULES[table];
        const rows = db.prepare(`SELECT ${selectedColumns(rules).join(', ')} FROM "${table}"`).iterate() as Iterable<CandidateRow>;
        for (const row of rows) {
            for (const rule of rules.jsonStringArrays ?? []) {
                if (!isJsonStringArray(row[rule.column]) && addViolation(`${table}.${rule.column}: must be a JSON array of strings`)) {
                    return violations;
                }
            }
            for (const rule of rules.enums ?? []) {
                const value = row[rule.column];
                const valid = (value === null && rule.nullable === true) || rule.values.includes(value);
                if (!valid && addViolation(`${table}.${rule.column}: must be one of ${rule.values.join(', ')}`)) {
                    return violations;
                }
            }
        }
    }
    return violations;
}

// The table is optional in older exports. Bound each untrusted scalar in SQL
// before it crosses into JavaScript, then use UTF-16 length on sanitized text.
export function readCandidateStandingRules(db: Database.Database, mode: 'import' | 'restore' = 'import'): StandingRuleRow[] {
    if (db.prepare("SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = 'standing_rules'").get() === undefined) {
        return [];
    }
    const columns = new Set((db.pragma('table_info(standing_rules)') as Array<{ name: string }>).map((column) => column.name));
    const missing = ['id', 'ulid', 'project_id', 'text', 'created_at'].filter((column) => !columns.has(column));
    if (missing.length > 0) {
        throw new Error(`Backup is incompatible (standing_rules is missing required column(s): ${missing.join(', ')}).`);
    }
    const projectGroups = new Map(
        new ProjectResolver(db, { resolveGitRoot: () => null })
            .listStored()
            .flatMap((group) => group.projectIds.map((id) => [id, group.key] as const)),
    );
    const groups = new Map<string, { texts: Map<string, string>; chars: number }>();
    const ulids = new Map<string, { text: string; group: string }>();
    const ids = new Set<number>();
    const result: StandingRuleRow[] = [];
    const rows = db
        .prepare(`SELECT
        CASE WHEN typeof(id) = 'integer' THEN id END AS id,
        CASE WHEN typeof(project_id) = 'integer' THEN project_id END AS project_id,
        CASE WHEN typeof(ulid) = 'text' AND length(CAST(ulid AS BLOB)) = 26 THEN ulid END AS ulid,
        CASE WHEN typeof(text) = 'text' AND length(CAST(text AS BLOB)) <= ? THEN text END AS text,
        CASE WHEN typeof(created_at) = 'text' AND length(CAST(created_at AS BLOB)) <= ? THEN created_at END AS created_at
        FROM standing_rules ORDER BY id`)
        .iterate(STANDING_RULE_IMPORT_MAX_BYTES, STANDING_RULE_IMPORT_MAX_BYTES);
    for (const value of rows) {
        const row = value as StandingRuleRow;
        const groupKey = projectGroups.get(row.project_id);
        if (
            !Number.isSafeInteger(row.id) ||
            row.id < 1 ||
            !Number.isSafeInteger(row.project_id) ||
            groupKey === undefined ||
            ids.has(row.id)
        ) {
            throw new Error('Backup is semantically invalid: standing rule row identity or project ownership is invalid.');
        }
        const prepared = prepareImportedStandingRule(row);
        if (mode === 'restore' && prepared.text !== row.text) {
            throw new Error(`Backup is semantically invalid: standing rule ${prepared.ulid} text is not canonical sanitized text.`);
        }
        const previous = ulids.get(prepared.ulid);
        if (previous !== undefined) {
            if (mode === 'restore' || previous.text !== prepared.text || previous.group !== groupKey) {
                throw new Error(`Backup is semantically invalid: standing rule ULID collision for ${prepared.ulid}.`);
            }
            ids.add(row.id);
            result.push({ ...row, ...prepared });
            continue;
        }
        const group = groups.get(groupKey) ?? { texts: new Map<string, string>(), chars: 0 };
        const duplicate = group.texts.get(prepared.text);
        if (duplicate !== undefined) {
            throw new Error(`Backup is semantically invalid: duplicate standing rule text: ${prepared.ulid} conflicts with ${duplicate}.`);
        }
        group.texts.set(prepared.text, prepared.ulid);
        group.chars += prepared.text.length;
        if (group.texts.size > STANDING_RULES_MAX_ACTIVE || group.chars > STANDING_RULES_MAX_TOTAL_CHARS) {
            throw new Error(`Backup is semantically invalid: standing rule capacity exceeded in project ${groupKey}.`);
        }
        groups.set(groupKey, group);
        ulids.set(prepared.ulid, { text: prepared.text, group: groupKey });
        ids.add(row.id);
        result.push({ ...row, ...prepared });
    }
    return result;
}

function validCheckoutAnchor(anchor: string): boolean {
    if (anchor.includes('\0')) {
        return false;
    }
    return (
        (path.posix.isAbsolute(anchor) && path.posix.normalize(anchor) === anchor) ||
        (path.win32.isAbsolute(anchor) && path.win32.normalize(anchor) === anchor)
    );
}

// A full restore preserves dormant chat authority even when its checkout no
// longer exists. Validate stored identity without probing live paths or consent;
// serving performs those checks again when a rule could become active.
export function scanCandidateSessionRules(db: Database.Database, visit?: (row: SessionRuleRow) => void): number {
    if (db.prepare("SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = 'session_rules'").get() === undefined) {
        return 0;
    }
    const tableInfo = db.prepare("SELECT name, type, pk FROM pragma_table_info('session_rules')").iterate() as Iterable<{
        name: string;
        type: string;
        pk: number;
    }>;
    const columns = new Set<string>();
    let idIsPrimary = false;
    let primaryColumns = 0;
    for (const column of tableInfo) {
        columns.add(column.name);
        if (column.pk > 0) {
            primaryColumns++;
        }
        if (column.name === 'id' && column.type.toUpperCase() === 'INTEGER' && column.pk === 1) {
            idIsPrimary = true;
        }
    }
    const missing = ['id', 'ulid', 'tool', 'native_session_id', 'checkout_anchor', 'owner_project_id', 'text', 'created_at'].filter(
        (column) => !columns.has(column),
    );
    if (missing.length > 0) {
        throw new Error(`Backup is incompatible (session_rules is missing required column(s): ${missing.join(', ')}).`);
    }
    if (!idIsPrimary || primaryColumns !== 1) {
        throw new Error('Backup is incompatible (session rule ID must be an INTEGER PRIMARY KEY).');
    }
    let uniqueUlid = false;
    let scopeIndex = false;
    const indexes = db
        .prepare('SELECT name, "unique" AS unique_index, partial FROM pragma_index_list(\'session_rules\')')
        .iterate() as Iterable<{
        name: string;
        unique_index: number;
        partial: number;
    }>;
    for (const index of indexes) {
        if (index.partial !== 0 || Buffer.byteLength(index.name) > 256) {
            continue;
        }
        if (index.unique_index === 1) {
            const columns = db.prepare('SELECT name FROM pragma_index_info(?) ORDER BY seqno LIMIT 2').all(index.name) as Array<{
                name: string | null;
            }>;
            if (columns.length === 1 && columns[0]?.name === 'ulid') {
                uniqueUlid = true;
            }
        }
        if (index.name === 'idx_session_rules_scope') {
            const columns = db
                .prepare('SELECT name, "desc" AS descending, coll FROM pragma_index_xinfo(?) WHERE key = 1 ORDER BY seqno LIMIT 6')
                .all(index.name) as Array<{
                name: string | null;
                descending: number;
                coll: string;
            }>;
            scopeIndex =
                columns.length === 5 &&
                columns.every(
                    (column, position) =>
                        column.name === ['tool', 'native_session_id', 'checkout_anchor', 'owner_project_id', 'id'][position] &&
                        column.descending === 0 &&
                        column.coll === 'BINARY',
                );
        }
    }
    if (!uniqueUlid || !scopeIndex) {
        throw new Error('Backup is incompatible (session rule uniqueness or scope index is missing or malformed).');
    }
    const projectGroups = new Map(
        new ProjectResolver(db, { resolveGitRoot: () => null })
            .listStored()
            .flatMap((group) => group.projectIds.map((id) => [id, group.key] as const)),
    );
    // The required indexes enforce global identity. JavaScript only retains
    // one chat key's project groups, not all distinct historical chats.
    let currentChat: string | undefined;
    let groups = new Map<string, { texts: Set<string>; chars: number }>();
    let count = 0;
    const rows = db
        .prepare(`SELECT
        CASE WHEN typeof(id) = 'integer' THEN id END AS id,
        CASE WHEN typeof(ulid) = 'text' AND length(CAST(ulid AS BLOB)) = 26 THEN ulid END AS ulid,
        CASE WHEN typeof(tool) = 'text' AND length(CAST(tool AS BLOB)) <= ? THEN tool END AS tool,
        CASE WHEN typeof(native_session_id) = 'text' AND length(CAST(native_session_id AS BLOB)) <= ? THEN native_session_id END AS native_session_id,
        CASE WHEN typeof(checkout_anchor) = 'text' AND length(CAST(checkout_anchor AS BLOB)) <= ? THEN checkout_anchor END AS checkout_anchor,
        CASE WHEN typeof(owner_project_id) = 'integer' THEN owner_project_id END AS owner_project_id,
        CASE WHEN typeof(text) = 'text' AND length(CAST(text AS BLOB)) <= ? THEN text END AS text,
        CASE WHEN typeof(created_at) = 'text' AND length(CAST(created_at AS BLOB)) <= ? THEN created_at END AS created_at
        FROM session_rules INDEXED BY idx_session_rules_scope
        ORDER BY session_rules.tool, session_rules.native_session_id, session_rules.checkout_anchor,
            session_rules.owner_project_id, session_rules.id`)
        .iterate(
            STANDING_RULE_IMPORT_MAX_BYTES,
            PROJECT_AUTHORIZATION_ROW_MAX_BYTES,
            PROJECT_AUTHORIZATION_ROW_MAX_BYTES,
            STANDING_RULE_IMPORT_MAX_BYTES,
            STANDING_RULE_IMPORT_MAX_BYTES,
        ) as Iterable<SessionRuleRow>;
    for (const row of rows) {
        const projectGroup = projectGroups.get(row.owner_project_id);
        if (
            !Number.isSafeInteger(row.id) ||
            row.id < 1 ||
            !Number.isSafeInteger(row.owner_project_id) ||
            projectGroup === undefined ||
            !SUPPORTED_TOOLS.includes(row.tool) ||
            typeof row.native_session_id !== 'string' ||
            !row.native_session_id.trim() ||
            row.native_session_id.includes('\0') ||
            typeof row.checkout_anchor !== 'string' ||
            !validCheckoutAnchor(row.checkout_anchor)
        ) {
            throw new Error('Backup is semantically invalid: session rule identity, checkout anchor or project ownership is invalid.');
        }
        let prepared: Pick<SessionRuleRow, 'ulid' | 'text' | 'created_at'>;
        try {
            prepared = prepareImportedStandingRule(row);
        } catch (error) {
            throw new Error(`Backup is semantically invalid: session rule ${error instanceof Error ? error.message : String(error)}`);
        }
        if (prepared.text !== row.text) {
            throw new Error(`Backup is semantically invalid: session rule ${prepared.ulid} text is not canonical sanitized text.`);
        }
        const chat = JSON.stringify([row.tool, row.native_session_id, row.checkout_anchor]);
        if (chat !== currentChat) {
            currentChat = chat;
            groups = new Map();
        }
        const group = groups.get(projectGroup) ?? { texts: new Set<string>(), chars: 0 };
        if (group.texts.has(prepared.text)) {
            throw new Error(`Backup is semantically invalid: duplicate session rule text in one chat scope: ${prepared.ulid}.`);
        }
        const nextChars = group.chars + prepared.text.length;
        if (group.texts.size + 1 > STANDING_RULES_MAX_ACTIVE || nextChars > STANDING_RULES_MAX_TOTAL_CHARS) {
            throw new Error(`Backup is semantically invalid: session rule capacity exceeded in chat scope ${chat}.`);
        }
        group.texts.add(prepared.text);
        group.chars = nextChars;
        groups.set(projectGroup, group);
        visit?.({ ...row, ...prepared });
        count++;
    }
    return count;
}
