// Subprocess hardening must not break a real repo with no hostile config.
// This runs against an actual `git`
// binary, unmocked - the mock-based test in subprocess-cwd-hardening.test.ts
// checks the args are constructed correctly; this checks they still work.

import { execFileSync } from 'node:child_process';
import { existsSync, mkdirSync, readFileSync, realpathSync, renameSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { describe, expect, it, onTestFinished, vi } from 'vitest';
import { gitRemoteGetUrlOrigin, gitRevParseShowToplevel } from '../../src/security/subprocess-allowlist.js';
import { withTempDir } from '../helpers/tmp.js';

function fixtureGitEnv(): NodeJS.ProcessEnv {
    // Hooks export repository selectors such as GIT_DIR. Even git init must not
    // inherit them, or it can reinitialize the checkout instead of the fixture.
    return {
        ...Object.fromEntries(Object.entries(process.env).filter(([key]) => !key.startsWith('GIT_'))),
        GIT_CONFIG_NOSYSTEM: '1',
        GIT_CONFIG_GLOBAL: '/dev/null',
    };
}

function runGitInIsolatedFixture(dir: string, args: string[]): void {
    const env = fixtureGitEnv();
    const expectedToplevel = realpathSync(dir);
    const resolvedToplevel = realpathSync(
        execFileSync('git', ['rev-parse', '--show-toplevel'], { cwd: dir, env, encoding: 'utf8' }).trim(),
    );
    if (resolvedToplevel !== expectedToplevel) {
        throw new Error(`Git fixture isolation failed: expected ${expectedToplevel}, resolved ${resolvedToplevel}`);
    }

    // A matching work tree does not prove where git config writes: linked
    // worktrees and separate Git directories can resolve metadata elsewhere.
    const expectedGitDir = path.join(expectedToplevel, '.git');
    for (const selector of ['--absolute-git-dir', '--git-common-dir']) {
        const resolvedGitDir = realpathSync(
            path.resolve(dir, execFileSync('git', ['rev-parse', selector], { cwd: dir, env, encoding: 'utf8' }).trim()),
        );
        if (resolvedGitDir !== expectedGitDir) {
            throw new Error(`Git fixture isolation failed: expected ${expectedGitDir}, resolved ${resolvedGitDir}`);
        }
    }

    execFileSync('git', args, { cwd: dir, env });
}

function initRepo(): string {
    // Git resolves symlinks when reporting --show-toplevel; compare physical paths.
    const dir = realpathSync(withTempDir('elepha-realrepo-'));
    execFileSync('git', ['-c', 'init.templateDir=/dev/null', 'init', '-q'], { cwd: dir, env: fixtureGitEnv() });
    runGitInIsolatedFixture(dir, ['config', 'user.email', 'test@example.com']);
    runGitInIsolatedFixture(dir, ['config', 'user.name', 'Test']);
    return dir;
}

describe('subprocess-allowlist against a real repo', () => {
    it('resolves the toplevel of a genuine repo', () => {
        const dir = initRepo();
        expect(gitRevParseShowToplevel(dir)).toBe(dir);
    });

    it('resolves origin when set, and returns null when not', () => {
        const dir = initRepo();
        expect(gitRemoteGetUrlOrigin(dir)).toBeNull();

        runGitInIsolatedFixture(dir, ['remote', 'add', 'origin', 'https://example.com/repo.git']);
        expect(gitRemoteGetUrlOrigin(dir)).toBe('https://example.com/repo.git');
    });

    it('is not derailed by a hostile local config setting command-executing keys', () => {
        const dir = initRepo();
        const sentinel = path.join(dir, 'sentinel-fired');
        runGitInIsolatedFixture(dir, ['config', 'pager.rev-parse', 'true']);
        runGitInIsolatedFixture(dir, ['config', 'core.pager', `touch '${sentinel}'; cat`]);
        mkdirSync(path.join(dir, '.git', 'hooks'), { recursive: true });
        writeFileSync(path.join(dir, '.git', 'hooks', 'pre-commit'), '#!/bin/sh\ntouch nope\n');

        expect(gitRevParseShowToplevel(dir)).toBe(dir);
        expect(() => execFileSync('test', ['-f', sentinel])).toThrow();
    });

    it('keeps fixture initialization and config writes isolated from an inherited hook GIT_DIR', () => {
        const parent = initRepo();
        runGitInIsolatedFixture(parent, ['config', 'user.name', 'Parent fixture']);
        runGitInIsolatedFixture(parent, ['config', 'user.email', 'parent@example.com']);
        const parentConfig = path.join(parent, '.git', 'config');
        const before = readFileSync(parentConfig, 'utf8');
        // Git exports an absolute GIT_DIR when invoking hooks in a linked worktree.
        // Use a disposable parent here so a regression cannot modify this checkout.
        vi.stubEnv('GIT_DIR', path.join(parent, '.git'));
        onTestFinished(() => {
            vi.unstubAllEnvs();
        });

        const dir = initRepo();
        runGitInIsolatedFixture(dir, ['config', 'core.pager', 'fixture-only-pager']);

        expect(readFileSync(parentConfig, 'utf8')).toEqual(before);
        expect(existsSync(path.join(dir, '.git', 'config'))).toBe(true);
        const fixtureConfig = readFileSync(path.join(dir, '.git', 'config'), 'utf8');
        expect(fixtureConfig).toContain('email = test@example.com');
        expect(fixtureConfig).toContain('name = Test');
        expect(fixtureConfig).toContain('pager = fixture-only-pager');
        expect(gitRevParseShowToplevel(dir)).toBe(dir);
    });

    it.each(['gitdir', 'commondir'])('refuses config writes when the toplevel matches but %s points outside the fixture', (selector) => {
        const dir = initRepo();
        const metadata = path.join(realpathSync(withTempDir('elepha-git-metadata-')), 'repo.git');
        renameSync(path.join(dir, '.git'), metadata);
        if (selector === 'gitdir') {
            writeFileSync(path.join(dir, '.git'), `gitdir: ${metadata}\n`);
        } else {
            mkdirSync(path.join(dir, '.git'));
            writeFileSync(path.join(dir, '.git', 'HEAD'), readFileSync(path.join(metadata, 'HEAD')));
            writeFileSync(path.join(dir, '.git', 'commondir'), `${metadata}\n`);
        }
        const config = path.join(metadata, 'config');
        const before = readFileSync(config, 'utf8');
        expect(gitRevParseShowToplevel(dir)).toBe(dir);

        expect(() => runGitInIsolatedFixture(dir, ['config', 'user.name', 'Escaped fixture'])).toThrow(
            `Git fixture isolation failed: expected ${path.join(dir, '.git')}, resolved ${metadata}`,
        );
        expect(readFileSync(config, 'utf8')).toBe(before);
    });

    it('refuses a mutating git command when the fixture resolves to an ancestor repository', () => {
        const dir = initRepo();
        const uninitializedDir = path.join(dir, 'uninitialized-repo');
        mkdirSync(uninitializedDir);

        expect(() => runGitInIsolatedFixture(uninitializedDir, ['config', 'user.name', 'Escaped fixture'])).toThrow(
            `Git fixture isolation failed: expected ${uninitializedDir}, resolved ${dir}`,
        );
        expect(execFileSync('git', ['config', 'user.name'], { cwd: dir, env: fixtureGitEnv(), encoding: 'utf8' }).trim()).toBe('Test');
    });
});
