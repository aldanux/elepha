// Standing project rules: durable user authority, never derived summary.
// Rules arrive through an exact elepha:rules command or a confirmed import,
// so every write is an explicit act and every bound is a hard refusal
// rather than an eviction. Nothing here is rebuildable from a transcript.

import type { Database, Statement } from 'better-sqlite3-multiple-ciphers';
import {
    STANDING_RULE_IMPORT_MAX_BYTES,
    STANDING_RULE_MAX_CHARS,
    STANDING_RULES_MAX_ACTIVE,
    STANDING_RULES_MAX_TOTAL_CHARS,
} from '../config/constants.js';
import { escapeShellSyntax } from '../security/sanitize.js';
import { newUlid } from './ulid.js';

export interface StandingRuleRow {
    id: number;
    ulid: string;
    project_id: number;
    text: string;
    created_at: string;
}

// The currently resolved consented ProjectSet, expressed for one mutation.
// Reads and capacity span every member row; a new rule is written against the
// owner, which is the first member of the resolver's shallowest-first order.
export interface StandingRuleScope {
    projectIds: readonly number[];
    ownerProjectId: number;
    // Repeated inside the write transaction because authorization can change
    // while work is in flight. A view built before the mutation is evidence,
    // not authority.
    stillConsented: (projectId: number) => boolean;
}

export type StandingRuleRejection = 'empty' | 'rule_too_long' | 'duplicate' | 'rule_limit' | 'total_limit' | 'unknown_rule' | 'unconsented';

export type StandingRuleOutcome =
    | { status: 'added'; rule: StandingRuleRow }
    | { status: 'removed'; rule: StandingRuleRow }
    | { status: 'replaced'; rule: StandingRuleRow }
    | { status: 'rejected'; reason: StandingRuleRejection };

export interface StandingRuleCapacity {
    rules: number;
    chars: number;
}

export type ImportedStandingRule = Pick<StandingRuleRow, 'ulid' | 'text' | 'created_at'>;

// Shared by candidate validation and the import write boundary. Persistence
// never relies on the CLI having sanitized or measured a value correctly.
export function prepareImportedStandingRule(rule: ImportedStandingRule): ImportedStandingRule {
    if (typeof rule.ulid !== 'string' || !/^[0-7][0-9A-HJKMNP-TV-Z]{25}$/.test(rule.ulid)) {
        throw new Error('Invalid standing rule ULID.');
    }
    if (
        typeof rule.created_at !== 'string' ||
        Buffer.byteLength(rule.created_at) > STANDING_RULE_IMPORT_MAX_BYTES ||
        !Number.isFinite(Date.parse(rule.created_at))
    ) {
        throw new Error(`Invalid standing rule creation time for ${rule.ulid}.`);
    }
    if (typeof rule.text !== 'string' || Buffer.byteLength(rule.text) > STANDING_RULE_IMPORT_MAX_BYTES) {
        throw new Error(`Standing rule ${rule.ulid} exceeds the imported text byte limit or has invalid text.`);
    }
    const text = sanitizedStandingRuleText(rule.text);
    if (text === undefined || text.length > STANDING_RULE_MAX_CHARS) {
        throw new Error(`Standing rule ${rule.ulid} must contain 1-${STANDING_RULE_MAX_CHARS} characters after sanitization.`);
    }
    return { ...rule, text };
}

// Security Rule 3, applied where a caller cannot forget it. A rule may
// legitimately name the syntax it forbids ("never run $(curl ...)"), so the
// escaping policy is used rather than the display-stripping one.
export function sanitizedStandingRuleText(text: string): string | undefined {
    const prepared = escapeShellSyntax(text).trim();
    return prepared.length === 0 ? undefined : prepared;
}

function totalChars(rules: readonly StandingRuleRow[]): number {
    return rules.reduce((total, rule) => total + rule.text.length, 0);
}

export class StandingRulesStore {
    private readonly db: Database;
    private readonly insertRule: Statement;
    private readonly deleteRule: Statement;
    private readonly updateRule: Statement;

