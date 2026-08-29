// Security Rule 3 backfill. The choke points in RollupStore.write() and
// MemoryStore.recordTurn/reingestTurn() clean everything written from now on;
// this cleans what the store already holds.
//
// Rule 3 debt is real, not hypothetical - the live corpus has rollup rows and
// memory rows carrying backticks and `$(`. Benign today (markdown-ish quoting
// of config keys), which is exactly the point: the store holds shell-active
// syntax and until now nothing checked it.
//
// Destructive-operation shape: preview the affected rows with
// before/after text (the list, not just a count - aggregates hide
// misclassification), back up, run in one transaction, then re-run the
// detector store-wide and fail loudly if anything survives.
//
// files_touched is deliberately NOT sanitized. Those paths are computed
// deterministically from tool-call arguments, not emitted by the summarizer,
// and escaping a metacharacter that is genuinely part of a filename would
// corrupt the path rather than protect anything. A pathological filename is
// caught instead by the read-time assertion when it reaches an assembled
// brief.

import type { Database } from 'better-sqlite3';
import { detectShellSyntax, escapeShellSyntax, stripShellSyntax } from '../security/sanitize.js';

export interface SanitizeChange {
    table: 'session_rollups' | 'memories';
    rowId: number;
    field: string;
    before: string;
    after: string;
}

export interface SanitizePlan {
    changes: SanitizeChange[];
    /** Rows touched, as opposed to individual field edits. */
    rollupRows: number;
    memoryRows: number;
}

type JsonMapper = (parsed: unknown) => unknown;

function mapJsonField(raw: string, mapper: JsonMapper): string {
    let parsed: unknown;
    try {
        parsed = JSON.parse(raw);
    } catch {
        // A field that does not parse cannot be field-mapped, but it is still
        // stored text served to a model - sanitize the whole blob as a display
        // string rather than leaving it alone. Silently skipping is the
        // failure mode this codebase already paid for.
        return stripShellSyntax(raw);
    }
    return JSON.stringify(mapper(parsed));
}

const sanitizeDecisionsJson: JsonMapper = (parsed) => {
    if (!Array.isArray(parsed)) {
        return parsed;
    }
    // memories holds string[]; session_rollups holds {what, why}[]. Both are
    // the escape policy - a decision may need to name the syntax it ruled out.
    return parsed.map((d) => {
        if (typeof d === 'string') {
            return escapeShellSyntax(d);
        }
        if (d && typeof d === 'object' && 'what' in d) {
            const rec = d as { what: unknown; why: unknown };
            return {
                ...d,
                what: typeof rec.what === 'string' ? escapeShellSyntax(rec.what) : rec.what,
                why: typeof rec.why === 'string' ? escapeShellSyntax(rec.why) : rec.why,
            };
        }
        return d;
    });
};

const sanitizeStringsJson: JsonMapper = (parsed) =>
    Array.isArray(parsed) ? parsed.map((s) => (typeof s === 'string' ? stripShellSyntax(s) : s)) : parsed;

export function sanitizeRollupDisplayField(raw: string): string {
    return stripShellSyntax(raw);
}

export function sanitizeRollupDecisionsField(raw: string): string {
    return mapJsonField(raw, sanitizeDecisionsJson);
}

export function sanitizeRollupPendingItemsField(raw: string): string {
    return mapJsonField(raw, sanitizeStringsJson);
}

interface FieldSpec {
    field: string;
    /** True when the column stores JSON rather than a display string - see leafStrings(). */
    json: boolean;
    transform: (raw: string) => string;
}

const ROLLUP_FIELDS: FieldSpec[] = [
    { field: 'title', json: false, transform: sanitizeRollupDisplayField },
    { field: 'summary', json: false, transform: sanitizeRollupDisplayField },
    { field: 'decisions', json: true, transform: sanitizeRollupDecisionsField },
    { field: 'pending_items', json: true, transform: sanitizeRollupPendingItemsField },
];

const MEMORY_FIELDS: FieldSpec[] = [
    { field: 'decisions', json: true, transform: (raw) => mapJsonField(raw, sanitizeDecisionsJson) },
    { field: 'pending_items', json: true, transform: (raw) => mapJsonField(raw, sanitizeStringsJson) },
];

