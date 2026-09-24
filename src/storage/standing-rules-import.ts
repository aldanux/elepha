// Portable rules bind to local paths and stored membership, never exported
// Git identity. Preview bindings are rechecked around the write transaction.
import { realpathSync, statSync } from 'node:fs';
import type { Database } from 'better-sqlite3-multiple-ciphers';
import { isWithin, normalizeForCompare } from '../config/paths.js';
import { readCandidateStandingRules } from './candidate-validator.js';
import { ConsentStore } from './consent-store.js';
import { ProjectResolver } from './project-resolver.js';
import { type ProjectRow, ProjectStore, type ResolvedProjectIdentity } from './project-store.js';
import { type StandingRuleRow, StandingRulesStore } from './standing-rules-store.js';

export interface RuleImportCounts {
    added: number;
    unchanged: number;
    unmapped: number;
    unconsented: number;
}

interface RuleTarget {
    path: string;
    sourcePaths: Array<{ original: string; canonical: string }>;
    memberPaths: Array<{ original: string; canonical: string }>;
    projectIds: number[];
    identity: string;
    existingRules: StandingRuleRow[];
    rules: StandingRuleRow[];
}

export interface RuleImportPlan {
    targets: RuleTarget[];
    skipped: Array<{ rules: StandingRuleRow[]; paths: string[]; disposition: 'unmapped' | 'unconsented' }>;
    counts: RuleImportCounts;
}

function existingDirectory(value: string): string | undefined {
    try {
        const canonical = realpathSync(value);
        return statSync(canonical).isDirectory() ? canonical : undefined;
    } catch {
        return undefined;
    }
}

function identity(db: Database, ids: readonly number[]): string {
    if (ids.length === 0) {
        return '[]';
    }
    // Activity timestamps are not identity; a session imported in this same
    // transaction may legitimately advance them without changing ownership.
    return JSON.stringify(
        db
            .prepare(
                `SELECT id, path, git_root, git_remote, git_root_commit FROM projects WHERE id IN (${ids.map(() => '?').join(',')}) ORDER BY id`,
            )
            .all(...ids),
    );
}

