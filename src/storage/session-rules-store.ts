// Session rules are durable user authority scoped to one native chat in one
// physical checkout. A segmented session row is never their owner.

import type { Database, Statement } from 'better-sqlite3-multiple-ciphers';
import { STANDING_RULE_MAX_CHARS, STANDING_RULES_MAX_ACTIVE, STANDING_RULES_MAX_TOTAL_CHARS } from '../config/constants.js';
import type { ToolName } from '../types/index.js';
import { sanitizedStandingRuleText } from './standing-rules-store.js';
import { newUlid } from './ulid.js';

export interface SessionRuleIdentity {
    tool: ToolName;
    nativeSessionId: string;
    // Physical Git toplevel, or the canonical rootless owner path. A remote,
    // commit identity, or ProjectSet key could join distinct checkouts.
    checkoutAnchor: string;
}

export interface SessionRuleReadScope {
    identity: SessionRuleIdentity;
    projectIds: readonly number[];
}

export interface SessionRuleScope extends SessionRuleReadScope {
    ownerProjectId: number;
    // Re-resolve consent and this exact chat/checkout/owner binding inside the
    // write transaction; a previously resolved view cannot authorize a write.
    stillAuthorized: (identity: SessionRuleIdentity, projectIds: readonly number[], ownerProjectId: number) => boolean;
}

export interface SessionRuleRow {
    id: number;
    ulid: string;
    tool: ToolName;
    native_session_id: string;
    checkout_anchor: string;
    owner_project_id: number;
    text: string;
    created_at: string;
}

export type SessionRuleRejection = 'empty' | 'rule_too_long' | 'duplicate' | 'rule_limit' | 'total_limit' | 'unknown_rule' | 'unauthorized';

export type SessionRuleOutcome =
    | { status: 'added'; rule: SessionRuleRow }
    | { status: 'removed'; rule: SessionRuleRow }
    | { status: 'replaced'; rule: SessionRuleRow }
    | { status: 'rejected'; reason: SessionRuleRejection };

export interface SessionRuleCapacity {
    rules: number;
    chars: number;
}

function totalChars(rules: readonly SessionRuleRow[]): number {
    return rules.reduce((total, rule) => total + rule.text.length, 0);
}

export class SessionRulesStore {
    private readonly db: Database;
    private readonly insertRule: Statement;
    private readonly deleteRule: Statement;
    private readonly updateRule: Statement;

    constructor(db: Database) {
        this.db = db;
        this.insertRule = db.prepare(
            `INSERT INTO session_rules
             (ulid, tool, native_session_id, checkout_anchor, owner_project_id, text, created_at)
             VALUES (?, ?, ?, ?, ?, ?, ?)`,
        );
        this.deleteRule = db.prepare(
            `DELETE FROM session_rules
             WHERE id = ? AND tool = ? AND native_session_id = ? AND checkout_anchor = ? AND owner_project_id = ?`,
        );
        this.updateRule = db.prepare(
            `UPDATE session_rules SET text = ?
             WHERE id = ? AND tool = ? AND native_session_id = ? AND checkout_anchor = ? AND owner_project_id = ?`,
        );
    }

    // The caller supplies the current authorized ProjectSet at use time. A
    // rule stays visible if a shallower project row later becomes its owner.
    list(scope: SessionRuleReadScope): SessionRuleRow[] {
        if (scope.projectIds.length === 0) {
            return [];
        }
        const placeholders = scope.projectIds.map(() => '?').join(',');
        return this.db
            .prepare(
                `SELECT id, ulid, tool, native_session_id, checkout_anchor, owner_project_id, text, created_at
                 FROM session_rules
                 WHERE tool = ? AND native_session_id = ? AND checkout_anchor = ?
                   AND owner_project_id IN (${placeholders}) ORDER BY id`,
            )
            .all(
                scope.identity.tool,
                scope.identity.nativeSessionId,
                scope.identity.checkoutAnchor,
                ...scope.projectIds,
            ) as SessionRuleRow[];
    }