function collect(db: Database, table: 'session_rollups' | 'memories', idColumn: string, fields: FieldSpec[]): SanitizeChange[] {
    const columns = fields.map((f) => f.field).join(', ');
    const rows = db.prepare(`SELECT ${idColumn} AS __id, ${columns} FROM ${table}`).all() as Array<Record<string, string | number>>;

    const changes: SanitizeChange[] = [];
    for (const row of rows) {
        for (const spec of fields) {
            const before = row[spec.field];
            if (typeof before !== 'string') {
                continue;
            }
            const after = spec.transform(before);
            if (after !== before) {
                changes.push({ table, rowId: Number(row.__id), field: spec.field, before, after });
            }
        }
    }
    return changes;
}

/** What the backfill would change, without changing anything. */
export function planSanitize(db: Database): SanitizePlan {
    const changes = [...collect(db, 'session_rollups', 'session_id', ROLLUP_FIELDS), ...collect(db, 'memories', 'id', MEMORY_FIELDS)];
    return {
        changes,
        rollupRows: new Set(changes.filter((c) => c.table === 'session_rollups').map((c) => c.rowId)).size,
        memoryRows: new Set(changes.filter((c) => c.table === 'memories').map((c) => c.rowId)).size,
    };
}

/** Applies planSanitize's plan in a single transaction. Returns the plan that was applied, for reporting. */
export function applySanitize(db: Database): SanitizePlan {
    const plan = planSanitize(db);
    const apply = db.transaction(() => {
        for (const c of plan.changes) {
            const idColumn = c.table === 'session_rollups' ? 'session_id' : 'id';
            db.prepare(`UPDATE ${c.table} SET ${c.field} = ? WHERE ${idColumn} = ?`).run(c.after, c.rowId);
        }
    });
    apply();
    return plan;
}

export interface SanitizeResidue {
    table: string;
    rowId: number;
    field: string;
    text: string;
}

/**
 * Post-backfill verification: re-run the detector over every sanitized field
 * in the store. This is the check that turns "the store never holds executable
 * syntax" from a comment into an invariant, so it re-reads from SQL rather
 * than trusting the plan it just applied.
 */
export function verifySanitize(db: Database): SanitizeResidue[] {
    const residue: SanitizeResidue[] = [];
    const check = (table: 'session_rollups' | 'memories', idColumn: string, fields: FieldSpec[]) => {
        const columns = fields.map((f) => f.field).join(', ');
        const rows = db.prepare(`SELECT ${idColumn} AS __id, ${columns} FROM ${table}`).all() as Array<Record<string, string | number>>;
        for (const row of rows) {
            for (const spec of fields) {
                const raw = row[spec.field];
                if (typeof raw !== 'string') {
                    continue;
                }
                for (const value of leafStrings(raw, spec.json)) {
                    if (detectShellSyntax(value)) {
                        residue.push({ table, rowId: Number(row.__id), field: spec.field, text: value });
                    }
                }
            }
        }
    };
    check('session_rollups', 'session_id', ROLLUP_FIELDS);
    check('memories', 'id', MEMORY_FIELDS);
    return residue;
}

/**
 * The stored strings inside a field, JSON-decoded where the field is JSON.
 *
 * Running the detector on the raw column text instead would report false
 * positives: JSON escapes a backslash as `\\`, so a correctly escaped
 * `` \` `` is stored as `` \\` ``, whose backslash parity reads as
 * "unescaped backtick" to the detector. The invariant is about the values the
 * store hands out, not their transport encoding.
 */
function leafStrings(raw: string, isJson: boolean): string[] {
    if (!isJson) {
        return [raw];
    }
    let parsed: unknown;
    try {
        parsed = JSON.parse(raw);
    } catch {
        return [raw]; // unparseable JSON is still stored text; check it as-is
    }
    const out: string[] = [];
    const walk = (node: unknown): void => {
        if (typeof node === 'string') {
            out.push(node);
        } else if (Array.isArray(node)) {
            for (const child of node) {
                walk(child);
            }
        } else if (node && typeof node === 'object') {
            for (const child of Object.values(node)) {
                walk(child);
            }
        }
    };
    walk(parsed);
    return out;
}
