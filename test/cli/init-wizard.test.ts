import { homedir } from 'node:os';
import { describe, expect, it } from 'vitest';
import { consentChanges, folderCandidates, individualCandidates } from '../../src/cli/init-wizard.js';
import { isWithin } from '../../src/config/paths.js';
import type { DiscoveredProject } from '../../src/discovery/session-projects.js';

function project(root: string, sessionCount: number): DiscoveredProject {
    return {
        root,
        displayName: root.split('/').at(-1) ?? root,
        tools: ['codex'],
        sessionCount,
        earliestSessionAt: '',
        latestSessionAt: '',
    };
}

describe('init wizard decisions', () => {
    it('groups nested projects by their top-level home directory and keeps excluded roots individual', () => {
        const home = homedir();
        const projects = [
            project(`${home}/Sites/vrd/one`, 2),
            project(`${home}/Sites/elepha-app/two`, 3),
            project(`${home}/PhpstormProjects/only`, 1),
            project(`${home}/direct-repo`, 4),
            project(`${home}/Documents/notes-repo`, 5),
            project('/outside-home/repo', 6),
        ];

        const candidates = folderCandidates(
            projects,
            (root) => root === `${home}/Sites/vrd/one`,
            (root) => (root === `${home}/Sites/vrd/one` ? 'approved' : 'pending'),
        );

        expect(candidates).toEqual([
            expect.objectContaining({
                root: `${home}/PhpstormProjects`,
                label: `Projects under ${home}/PhpstormProjects (auto-sync)`,
                hint: '1 projects · 1 sessions',
                projectCount: 1,
                sessionCount: 1,
                approved: false,
            }),
            expect.objectContaining({
                root: `${home}/Sites`,
                label: `Projects under ${home}/Sites (auto-sync)`,
                hint: '2 projects · 5 sessions',
                projectCount: 2,
                sessionCount: 5,
                approved: false,
            }),
            expect.objectContaining({
                root: `${home}/direct-repo`,
                label: 'direct-repo',
                hint: `consent pending · 4 sessions · ${home}/direct-repo`,
                projectCount: 1,
            }),
            expect.objectContaining({
                root: `${home}/Documents/notes-repo`,
                label: 'notes-repo',
                hint: `consent pending · 5 sessions · ${home}/Documents/notes-repo`,
                projectCount: 1,
            }),
            expect.objectContaining({
                root: '/outside-home/repo',
                label: 'repo',
                hint: 'consent pending · 6 sessions · /outside-home/repo',
                projectCount: 1,
            }),
        ]);
        expect(projects.every((project) => candidates.some((candidate) => isWithin(candidate.root, project.root)))).toBe(true);
        expect(candidates.reduce((total, candidate) => total + candidate.projectCount, 0)).toBe(projects.length);
    });

    it('maps checked roots to approvals and only prechecked roots to attempted denials', () => {
        const candidates = individualCandidates([project('/work/one', 1), project('/work/two', 2)], (root) =>
            root === '/work/one' ? 'approved' : 'pending',
        );

        expect(consentChanges(candidates, ['/work/two'])).toEqual({
            grantRoots: ['/work/two'],
            revokeRoots: ['/work/one'],
        });
        expect(consentChanges(candidates, ['/work/one', '/work/two'])).toEqual({
            grantRoots: ['/work/two'],
            revokeRoots: [],
        });
    });

    it('shows every individual consent state with session count and path without changing selection flags', () => {
        const candidates = individualCandidates(
            [project('/work/approved', 20), project('/work/paused', 1), project('/work/pending', 0)],
            (root) => (root === '/work/approved' ? 'approved' : root === '/work/paused' ? 'denied' : 'pending'),
        );

        expect(candidates).toEqual([
            expect.objectContaining({
                label: 'approved',
                hint: 'consent approved · 20 sessions · /work/approved',
                approved: true,
                paused: false,
            }),
            expect.objectContaining({
                label: 'paused',
                hint: 'consent paused · 1 session · /work/paused',
                approved: false,
                paused: true,
            }),
            expect.objectContaining({
                label: 'pending',
                hint: 'consent pending · 0 sessions · /work/pending',
                approved: false,
                paused: false,
            }),
        ]);
    });

    it('prechecks a folder when every member project is consented', () => {
        const home = homedir();
        const sites = `${home}/Sites`;
        const projects = [project(`${sites}/one`, 1), project(`${sites}/two`, 2)];

        expect(
            folderCandidates(
                projects,
                (root) => root === `${sites}/one` || root === `${sites}/two`,
                (root) => (root === `${sites}/one` || root === `${sites}/two` ? 'approved' : 'pending'),
            ),
        ).toEqual([expect.objectContaining({ root: sites, approved: true })]);
    });

    it('prechecks a folder when its root is consented', () => {
        const home = homedir();
        const sites = `${home}/Sites`;
        const projects = [project(`${sites}/one`, 1), project(`${sites}/two`, 2)];

        expect(
            folderCandidates(
                projects,
                (root) => root === sites,
                (root) => (root === sites ? 'approved' : 'pending'),
            ),
        ).toEqual([expect.objectContaining({ root: sites, approved: true })]);
    });

    it('leaves a partially consented folder unchecked without denying its consented member', () => {
        const home = homedir();
        const sites = `${home}/Sites`;
        const firstProject = `${sites}/one`;
        const candidates = folderCandidates(
            [project(firstProject, 1), project(`${sites}/two`, 2)],
            (root) => root === firstProject,
            (root) => (root === firstProject ? 'approved' : 'pending'),
        );

        expect(candidates).toEqual([expect.objectContaining({ root: sites, approved: false })]);
        expect(consentChanges(candidates, [])).toEqual({ grantRoots: [], revokeRoots: [] });
    });

    it('shows a folder with only paused projects as paused and unchecked', () => {
        const home = homedir();
        const sites = `${home}/Sites`;
        const projects = [project(`${sites}/one`, 1), project(`${sites}/two`, 2)];

        expect(
            folderCandidates(
                projects,
                () => false,
                () => 'denied',
            ),
        ).toEqual([
            expect.objectContaining({
                root: sites,
                approved: false,
                paused: true,
                label: `Projects under ${sites} (auto-sync) (Paused)`,
                hint: '',
            }),
        ]);
    });
});
