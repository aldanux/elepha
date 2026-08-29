import { mkdirSync, mkdtempSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import { discoverFolderRepos, discoverSessionProjects } from '../../src/discovery/session-projects.js';

function session(cwd: string, timestamp: string, content: string): string {
    return `${JSON.stringify({ type: 'session_meta', timestamp, payload: { cwd, message: content } })}\n`;
}

describe('session-project discovery', () => {
    it('finds bounded zero-session repos without descending into excluded or discovered trees', async () => {
        const directory = mkdtempSync(path.join(tmpdir(), 'elepha-folder-repos-'));
        const root = path.join(directory, 'work');
        const repo = path.join(root, 'repo');
        const outerRepo = path.join(root, 'outer');
        const innerRepo = path.join(outerRepo, 'nested', 'inner');
        const alreadyDiscovered = path.join(root, 'already-discovered');
        const refused = path.join(root, 'refused');
        const nodeModulesRepo = path.join(root, 'node_modules', 'dependency');
        const dotDirectoryRepo = path.join(root, '.hidden', 'repo');
        const beyondMaxDepth = path.join(root, 'one', 'two', 'three', 'four', 'five', 'six', 'seven');
        const symlinkTarget = path.join(directory, 'symlink-target');

        for (const project of [repo, outerRepo, innerRepo, alreadyDiscovered, refused, nodeModulesRepo, dotDirectoryRepo, beyondMaxDepth]) {
            mkdirSync(path.join(project, '.git'), { recursive: true });
        }
        mkdirSync(path.join(symlinkTarget, '.git'), { recursive: true });
        symlinkSync(symlinkTarget, path.join(root, 'linked-repo'), 'dir');

        try {
            const discovered = await discoverFolderRepos(
                [root, repo],
                [
                    {
                        root: alreadyDiscovered,
                        displayName: 'already-discovered',
                        tools: ['codex'],
                        sessionCount: 1,
                        earliestSessionAt: '2026-08-01T00:00:00.000Z',
                        latestSessionAt: '2026-08-01T00:00:00.000Z',
                    },
                ],
                (candidate) => candidate === refused,
            );

            expect(discovered).toHaveLength(2);
            expect(discovered).toEqual(
                expect.arrayContaining([
                    {
                        root: repo,
                        displayName: 'repo',
                        tools: [],
                        sessionCount: 0,
                        earliestSessionAt: '',
                        latestSessionAt: '',
                    },
                    {
                        root: outerRepo,
                        displayName: 'outer',
                        tools: [],
                        sessionCount: 0,
                        earliestSessionAt: '',
                        latestSessionAt: '',
                    },
                ]),
            );
            expect(discovered.map((project) => project.root)).not.toEqual(
                expect.arrayContaining([
                    innerRepo,
                    alreadyDiscovered,
                    refused,
                    nodeModulesRepo,
                    dotDirectoryRepo,
                    beyondMaxDepth,
                    symlinkTarget,
                ]),
            );
        } finally {
            rmSync(directory, { recursive: true, force: true });
        }
    });

    it('keeps live non-git and git-worktree projects while excluding deleted and refused roots', async () => {
        const directory = mkdtempSync(path.join(tmpdir(), 'elepha-discovery-'));
        const claudeProjects = path.join(directory, 'claude', 'projects');
        const codexSessions = path.join(directory, 'codex', 'sessions');
        const sharedRoot = path.join(directory, 'work', 'shared');
        const nonGitRoot = path.join(directory, 'work', 'non-git-project');
        const deletedNonGitRoot = path.join(directory, 'work', 'deleted-non-git-project');
        const refusedRoot = path.join(directory, 'work', 'refused');
        mkdirSync(sharedRoot, { recursive: true });
        writeFileSync(path.join(sharedRoot, '.git'), 'gitdir: /irrelevant/worktree-marker\n');
        mkdirSync(nonGitRoot, { recursive: true });
        mkdirSync(path.join(refusedRoot, '.git'), { recursive: true });
        mkdirSync(path.join(claudeProjects, 'shared-project'), { recursive: true });
        mkdirSync(path.join(codexSessions, '2026', '08', '19'), { recursive: true });
        mkdirSync(path.join(codexSessions, '2026', '08', '20'), { recursive: true });
        writeFileSync(
            path.join(claudeProjects, 'shared-project', 'claude-session.jsonl'),
            `${JSON.stringify({ type: 'user', timestamp: '2026-08-10T00:00:00.000Z', cwd: path.join(sharedRoot, 'nested'), message: { content: 'never inspect me' } })}\n`,
        );
        writeFileSync(
            path.join(codexSessions, '2026', '08', '19', 'rollout-one.jsonl'),
            session(sharedRoot, '2026-08-19T00:00:00.000Z', 'also never inspect me'),
        );
        writeFileSync(
            path.join(codexSessions, '2026', '08', '20', 'rollout-refused.jsonl'),
            session(refusedRoot, '2026-08-20T00:00:00.000Z', 'excluded content'),
        );
        writeFileSync(
            path.join(codexSessions, '2026', '08', '20', 'rollout-non-git.jsonl'),
            session(nonGitRoot, '2026-08-20T01:00:00.000Z', 'live non-git content'),
        );
        writeFileSync(
            path.join(codexSessions, '2026', '08', '20', 'rollout-deleted-non-git.jsonl'),
            session(deletedNonGitRoot, '2026-08-20T02:00:00.000Z', 'deleted non-git content'),
        );

        try {
            await expect(
                discoverSessionProjects({ claudeProjects, codexSessions, isRefusedRoot: (root) => root === refusedRoot }),
            ).resolves.toEqual({
                detectedTools: ['claude-code', 'codex'],
                projects: [
                    {
                        root: nonGitRoot,
                        displayName: 'non-git-project',
                        tools: ['codex'],
                        sessionCount: 1,
                        earliestSessionAt: '2026-08-20T01:00:00.000Z',
                        latestSessionAt: '2026-08-20T01:00:00.000Z',
                    },
                    {
                        root: sharedRoot,
                        displayName: 'shared',
                        tools: ['claude-code', 'codex'],
                        sessionCount: 2,
                        earliestSessionAt: '2026-08-10T00:00:00.000Z',
                        latestSessionAt: '2026-08-19T00:00:00.000Z',
                    },
                ],
            });
        } finally {
            rmSync(directory, { recursive: true, force: true });
        }
    });
});
