import type Database from 'better-sqlite3';
import { SUPPORTED_TOOLS } from '../types/index.js';

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

/** Validates untrusted backup values without materializing candidate tables in memory. */
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