export function planStandingRuleImport(active: Database, candidate: Database): RuleImportPlan {
    const rules = readCandidateStandingRules(candidate);
    const plan: RuleImportPlan = { targets: [], skipped: [], counts: { added: 0, unchanged: 0, unmapped: 0, unconsented: 0 } };
    const skip = (rules: StandingRuleRow[], paths: string[], disposition: 'unmapped' | 'unconsented') => {
        plan.skipped.push({ rules, paths, disposition });
        plan.counts[disposition] += rules.length;
    };
    if (rules.length === 0) {
        return plan;
    }
    const consent = new ConsentStore(active);
    const resolver = new ProjectResolver(active);
    const localSets = resolver.listStored();
    const localPaths = localSets.flatMap((set) => set.paths.map((original) => ({ set, original, canonical: existingDirectory(original) })));
    const store = new StandingRulesStore(active);
    for (const group of new ProjectResolver(candidate).listStored()) {
        const incoming = rules.filter((rule) => group.projectIds.includes(rule.project_id));
        if (incoming.length === 0) {
            continue;
        }
        const sourcePaths = group.paths.map((original) => ({ original, canonical: existingDirectory(original) }));
        if (sourcePaths.some((entry) => entry.canonical === undefined)) {
            skip(incoming, group.paths, 'unmapped');
            continue;
        }
        const paths = sourcePaths as Array<{ original: string; canonical: string }>;
        if (paths.some((entry) => consent.consentState(entry.canonical) !== 'approved')) {
            skip(incoming, group.paths, 'unconsented');
            continue;
        }
        const matchingSets = new Set(
            localPaths
                .filter(
                    (local) =>
                        local.canonical !== undefined &&
                        paths.some((entry) => normalizeForCompare(entry.canonical) === normalizeForCompare(local.canonical ?? '')),
                )
                .map((local) => local.set),
        );
        const set = matchingSets.size === 1 ? [...matchingSets][0] : undefined;
        const root = [...paths].sort((a, b) => a.canonical.length - b.canonical.length)[0]?.canonical;
        if (root === undefined) {
            throw new Error('Standing rule project has no local path.');
        }
        // A missing local target may create one rootless project only if its
        // paths form a single subtree and cannot absorb another local set.
        const ambiguous =
            matchingSets.size > 1 ||
            (set === undefined &&
                (paths.some((entry) => !isWithin(root, entry.canonical)) ||
                    localPaths.some(
                        (local) => local.canonical !== undefined && (isWithin(root, local.canonical) || isWithin(local.canonical, root)),
                    ))) ||
            (set !== undefined &&
                paths.some(
                    (entry) =>
                        !localPaths.some(
                            (local) =>
                                local.set === set &&
                                local.canonical !== undefined &&
                                normalizeForCompare(local.canonical) === normalizeForCompare(entry.canonical),
                        ),
                ));
        if (ambiguous) {
            skip(incoming, group.paths, 'unmapped');
            continue;
        }
        const localMembers = localPaths.filter((local) => local.set === set);
        if (localMembers.some((member) => member.canonical === undefined)) {
            skip(incoming, group.paths, 'unmapped');
            continue;
        }
        const memberPaths = localMembers.map((member) => ({ original: member.original, canonical: member.canonical as string }));
        const canonicalMembers = new Map(memberPaths.map((member) => [member.original, member.canonical]));
        if (set?.projectIds.some((id) => !resolver.isStoredProjectConsented(id, consent, canonicalMembers))) {
            skip(incoming, group.paths, 'unconsented');
            continue;
        }
        // The local spelling can differ from the exported spelling through a
        // symlink. Bind every member, including peers absent from the backup;
        // their canonical consent participates in the logical target decision.
        const projectIds = set?.projectIds ?? [];
        const firstId = projectIds[0];
        const target = plan.targets.find((target) =>
            firstId !== undefined
                ? target.projectIds.includes(firstId)
                : target.projectIds.length === 0 && normalizeForCompare(target.path) === normalizeForCompare(root),
        );
        if (target) {
            target.rules.push(...incoming);
            target.sourcePaths.push(...paths);
        } else {
            plan.targets.push({
                path: root,
                sourcePaths: paths,
                memberPaths,
                projectIds,
                identity: identity(active, projectIds),
                existingRules: store.list(projectIds),
                rules: incoming,
            });
        }
    }
    // Separate new rootless groups must not silently coalesce when inserted.
    const overlapping = new Set(
        plan.targets.filter(
            (target) =>
                target.projectIds.length === 0 &&
                plan.targets.some(
                    (other) =>
                        other !== target &&
                        other.projectIds.length === 0 &&
                        (isWithin(target.path, other.path) || isWithin(other.path, target.path)),
                ),
        ),
    );
    for (const target of overlapping) {
        skip(
            target.rules,
            target.sourcePaths.map((entry) => entry.original),
            'unmapped',
        );
    }
    plan.targets = plan.targets.filter((target) => !overlapping.has(target));
    for (const target of plan.targets) {
        const merge = store.planImport(target.projectIds, target.rules);
        plan.counts.added += merge.added.length;
        plan.counts.unchanged += merge.unchanged;
    }
    return plan;
}

export function assertStandingRuleImportAuthorized(db: Database, plan: RuleImportPlan, checkPaths: boolean): void {
    const consent = new ConsentStore(db);
    const resolver = new ProjectResolver(db);
    const sets = resolver.listStored();
    const store = new StandingRulesStore(db);
    const projects = db.prepare('SELECT * FROM projects').all() as ProjectRow[];
    for (const target of plan.targets) {
        const changed = () =>
            new Error(`Standing rule import target changed after preview: ${target.path}. Re-run import for a fresh preview.`);
        for (const entry of target.sourcePaths) {
            if (checkPaths && existingDirectory(entry.original) !== entry.canonical) {
                throw changed();
            }
            const state = checkPaths ? consent.consentState(entry.canonical) : consent.consentStateForCanonicalPath(entry.canonical);
            if (state !== 'approved') {
                throw changed();
            }
        }
        const firstId = target.projectIds[0];
        if (firstId !== undefined) {
            const canonicalMembers = new Map(target.memberPaths.map((member) => [member.original, member.canonical]));
            if (checkPaths && target.memberPaths.some((member) => existingDirectory(member.original) !== member.canonical)) {
                throw changed();
            }
            const memberStates = target.memberPaths.map((member) =>
                checkPaths ? consent.consentState(member.original) : consent.consentStateForCanonicalPath(member.canonical),
            );
            const current = sets.find((set) => set.projectIds.includes(firstId));
            if (
                !memberStates.includes('approved') ||
                memberStates.includes('denied') ||
                current === undefined ||
                JSON.stringify([...current.projectIds].sort((a, b) => a - b)) !==
                    JSON.stringify([...target.projectIds].sort((a, b) => a - b)) ||
                identity(db, target.projectIds) !== target.identity ||
                target.projectIds.some((id) => !resolver.isStoredProjectConsented(id, consent, canonicalMembers))
            ) {
                throw changed();
            }
        } else if (projects.some((project) => isWithin(target.path, project.path) || isWithin(project.path, target.path))) {
            throw changed();
        }
        if (JSON.stringify(store.list(target.projectIds)) !== JSON.stringify(target.existingRules)) {
            throw changed();
        }
        store.planImport(target.projectIds, target.rules);
    }
}

