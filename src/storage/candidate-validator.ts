import type Database from 'better-sqlite3-multiple-ciphers';
import { STANDING_RULE_IMPORT_MAX_BYTES, STANDING_RULES_MAX_ACTIVE, STANDING_RULES_MAX_TOTAL_CHARS } from '../config/constants.js';
import { SUPPORTED_TOOLS } from '../types/index.js';
import { ProjectResolver } from './project-resolver.js';
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
