// Projects are captured per cwd, so one repository can occupy many
// project rows. This is a read-only resolver: it computes ProjectSets without
// merging, rekeying, or otherwise changing the store.

import { existsSync, realpathSync } from 'node:fs';
import path from 'node:path';
import type { Database } from 'better-sqlite3';
import { isWithin, normalizeForCompare, samePath } from '../config/paths.js';
import { gitRevParseShowToplevel } from '../security/subprocess-allowlist.js';
import type { ConsentStore } from './consent-store.js';
import type { ProjectRow } from './memory-store.js';

export interface ProjectSet {
    // Stable identity: remote URL, root commit, resolved git root, then shallowest member path.
    key: string;
    displayName: string;
    // Every project-row path, preserving the original stored casing.
    paths: string[];
    // Internal SQL scope; callers query with project_id IN (...).
    projectIds: number[];
    // Re-resolved on construction; never trusts the stale captured column.
    gitRoot: string | null;
    gitRemote: string | null;
}

export interface ProjectCandidate {
    name: string;
    path: string;
    last_activity: string | null;
    sessions: number;
}

export type ProjectResolution = { project: ProjectSet } | { ambiguous: true; candidates: ProjectCandidate[] } | { project: null };

export interface ProjectResolverOptions {
    // Injection seam for deterministic tests; production uses the Rule 2 allowlisted git call.
    resolveGitRoot?: (projectPath: string) => string | null;
}

type ProjectConsent = Pick<ConsentStore, 'isConsented' | 'consentState'>;

interface ResolvedProjectRow {
    row: ProjectRow;
    resolvedGitRoot: string | null;
}

interface ProjectSetBuild {
    members: ResolvedProjectRow[];
    gitRoot: string | null;
}

function groupingIdentity(resolvedRow: ResolvedProjectRow): string | null {
    const identity = resolvedRow.row.git_remote || resolvedRow.row.git_root_commit || resolvedRow.resolvedGitRoot;
    return identity === '' ? null : identity;
}

function shallowestFirst(a: ResolvedProjectRow, b: ResolvedProjectRow): number {
    const aDepth = normalizeForCompare(a.row.path).split('/').length;
    const bDepth = normalizeForCompare(b.row.path).split('/').length;
    return aDepth - bDepth || normalizeForCompare(a.row.path).localeCompare(normalizeForCompare(b.row.path));
}

function commonRemote(members: ResolvedProjectRow[]): string | null {
    const remotes = members.map((member) => member.row.git_remote).filter((remote): remote is string => remote !== null && remote !== '');
    if (remotes.length === 0) {
        return null;
    }
    const [first] = remotes;
    if (first === undefined) {
        return null;
    }
    return remotes.every((remote) => remote === first) ? first : null;
}

// Groups no-root rows only when one stored path contains the other. Siblings
// merely sharing a filesystem ancestor remain separate: broadening to an
// invented ancestor would silently over-merge unrelated projects.
function prefixGroups(rows: ResolvedProjectRow[]): ProjectSetBuild[] {
    const groups: ProjectSetBuild[] = [];
    for (const row of [...rows].sort(shallowestFirst)) {
        const containing = groups
            .filter((group) => group.members.some((member) => isWithin(member.row.path, row.row.path)))
            .sort((a, b) => {
                const firstA = a.members[0];
                const firstB = b.members[0];
                return firstA && firstB ? shallowestFirst(firstA, firstB) : 0;
            });
        if (containing.length === 0) {
            groups.push({ members: [row], gitRoot: null });
            continue;
        }

        // A shallowest ancestor group is the explicit LCA anchor. Any other
        // containing group can only exist because of case variants, which
        // normalize to the same path and must remain one set.
        const [target, ...duplicates] = containing;
        if (!target) {
            continue;
        }
        target.members.push(row);
        for (const duplicate of duplicates) {
            target.members.push(...duplicate.members);
            groups.splice(groups.indexOf(duplicate), 1);
        }
    }
    return groups;
}

export class ProjectResolver {
    private readonly resolveGitRoot: (projectPath: string) => string | null;
    private listMemo: { consent: ProjectConsent; projects: ProjectSet[] } | undefined;
    private listStoredMemo: ProjectSet[] | undefined;

    constructor(
        private readonly db: Pick<Database, 'prepare'>,
        options: ProjectResolverOptions = {},
    ) {
        this.resolveGitRoot = options.resolveGitRoot ?? gitRevParseShowToplevel;
    }

    // Uses captured identity unless consent is supplied, then live-resolves only approved paths.
    list(consent?: ProjectConsent): ProjectSet[] {
        if (consent === undefined) {
            return this.listStored();
        }
        if (this.listMemo?.consent === consent) {
            return this.listMemo.projects;
        }
        const rows = this.db.prepare('SELECT * FROM projects ORDER BY id').all() as ProjectRow[];
        const roots = new Map<string, string | null>();
        const storedRoots = new Map(rows.map((row) => [normalizeForCompare(row.path), row.git_root]));
        const projects = this.buildProjectSets(rows, roots, (projectPath) => {
            const key = normalizeForCompare(projectPath);
            const cached = roots.get(key);
            if (cached !== undefined || roots.has(key)) {
                return cached ?? null;
            }
            const resolved =
                consent.consentState(projectPath) === 'approved' && existsSync(projectPath)
                    ? this.resolveGitRoot(projectPath)
                    : (storedRoots.get(key) ?? null);
            roots.set(key, resolved);
            return resolved;
        });
        this.listMemo = { consent, projects };
        return projects;
    }

