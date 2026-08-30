import { homedir } from 'node:os';
import path from 'node:path';
import { isRefusedProjectRoot, isWithin, normalizeForCompare, samePath } from '../config/paths.js';
import type { DiscoveredProject } from '../discovery/session-projects.js';

export type InitMode = 'folder' | 'individual';

export type EffectiveSessionCount = (root: string, onDiskSessionCount: number) => number;

const onDiskSessionCount: EffectiveSessionCount = (_root, sessionCount) => sessionCount;

export interface InitCandidate {
    root: string;
    label: string;
    hint: string;
    projectCount: number;
    sessionCount: number;
    approved: boolean;
    paused: boolean;
}

interface FolderGroup {
    root: string;
    projects: DiscoveredProject[];
}

/** Groups projects by their top-level directory under the user's home. */
export function groupFolderCandidates(
    projects: DiscoveredProject[],
    isRefusedRoot: (root: string) => boolean = isRefusedProjectRoot,
): FolderGroup[] {
    const home = homedir();
    const groups = new Map<string, FolderGroup>();
    for (const project of projects) {
        const relative = path.relative(home, project.root);
        if (!relative || relative === '..' || relative.startsWith(`..${path.sep}`)) {
            continue;
        }

        const firstSegment = relative.split(path.sep)[0];
        if (!firstSegment) {
            continue;
        }

        const groupRoot = path.join(home, firstSegment);
        if (samePath(groupRoot, project.root) || isRefusedRoot(groupRoot)) {
            continue;
        }

        const group = groups.get(normalizeForCompare(groupRoot));
        if (group) {
            group.projects.push(project);
        } else {
            groups.set(normalizeForCompare(groupRoot), { root: groupRoot, projects: [project] });
        }
    }

    return [...groups.values()].sort((a, b) => a.root.localeCompare(b.root));
}

export function folderCandidates(
    projects: DiscoveredProject[],
    isConsented: (root: string) => boolean,
    consentState: (root: string) => 'approved' | 'denied' | 'pending',
    effectiveSessionCount: EffectiveSessionCount = onDiskSessionCount,
    isRefusedRoot: (root: string) => boolean = isRefusedProjectRoot,
): InitCandidate[] {
    const groups = groupFolderCandidates(projects, isRefusedRoot);
    const folders = groups.map((group) => {
        const approved = isConsented(group.root) || group.projects.every((project) => isConsented(project.root));
        const paused = !approved && group.projects.some((project) => consentState(project.root) === 'denied');
        const sessionCount = group.projects.reduce(
            (total, project) => total + effectiveSessionCount(project.root, project.sessionCount),
            0,
        );
        return {
            root: group.root,
            label: `Projects under ${group.root} (auto-sync)${paused ? ' (Paused)' : ''}`,
            hint: paused ? '' : `${group.projects.length} projects · ${sessionCount} sessions`,
            projectCount: group.projects.length,
            sessionCount,
            approved,
            paused,
        };
    });
    const orphans = projects.filter((project) => !groups.some((group) => isWithin(group.root, project.root)));

    return [...folders, ...individualCandidates(orphans, consentState, effectiveSessionCount)];
}

export function individualCandidates(
    projects: DiscoveredProject[],
    consentState: (root: string) => 'approved' | 'denied' | 'pending',
    effectiveSessionCount: EffectiveSessionCount = onDiskSessionCount,
): InitCandidate[] {
    return projects.map((project) => {
        const state = consentState(project.root);
        const paused = state === 'denied';
        const sessionCount = effectiveSessionCount(project.root, project.sessionCount);
        const stateLabel = state === 'approved' ? 'consent approved' : state === 'denied' ? 'consent paused' : 'consent pending';
        return {
            root: project.root,
            label: project.displayName,
            hint: `${stateLabel} · ${sessionCount} ${sessionCount === 1 ? 'session' : 'sessions'} · ${project.root}`,
            projectCount: 1,
            sessionCount,
            approved: state === 'approved',
            paused,
        };
    });
}

/** Maps checkbox values to the consent mutations, without performing I/O. */
export function consentChanges(
    candidates: InitCandidate[],
    selectedRoots: readonly string[],
): {
    grantRoots: string[];
    revokeRoots: string[];
} {
    const selected = new Set(selectedRoots);
    return {
        grantRoots: candidates
            .filter((candidate) => !candidate.approved && selected.has(candidate.root))
            .map((candidate) => candidate.root),
        revokeRoots: candidates
            .filter((candidate) => candidate.approved && !selected.has(candidate.root))
            .map((candidate) => candidate.root),
    };
}