    capacity(scope: SessionRuleReadScope): SessionRuleCapacity {
        const rules = this.list(scope);
        return { rules: rules.length, chars: totalChars(rules) };
    }

    add(scope: SessionRuleScope, text: string, now: string): SessionRuleOutcome {
        const prepared = sanitizedStandingRuleText(text);
        if (prepared === undefined) {
            return { status: 'rejected', reason: 'empty' };
        }
        if (prepared.length > STANDING_RULE_MAX_CHARS) {
            return { status: 'rejected', reason: 'rule_too_long' };
        }
        return this.db.transaction((): SessionRuleOutcome => {
            const identity = scope.identity;
            if (!this.scopeStillAuthorized(scope)) {
                return { status: 'rejected', reason: 'unauthorized' };
            }
            const existing = this.list(scope);
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
            const inserted = this.insertRule.run(
                ulid,
                identity.tool,
                identity.nativeSessionId,
                identity.checkoutAnchor,
                scope.ownerProjectId,
                prepared,
                now,
            );
            return {
                status: 'added',
                rule: {
                    id: Number(inserted.lastInsertRowid),
                    ulid,
                    tool: identity.tool,
                    native_session_id: identity.nativeSessionId,
                    checkout_anchor: identity.checkoutAnchor,
                    owner_project_id: scope.ownerProjectId,
                    text: prepared,
                    created_at: now,
                },
            };
        })();
    }

    remove(scope: SessionRuleScope, ulid: string): SessionRuleOutcome {
        return this.db.transaction((): SessionRuleOutcome => {
            const identity = scope.identity;
            if (!this.scopeStillAuthorized(scope)) {
                return { status: 'rejected', reason: 'unauthorized' };
            }
            const rule = this.list(scope).find((row) => row.ulid === ulid);
            if (rule === undefined) {
                return { status: 'rejected', reason: 'unknown_rule' };
            }
            const result = this.deleteRule.run(
                rule.id,
                identity.tool,
                identity.nativeSessionId,
                identity.checkoutAnchor,
                rule.owner_project_id,
            );
            if (result.changes !== 1) {
                throw new Error(`session rule removal affected ${result.changes} rows`);
            }
            return { status: 'removed', rule };
        })();
    }

    replace(scope: SessionRuleScope, ulid: string, text: string): SessionRuleOutcome {
        const prepared = sanitizedStandingRuleText(text);
        if (prepared === undefined) {
            return { status: 'rejected', reason: 'empty' };
        }
        if (prepared.length > STANDING_RULE_MAX_CHARS) {
            return { status: 'rejected', reason: 'rule_too_long' };
        }
        return this.db.transaction((): SessionRuleOutcome => {
            const identity = scope.identity;
            if (!this.scopeStillAuthorized(scope)) {
                return { status: 'rejected', reason: 'unauthorized' };
            }
            const existing = this.list(scope);
            const rule = existing.find((row) => row.ulid === ulid);
            if (rule === undefined) {
                return { status: 'rejected', reason: 'unknown_rule' };
            }
            if (existing.some((row) => row.id !== rule.id && row.text === prepared)) {
                return { status: 'rejected', reason: 'duplicate' };
            }
            if (totalChars(existing.filter((row) => row.id !== rule.id)) + prepared.length > STANDING_RULES_MAX_TOTAL_CHARS) {
                return { status: 'rejected', reason: 'total_limit' };
            }
            const result = this.updateRule.run(
                prepared,
                rule.id,
                identity.tool,
                identity.nativeSessionId,
                identity.checkoutAnchor,
                rule.owner_project_id,
            );
            if (result.changes !== 1) {
                throw new Error(`session rule replacement affected ${result.changes} rows`);
            }
            return { status: 'replaced', rule: { ...rule, text: prepared } };
        })();
    }

    private scopeStillAuthorized(scope: SessionRuleScope): boolean {
        return (
            scope.projectIds.length > 0 &&
            scope.projectIds.includes(scope.ownerProjectId) &&
            scope.stillAuthorized(scope.identity, scope.projectIds, scope.ownerProjectId)
        );
    }
}