    // Hook-budget enumeration groups rows by their captured identity without
    // probing Git. A moved checkout without a remote or root commit may remain
    // path-grouped here; consent-aware callers that need live checkout precision
    // use list(consent).
    listStored(): ProjectSet[] {
        if (this.listStoredMemo !== undefined) {
            return this.listStoredMemo;
        }
        const rows = this.db.prepare('SELECT * FROM projects ORDER BY id').all() as ProjectRow[];
        const storedRoots = new Map(rows.map((row) => [normalizeForCompare(row.path), row.git_root]));
        this.listStoredMemo = this.buildProjectSets(
            rows,
            new Map(),
            (projectPath) => storedRoots.get(normalizeForCompare(projectPath)) ?? null,
        );
        return this.listStoredMemo;
    }

    resolve(query: string): ProjectResolution {
        const rows = this.db.prepare('SELECT * FROM projects ORDER BY id').all() as ProjectRow[];
        const roots = new Map<string, string | null>();
        // Git resolves a symlinked stored path to its physical toplevel, so the
        // candidate scope must compare physical forms or a symlink-stored row
        // that list() groups into the checkout silently falls out of resolve().
        const physical = new Map<string, string>();
        const physicalPath = (candidate: string): string => {
            const key = normalizeForCompare(candidate);
            const cached = physical.get(key);
            if (cached !== undefined) {
                return cached;
            }
            let resolved = candidate;
            try {
                resolved = realpathSync(candidate);
            } catch {
                // Missing paths keep their stored form; they cannot be symlinks to anything live.
            }
            physical.set(key, resolved);
            return resolved;
        };
        const related = (a: string, b: string): boolean => this.pathsRelated(a, b) || this.pathsRelated(physicalPath(a), physicalPath(b));
        const resolveRoot = (projectPath: string): string | null => {
            const key = normalizeForCompare(projectPath);
            const cached = roots.get(key);
            if (cached !== undefined || roots.has(key)) {
                return cached ?? null;
            }
            // Missing paths deliberately stay rootless so only recorded paths group them.
            const resolved = existsSync(projectPath) ? this.resolveGitRoot(projectPath) : null;
            roots.set(key, resolved);
            return resolved;
        };

        // Resolve the live query root first. This preserves moved-checkout
        // correctness without trusting the capture-time git_root column.
        const queryGitRoot = resolveRoot(query);
        const normalizedQuery = normalizeForCompare(query);
        const lowerQuery = query.toLowerCase();
        const directlyMatched = rows.filter(
            (row) =>
                related(row.path, query) ||
                row.git_remote === query ||
                row.display_name?.trim().toLowerCase() === lowerQuery ||
                row.display_name?.toLowerCase().includes(lowerQuery) ||
                normalizeForCompare(row.path).includes(normalizedQuery),
        );

        // A remote/name/path match can name a child row. Its live root expands
        // the candidate scope to every stored row in that checkout, while Git is
        // still called only for candidate paths rather than every project row.
        const anchors = [query, queryGitRoot, ...directlyMatched.map((row) => resolveRoot(row.path))].filter(
            (anchor): anchor is string => anchor !== null,
        );
        const directIds = new Set(directlyMatched.map((row) => row.id));
        const candidates = rows.filter((row) => directIds.has(row.id) || anchors.some((anchor) => related(row.path, anchor)));
        const sets = this.buildProjectSets(candidates, roots, resolveRoot);

        return this.match(query, sets);
    }

    // Restricts resolution to sets with an approved member path and no denied member path.
    resolveConsented(query: string, consent: Pick<ConsentStore, 'isConsented' | 'consentState'>): ProjectResolution {
        // An existing unconsented caller path must never become a Git subprocess cwd.
        // Consented paths and loose names may proceed to consent-checked or stored candidate paths.
        if (existsSync(query) && consent.consentState(query) !== 'approved') {
            return { project: null };
        }
        const resolved = this.resolve(query);
        if ('project' in resolved) {
            return resolved.project !== null && this.isConsented(resolved.project, consent) ? resolved : { project: null };
        }
        const projects = this.listConsented(consent);
        const candidates = resolved.candidates.filter((candidate) => projects.some((project) => project.paths[0] === candidate.path));
        if (candidates.length === 0) {
            return { project: null };
        }
        if (candidates.length === 1) {
            const [candidate] = candidates;
            const project = projects.find((set) => set.paths[0] === candidate?.path);
            if (project !== undefined) {
                return { project };
            }
        }
        return { ambiguous: true, candidates };
    }

    listConsented(consent: ProjectConsent): ProjectSet[] {
        return this.list(consent).filter((project) => this.isConsented(project, consent));
    }

