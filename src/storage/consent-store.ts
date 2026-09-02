// Consent roots are the ingestion boundary. They are deliberately separate
// from project rows: a project row is historical capture, while consent is a
// user decision that can cover a whole ProjectSet and later be withdrawn.

import type { Database } from 'better-sqlite3';
import { canonicalizeExisting, isRefusedProjectRoot, isWithin, normalizeForCompare, samePath } from '../config/paths.js';
import { ProjectResolver } from './project-resolver.js';
import { newUlid } from './ulid.js';

export type ConsentState = 'approved' | 'denied' | 'pending';

export const CONSENT_GRANDFATHERED_AT_KEY = 'consent_grandfathered_at';

export interface ConsentRoot {
    ulid: string;
    path: string;
    state: ConsentState;
    decided_at: string;
    source: 'discovery' | 'cli' | 'grandfathered';
}

function storedPathKey(rootPath: string): string {
    const normalized = normalizeForCompare(rootPath);
    return normalized.length > 1 ? normalized.replace(/\/+$/, '') : normalized;
}

function prefersConsentRow(candidate: ConsentRoot, incumbent: ConsentRoot): boolean {
    const cs = candidate.source === 'cli' ? 1 : 0;
    const is = incumbent.source === 'cli' ? 1 : 0;
    if (cs !== is) {
        return cs > is;
    }

    const ct = Date.parse(candidate.decided_at) || 0;
    const it = Date.parse(incumbent.decided_at) || 0;
    if (ct !== it) {
        return ct > it;
    }

    return candidate.ulid > incumbent.ulid;
}

function canonicalPath(projectPath: string): string {
    return canonicalizeExisting(projectPath);
}

// First-open migration for pre-consent databases. It is intentionally
// additive: existing memories are evidence captured before consent existed,
// so grandfathering never deletes or rewrites them.
export function grandfatherConsentRoots(db: Database): ConsentRoot[] {
    const inserted: ConsentRoot[] = [];

    const grandfather = db.transaction(() => {
        const marker = db.prepare('SELECT 1 FROM meta WHERE key = ?').get(CONSENT_GRANDFATHERED_AT_KEY);
        if (marker !== undefined) {
            return;
        }

        const roots = new ProjectResolver(db)
            .list()
            .map((set) => set.gitRoot ?? set.paths[0])
            .filter((root): root is string => root !== undefined)
            .map(canonicalPath);
        const distinctRoots = [...new Map(roots.map((root) => [normalizeForCompare(root), root])).values()];
        const now = new Date().toISOString();
        const insert = db.prepare(
            `INSERT INTO consent_roots (ulid, path, state, decided_at, source)
             VALUES (@ulid, @path, @state, @decided_at, 'grandfathered')`,
        );
        for (const root of distinctRoots) {
            const state: ConsentState = isRefusedProjectRoot(root) ? 'denied' : 'approved';
            const row: ConsentRoot = { ulid: newUlid(), path: root, state, decided_at: now, source: 'grandfathered' };
            insert.run(row);
            inserted.push(row);
        }
        db.prepare('INSERT INTO meta (key, value) VALUES (?, ?)').run(CONSENT_GRANDFATHERED_AT_KEY, now);
    });
    grandfather.immediate();

    return inserted;
}

export function canonicalizeConsentRoots(db: Database): void {
    const columns = new Set((db.pragma('table_info(consent_roots)') as Array<{ name: string }>).map((column) => column.name));
    if (!['ulid', 'path', 'state', 'decided_at', 'source'].every((column) => columns.has(column))) {
        return;
    }

    const rows = db.prepare('SELECT ulid, path, state, decided_at, source FROM consent_roots').all() as ConsentRoot[];
    if (rows.length === 0) {
        return;
    }

    const groups = new Map<string, ConsentRoot[]>();
    for (const root of rows) {
        const key = storedPathKey(root.path);
        const group = groups.get(key) ?? [];
        group.push(root);
        groups.set(key, group);
    }

    const deleteRoot = db.prepare('DELETE FROM consent_roots WHERE ulid = ?');
    db.transaction(() => {
        for (const group of groups.values()) {
            const winner = group.reduce((incumbent, candidate) => (prefersConsentRow(candidate, incumbent) ? candidate : incumbent));
            for (const candidate of group) {
                if (candidate.ulid !== winner.ulid) {
                    deleteRoot.run(candidate.ulid);
                }
            }
        }
    })();
}

export class ConsentStore {
    constructor(private readonly db: Database) {}