export function applyStandingRuleImport(
    db: Database,
    plan: RuleImportPlan,
    projectIdentities: ReadonlyMap<string, ResolvedProjectIdentity> = new Map(),
): () => void {
    const consent = new ConsentStore(db);
    const store = new StandingRulesStore(db);
    const bindings: Array<{ owner: number; ids: number[]; identity: string; canonicalMembers: ReadonlyMap<string, string> }> = [];
    for (const target of plan.targets) {
        const resolved = projectIdentities.get(target.path);
        // A new rule may adopt local Git identity only when its confirmed
        // target is the root; a nested target must not gain parent authority.
        const ownerIdentity =
            resolved?.gitRoot !== null &&
            resolved?.gitRoot !== undefined &&
            normalizeForCompare(resolved.gitRoot) === normalizeForCompare(target.path)
                ? resolved
                : { gitRoot: null, gitRemote: null, gitRootCommit: null };
        const plannedOwner = target.projectIds[0];
        const storedOwner =
            plannedOwner === undefined
                ? undefined
                : (db.prepare('SELECT path, git_root FROM projects WHERE id = ?').get(plannedOwner) as
                      | Pick<ProjectRow, 'path' | 'git_root'>
                      | undefined);
        // A stored rootless owner can adopt the checked local Git identity
        // before rules bind, so session import cannot silently change it later.
        const promoteOwner =
            ownerIdentity.gitRoot !== null &&
            storedOwner?.git_root === null &&
            normalizeForCompare(storedOwner.path) === normalizeForCompare(target.path);
        const owner =
            plannedOwner === undefined || promoteOwner ? new ProjectStore(db).upsertProject(target.path, ownerIdentity).id : plannedOwner;
        if (plannedOwner !== undefined && owner !== plannedOwner) {
            throw new Error(`Standing rule import changed target ${target.path}.`);
        }
        const resolver = new ProjectResolver(db);
        const current = resolver.listStored().find((set) => set.projectIds.includes(owner));
        if (
            current === undefined ||
            (plannedOwner !== undefined &&
                JSON.stringify([...current.projectIds].sort((a, b) => a - b)) !==
                    JSON.stringify([...target.projectIds].sort((a, b) => a - b)))
        ) {
            throw new Error(`Standing rule import lost target ${target.path}.`);
        }
        const canonicalMembers = new Map(target.memberPaths.map((member) => [member.original, member.canonical]));
        if (target.projectIds.length === 0) {
            canonicalMembers.set(target.path, target.path);
        }
        store.importRules(
            {
                projectIds: current.projectIds,
                ownerProjectId: owner,
                stillConsented: (id) => resolver.isStoredProjectConsented(id, consent, canonicalMembers),
            },
            target.rules,
        );
        bindings.push({ owner, ids: current.projectIds, identity: identity(db, current.projectIds), canonicalMembers });
    }
    // Session project discovery must not expand the already confirmed rule
    // target as a side effect of this same import.
    return () => {
        const resolver = new ProjectResolver(db);
        const sets = resolver.listStored();
        for (const target of plan.targets) {
            if (target.sourcePaths.some((entry) => consent.consentStateForCanonicalPath(entry.canonical) !== 'approved')) {
                throw new Error('Standing rule target consent changed during session import.');
            }
        }
        for (const binding of bindings) {
            const current = sets.find((set) => set.projectIds.includes(binding.owner));
            if (
                current === undefined ||
                JSON.stringify([...current.projectIds].sort((a, b) => a - b)) !== JSON.stringify([...binding.ids].sort((a, b) => a - b)) ||
                identity(db, binding.ids) !== binding.identity ||
                binding.ids.some((id) => !resolver.isStoredProjectConsented(id, consent, binding.canonicalMembers))
            ) {
                throw new Error('Standing rule target membership changed during session import.');
            }
        }
    };
}