    listConsentedStored(consent: ProjectConsent): ProjectSet[] {
        return this.listStored().filter((project) => this.isConsented(project, consent));
    }

    private buildProjectSets(
        rows: ProjectRow[],
        roots: Map<string, string | null>,
        resolveRoot: (projectPath: string) => string | null = (projectPath) => {
            const key = normalizeForCompare(projectPath);
            const cached = roots.get(key);
            if (cached !== undefined || roots.has(key)) {
                return cached ?? null;
            }
            const resolved = existsSync(projectPath) ? this.resolveGitRoot(projectPath) : null;
            roots.set(key, resolved);
            return resolved;
        },
    ): ProjectSet[] {
        const resolved = rows.map((row) => ({ row, resolvedGitRoot: resolveRoot(row.path) }));
        const byIdentity = new Map<string, ProjectSetBuild>();
        const rootless: ResolvedProjectRow[] = [];
        for (const resolvedRow of resolved) {
            const identity = groupingIdentity(resolvedRow);
            if (identity === null) {
                rootless.push(resolvedRow);
                continue;
            }
            const key = normalizeForCompare(identity);
            const group = byIdentity.get(key);
            if (group) {
                group.members.push(resolvedRow);
                group.gitRoot ??= resolvedRow.resolvedGitRoot;
            } else {
                byIdentity.set(key, { members: [resolvedRow], gitRoot: resolvedRow.resolvedGitRoot });
            }
        }

        return [...byIdentity.values(), ...prefixGroups(rootless)]
            .map((group) => this.toProjectSet(group))
            .sort((a, b) => normalizeForCompare(a.paths[0] ?? '').localeCompare(normalizeForCompare(b.paths[0] ?? '')));
    }

    private match(query: string, sets: ProjectSet[]): ProjectResolution {
        const normalizedQuery = normalizeForCompare(query);
        const exact = sets.filter((set) => set.paths.some((memberPath) => samePath(memberPath, query)));
        if (exact.length > 0) {
            return this.singleOrAmbiguous(exact);
        }

        const byGitRoot = sets.filter((set) => set.gitRoot !== null && normalizeForCompare(set.gitRoot) === normalizedQuery);
        if (byGitRoot.length > 0) {
            return this.singleOrAmbiguous(byGitRoot);
        }

        const byRemote = sets.filter((set) => set.gitRemote !== null && set.gitRemote === query);
        if (byRemote.length > 0) {
            return this.singleOrAmbiguous(byRemote);
        }

        const byDisplayName = sets.filter((set) => set.displayName.toLowerCase() === query.toLowerCase());
        if (byDisplayName.length > 0) {
            return this.singleOrAmbiguous(byDisplayName);
        }

        const substring = sets.filter(
            (set) =>
                set.displayName.toLowerCase().includes(query.toLowerCase()) ||
                set.paths.some((memberPath) => normalizeForCompare(memberPath).includes(normalizedQuery)),
        );
        return substring.length === 0 ? { project: null } : this.singleOrAmbiguous(substring);
    }

    private pathsRelated(a: string, b: string): boolean {
        return samePath(a, b) || isWithin(a, b) || isWithin(b, a);
    }

    private isConsented(project: ProjectSet, consent: ProjectConsent): boolean {
        return (
            project.paths.some((projectPath) => consent.isConsented(projectPath)) &&
            project.paths.every((projectPath) => consent.consentState(projectPath) !== 'denied')
        );
    }

    private toProjectSet(group: ProjectSetBuild): ProjectSet {
        const members = [...group.members].sort(shallowestFirst);
        const [shallowest] = members;
        if (!shallowest) {
            throw new Error('ProjectSet cannot be built without project rows');
        }
        const gitRemote = commonRemote(members);
        const gitRootCommit = members.map((member) => member.row.git_root_commit).find((commit) => commit !== null && commit !== '');
        return {
            key: gitRemote ?? gitRootCommit ?? group.gitRoot ?? shallowest.row.path,
            displayName: shallowest.row.display_name?.trim() || path.basename(shallowest.row.path),
            paths: members.map((member) => member.row.path),
            projectIds: members.map((member) => member.row.id),
            gitRoot: group.gitRoot,
            gitRemote,
        };
    }

    private singleOrAmbiguous(matches: ProjectSet[]): ProjectResolution {
        if (matches.length === 1) {
            const [project] = matches;
            if (project) {
                return { project };
            }
        }
        return { ambiguous: true, candidates: matches.map((set) => this.candidate(set)) };
    }

    private candidate(set: ProjectSet): ProjectCandidate {
        const placeholders = set.projectIds.map(() => '?').join(',');
        const activity = this.db
            .prepare(
                `SELECT MAX(last_ingested_at) AS last_activity, COUNT(*) AS sessions
                 FROM sessions WHERE project_id IN (${placeholders})`,
            )
            .get(...set.projectIds) as { last_activity: string | null; sessions: number };
        return { name: set.displayName, path: set.paths[0] ?? set.key, last_activity: activity.last_activity, sessions: activity.sessions };
    }
}
