import { mkdirSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { opencodeDbPath } from '../../src/config/paths.js';
import { detectSessionTools, discoverFolderRepos, discoverSessionProjects } from '../../src/discovery/session-projects.js';
import { createDeepSeekFixture, deepSeekHeader } from '../fixtures/deepseek-session.js';
import { addOpencodeSession, createOpencodeFixture } from '../fixtures/opencode-db.js';
import { withGrantableTestDir, withTempDir } from '../helpers/tmp.js';

// Hide only the host checkout's marker so non-Git and deleted fixtures retain
// their original topology. Metadata within each fixture is still read from disk.
vi.mock('node:fs/promises', async (importOriginal) => {
    const actual = await importOriginal<typeof import('node:fs/promises')>();
    return {
        ...actual,
        lstat: (...args: Parameters<typeof actual.lstat>) => {
            if (args[0] === path.resolve(import.meta.dirname, '..', '..', '.git')) {
                return Promise.reject(Object.assign(new Error('No ancestor Git marker in fixture'), { code: 'ENOENT' }));
            }
            return actual.lstat(...args);
        },
    };
});

function session(cwd: string, timestamp: string, content: string): string {
    return `${JSON.stringify({ type: 'session_meta', timestamp, payload: { cwd, message: content } })}\n`;
}

describe('session-project discovery', () => {
    beforeEach(() => {
        vi.stubEnv('KIMI_CODE_HOME', withTempDir('discovery-kimi-home-'));
        vi.stubEnv('DSH_HOME', withTempDir('discovery-deepseek-home-'));
    });
    afterEach(() => {
        vi.unstubAllEnvs();
    });

    it('detects OpenCode only when its store contains a regular database file', async () => {
        const sourceRoot = withGrantableTestDir('elepha-opencode-detection-');
        const databasePath = path.join(sourceRoot, 'opencode', 'opencode.db');
        mkdirSync(path.dirname(databasePath), { recursive: true });

        await expect(detectSessionTools({ opencodeDatabase: databasePath })).resolves.not.toContain('opencode');

        createOpencodeFixture(databasePath, withGrantableTestDir('elepha-opencode-detection-project-'));

        await expect(detectSessionTools({ opencodeDatabase: databasePath })).resolves.toContain('opencode');
    });

    it('detects DeepSeek and discovers its literal header cwd without counting older generations', async () => {
        const project = withGrantableTestDir('deepseek-discovery-project-');
        const sourceRoot = path.join(process.env.DSH_HOME!, 'sessions');
        createDeepSeekFixture(project, [[deepSeekHeader(project, 'session-discovery', 2)]], {
            sessionId: 'session-discovery',
            generation: 2,
        });
        createDeepSeekFixture(project, [[deepSeekHeader(project, 'session-discovery', 3)]], {
            sessionId: 'session-discovery',
            generation: 3,
        });

        await expect(
            discoverSessionProjects({
                claudeProjects: path.join(process.env.DSH_HOME!, 'missing-claude'),
                codexSessions: path.join(process.env.DSH_HOME!, 'missing-codex'),
                kimiSessions: path.join(process.env.DSH_HOME!, 'missing-kimi'),
                deepseekSessions: sourceRoot,
                opencodeDatabase: path.join(process.env.DSH_HOME!, 'missing-opencode.db'),
            }),
        ).resolves.toEqual({
            detectedTools: ['deepseek'],
            projects: [
                {
                    root: project,
                    displayName: path.basename(project),
                    tools: ['deepseek'],
                    sessionCount: 1,
                    earliestSessionAt: '2026-09-11T00:00:00.000Z',
                    latestSessionAt: '2026-09-11T00:00:00.000Z',
                },
            ],
        });
    });

    it('discovers OpenCode session directories, excludes ineligible roots, and merges shared JSONL projects', async () => {
        const sourceRoot = withGrantableTestDir('elepha-opencode-discovery-source-');
        const claudeProjects = path.join(sourceRoot, 'claude-projects');
        const codexSessions = path.join(sourceRoot, 'codex-sessions');
        const sharedRoot = withGrantableTestDir('elepha-opencode-discovery-shared-');
        const opencodeOnlyRoot = withGrantableTestDir('elepha-opencode-discovery-only-');
        const refusedRoot = withGrantableTestDir('elepha-opencode-discovery-refused-');
        const nonexistentRoot = path.join(withTempDir('elepha-opencode-missing-'), 'missing-project');
        vi.stubEnv('XDG_DATA_HOME', sourceRoot);
        mkdirSync(codexSessions, { recursive: true });
        createOpencodeFixture(opencodeDbPath(), sharedRoot);
        addOpencodeSession(opencodeDbPath(), {
            sessionId: 'ses_opencode_only',
            directory: opencodeOnlyRoot,
            title: 'OpenCode only',
            timeUpdated: Date.parse('2026-08-21T00:00:00.000Z'),
        });
        addOpencodeSession(opencodeDbPath(), {
            sessionId: 'ses_refused',
            directory: refusedRoot,
            title: 'Refused',
            timeUpdated: Date.parse('2026-08-22T00:00:00.000Z'),
        });
        addOpencodeSession(opencodeDbPath(), {
            sessionId: 'ses_missing',
            directory: nonexistentRoot,
            title: 'Missing',
            timeUpdated: Date.parse('2026-08-23T00:00:00.000Z'),
        });
        writeFileSync(
            path.join(codexSessions, 'rollout-shared.jsonl'),
            session(sharedRoot, '2026-08-20T00:00:00.000Z', 'never inspect me'),
        );

        await expect(
            discoverSessionProjects({
                codexSessions,
                claudeProjects,
                opencodeDatabase: opencodeDbPath(),
                isRefusedRoot: (root) => root === refusedRoot,
            }),
        ).resolves.toEqual({
            detectedTools: ['codex', 'opencode'],
            projects: [
                {
                    root: opencodeOnlyRoot,
                    displayName: path.basename(opencodeOnlyRoot),
                    tools: ['opencode'],
                    sessionCount: 1,
                    earliestSessionAt: '2026-08-21T00:00:00.000Z',
                    latestSessionAt: '2026-08-21T00:00:00.000Z',
                },
                {
                    root: sharedRoot,
                    displayName: path.basename(sharedRoot),
                    tools: ['codex', 'opencode'],
                    sessionCount: 3,
                    earliestSessionAt: '1970-01-01T00:00:00.100Z',
                    latestSessionAt: '2026-08-20T00:00:00.000Z',
                },
            ].sort((a, b) => a.displayName.localeCompare(b.displayName) || a.root.localeCompare(b.root)),
        });
    });

    it('finds bounded zero-session repos without descending into excluded or discovered trees', async () => {
        const directory = withTempDir('elepha-folder-repos-');
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
        const directory = withTempDir('elepha-discovery-');
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
                discoverSessionProjects({
                    claudeProjects,
                    codexSessions,
                    opencodeDatabase: path.join(directory, 'missing-opencode', 'opencode.db'),
                    isRefusedRoot: (root) => root === refusedRoot,
                }),
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