    constructor(db: Database) {
        this.db = db;
        this.insertRule = db.prepare('INSERT INTO standing_rules (ulid, project_id, text, created_at) VALUES (?, ?, ?, ?)');
        this.deleteRule = db.prepare('DELETE FROM standing_rules WHERE id = ?');
        this.updateRule = db.prepare('UPDATE standing_rules SET text = ? WHERE id = ?');
    }

    // Stable creation order is the surrogate id, not created_at: two rules
    // added inside the same millisecond share a timestamp but never an id.
    list(projectIds: readonly number[]): StandingRuleRow[] {
        if (projectIds.length === 0) {
            return [];
        }
        const placeholders = projectIds.map(() => '?').join(',');
        return this.db
            .prepare(
                `SELECT id, ulid, project_id, text, created_at
                 FROM standing_rules WHERE project_id IN (${placeholders}) ORDER BY id`,
            )
            .all(...projectIds) as StandingRuleRow[];
    }

    capacity(projectIds: readonly number[]): StandingRuleCapacity {
        const rules = this.list(projectIds);
        return { rules: rules.length, chars: totalChars(rules) };
    }

    // Preview and write use the same merge contract; only the write entry point
    // below authorizes and persists it. Existing text is already sanitized.
    planImport(
        projectIds: readonly number[],
        incoming: readonly ImportedStandingRule[],
    ): { added: ImportedStandingRule[]; unchanged: number } {
        const existing = this.list(projectIds);
        const byText = new Map(existing.map((rule) => [rule.text, rule.ulid]));
        const byUlid = new Map<string, ImportedStandingRule>();
        const findUlid = this.db.prepare('SELECT ulid, project_id, text FROM standing_rules WHERE ulid = ?');
        const added: ImportedStandingRule[] = [];
        let unchanged = 0;
        for (const input of incoming) {
            const rule = prepareImportedStandingRule(input);
            const previous = byUlid.get(rule.ulid);
            const stored = findUlid.get(rule.ulid) as Pick<StandingRuleRow, 'ulid' | 'project_id' | 'text'> | undefined;
            if (previous !== undefined || stored !== undefined) {
                if (
                    (previous !== undefined && previous.text !== rule.text) ||
                    (stored !== undefined && (!projectIds.includes(stored.project_id) || stored.text !== rule.text))
                ) {
                    throw new Error(`Standing rule ULID collision for ${rule.ulid}: text or logical project differs.`);
                }
                unchanged++;
                continue;
            }
            const duplicate = byText.get(rule.text);
            if (duplicate !== undefined) {
                throw new Error(`Standing rule duplicate text: ${rule.ulid} conflicts with ${duplicate}.`);
            }
            byText.set(rule.text, rule.ulid);
            byUlid.set(rule.ulid, rule);
            added.push(rule);
        }
        const currentChars = totalChars(existing);
        const incomingChars = added.reduce((sum, rule) => sum + rule.text.length, 0);
        if (existing.length + added.length > STANDING_RULES_MAX_ACTIVE || currentChars + incomingChars > STANDING_RULES_MAX_TOTAL_CHARS) {
            throw new Error(
                `Standing rule capacity exceeded for project ids ${projectIds.join(', ')}: current ${existing.length} rules/${currentChars} chars, incoming ${added.length} rules/${incomingChars} chars; limits ${STANDING_RULES_MAX_ACTIVE} rules/${STANDING_RULES_MAX_TOTAL_CHARS} chars.`,
            );
        }
        return { added, unchanged };
    }

    importRules(scope: StandingRuleScope, incoming: readonly ImportedStandingRule[]): { added: number; unchanged: number } {
        return this.db.transaction(() => {
            if (!this.scopeStillConsented(scope)) {
                throw new Error('Standing rule import target is no longer consented.');
            }
            const plan = this.planImport(scope.projectIds, incoming);
            for (const rule of plan.added) {
                this.insertRule.run(rule.ulid, scope.ownerProjectId, rule.text, rule.created_at);
            }
            return { added: plan.added.length, unchanged: plan.unchanged };
        })();
    }