    countApproved(): number {
        return (this.db.prepare("SELECT COUNT(*) AS count FROM consent_roots WHERE state = 'approved'").get() as { count: number }).count;
    }

    list(state?: ConsentState): ConsentRoot[] {
        return (
            state === undefined
                ? this.db.prepare('SELECT ulid, path, state, decided_at, source FROM consent_roots ORDER BY path').all()
                : this.db
                      .prepare('SELECT ulid, path, state, decided_at, source FROM consent_roots WHERE state = ? ORDER BY path')
                      .all(state)
        ) as ConsentRoot[];
    }

    remove(ulid: string): boolean {
        return this.db.prepare('DELETE FROM consent_roots WHERE ulid = ?').run(ulid).changes > 0;
    }

    // An approved root covers itself and its descendants, case-insensitively on macOS.
    isConsented(projectPath: string): boolean {
        return this.consentState(projectPath) === 'approved';
    }

    isRevoked(projectPath: string): boolean {
        return this.consentState(projectPath) === 'denied';
    }

    isRevokedProjectSet(projectPaths: readonly string[]): boolean {
        return (
            !projectPaths.some((projectPath) => this.isConsented(projectPath)) &&
            projectPaths.some((projectPath) => this.isRevoked(projectPath))
        );
    }

    consentState(projectPath: string): ConsentState {
        return this.explicitConsentDecision(projectPath)?.state ?? 'pending';
    }

    private explicitConsentDecision(projectPath: string): ConsentRoot | undefined {
        const canonicalProjectPath = canonicalPath(projectPath);
        return this.list()
            .filter((root) => root.state !== 'pending' && isWithin(root.path, canonicalProjectPath))
            .reduce<ConsentRoot | undefined>((closest, candidate) => {
                if (closest === undefined) {
                    return candidate;
                }
                const candidateLength = storedPathKey(candidate.path).length;
                const closestLength = storedPathKey(closest.path).length;
                if (candidateLength > closestLength) {
                    return candidate;
                }
                // Equal depth means duplicate rows for one physical root, so the newest explicit decision must win.
                if (candidateLength === closestLength && prefersConsentRow(candidate, closest)) {
                    return candidate;
                }
                return closest;
            }, undefined);
    }

    // Records an unseen root once; a pending decision must be visible, never a quiet drop.
    recordPending(projectPath: string): ConsentRoot {
        const canonical = canonicalPath(projectPath);
        const current = this.list().find((root) => samePath(root.path, canonical));
        if (current) {
            return current;
        }
        const row: ConsentRoot = {
            ulid: newUlid(),
            path: canonical,
            state: 'pending',
            decided_at: new Date().toISOString(),
            source: 'discovery',
        };
        this.db
            .prepare(
                'INSERT INTO consent_roots (ulid, path, state, decided_at, source) VALUES (@ulid, @path, @state, @decided_at, @source)',
            )
            .run(row);
        return row;
    }

    // Returns the effective capture-off state, recording only grantable unseen roots as pending.
    captureOffNudge(projectPath: string): ConsentRoot | 'refused' | undefined {
        const decision = this.explicitConsentDecision(projectPath);
        if (decision?.state === 'approved') {
            return undefined;
        }
        if (decision) {
            return decision;
        }
        return isRefusedProjectRoot(projectPath) ? 'refused' : this.recordPending(projectPath);
    }

    grant(projectPath: string): ConsentRoot {
        const canonical = canonicalPath(projectPath);
        if (isRefusedProjectRoot(projectPath) || isRefusedProjectRoot(canonical)) {
            throw new Error(`${canonical} is a refused project root and cannot be granted.`);
        }
        return this.setState(projectPath, 'approved', 'cli');
    }

    revoke(projectPath: string): ConsentRoot {
        return this.setState(projectPath, 'denied', 'cli');
    }

    private setState(projectPath: string, state: ConsentState, source: 'cli'): ConsentRoot {
        const canonical = canonicalPath(projectPath);
        const existing = this.list().find((root) => samePath(root.path, canonical));
        const row: ConsentRoot = {
            ulid: existing?.ulid ?? newUlid(),
            path: existing?.path ?? canonical,
            state,
            decided_at: new Date().toISOString(),
            source,
        };
        this.db
            .prepare(
                `INSERT INTO consent_roots (ulid, path, state, decided_at, source)
                 VALUES (@ulid, @path, @state, @decided_at, @source)
                 ON CONFLICT(path) DO UPDATE SET state = excluded.state, decided_at = excluded.decided_at, source = excluded.source`,
            )
            .run(row);
        return row;
    }
}