    add(scope: StandingRuleScope, text: string, now: string): StandingRuleOutcome {
        const prepared = sanitizedStandingRuleText(text);
        if (prepared === undefined) {
            return { status: 'rejected', reason: 'empty' };
        }
        // Capacity is measured on the exact text that would be stored, after
        // sanitization, because escaping can lengthen what the user typed.
        if (prepared.length > STANDING_RULE_MAX_CHARS) {
            return { status: 'rejected', reason: 'rule_too_long' };
        }
        const apply = this.db.transaction((): StandingRuleOutcome => {
            if (!this.scopeStillConsented(scope)) {
                return { status: 'rejected', reason: 'unconsented' };
            }
            const existing = this.list(scope.projectIds);
            if (existing.some((rule) => rule.text === prepared)) {
                return { status: 'rejected', reason: 'duplicate' };
            }
            if (existing.length + 1 > STANDING_RULES_MAX_ACTIVE) {
                return { status: 'rejected', reason: 'rule_limit' };
            }
            if (totalChars(existing) + prepared.length > STANDING_RULES_MAX_TOTAL_CHARS) {
                return { status: 'rejected', reason: 'total_limit' };
            }
            const ulid = newUlid();
            const inserted = this.insertRule.run(ulid, scope.ownerProjectId, prepared, now);
            return {
                status: 'added',
                rule: {
                    id: Number(inserted.lastInsertRowid),
                    ulid,
                    project_id: scope.ownerProjectId,
                    text: prepared,
                    created_at: now,
                },
            };
        });
        return apply();
    }

    remove(scope: StandingRuleScope, ulid: string): StandingRuleOutcome {
        const apply = this.db.transaction((): StandingRuleOutcome => {
            if (!this.scopeStillConsented(scope)) {
                return { status: 'rejected', reason: 'unconsented' };
            }
            // Resolved inside the transaction: an id that named a rule a moment
            // ago must not be trusted to still name the same row.
            const rule = this.list(scope.projectIds).find((row) => row.ulid === ulid);
            if (rule === undefined) {
                return { status: 'rejected', reason: 'unknown_rule' };
            }
            const result = this.deleteRule.run(rule.id);
            if (result.changes !== 1) {
                throw new Error(`standing rule removal affected ${result.changes} rows`);
            }
            return { status: 'removed', rule };
        });
        return apply();
    }

    replace(scope: StandingRuleScope, ulid: string, text: string): StandingRuleOutcome {
        const prepared = sanitizedStandingRuleText(text);
        if (prepared === undefined) {
            return { status: 'rejected', reason: 'empty' };
        }
        if (prepared.length > STANDING_RULE_MAX_CHARS) {
            return { status: 'rejected', reason: 'rule_too_long' };
        }
        const apply = this.db.transaction((): StandingRuleOutcome => {
            if (!this.scopeStillConsented(scope)) {
                return { status: 'rejected', reason: 'unconsented' };
            }
            const existing = this.list(scope.projectIds);
            const rule = existing.find((row) => row.ulid === ulid);
            if (rule === undefined) {
                return { status: 'rejected', reason: 'unknown_rule' };
            }
            // Replacing must not create the duplicate that add refuses to store.
            if (existing.some((row) => row.id !== rule.id && row.text === prepared)) {
                return { status: 'rejected', reason: 'duplicate' };
            }
            const others = existing.filter((row) => row.id !== rule.id);
            if (totalChars(others) + prepared.length > STANDING_RULES_MAX_TOTAL_CHARS) {
                return { status: 'rejected', reason: 'total_limit' };
            }
            const result = this.updateRule.run(prepared, rule.id);
            if (result.changes !== 1) {
                throw new Error(`standing rule replacement affected ${result.changes} rows`);
            }
            return { status: 'replaced', rule: { ...rule, text: prepared } };
        });
        return apply();
    }

    // Every member is re-checked, not just the row being written: the capacity
    // bound spans the whole set, so a partially unconsented set cannot produce
    // a correct decision and must fail closed.
    private scopeStillConsented(scope: StandingRuleScope): boolean {
        return (
            scope.projectIds.includes(scope.ownerProjectId) &&
            scope.projectIds.length > 0 &&
            scope.projectIds.every((projectId) => scope.stillConsented(projectId))
        );
    }
}
