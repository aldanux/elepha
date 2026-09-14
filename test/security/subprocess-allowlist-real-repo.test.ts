// Subprocess hardening must not break a real repo with no hostile config.
// This runs against an actual `git`
// binary, unmocked - the mock-based test in subprocess-cwd-hardening.test.ts
// checks the args are constructed correctly; this checks they still work.

import { execFileSync } from 'node:child_process';
import { mkdirSync, realpathSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import { gitRemoteGetUrlOrigin, gitRevParseShowToplevel } from '../../src/security/subprocess-allowlist.js';
import { withTempDir } from '../helpers/tmp.js';

function runGitInIsolatedFixture(dir: string, args: string[]): void {
    const expectedToplevel = realpathSync(dir);
    const resolvedToplevel = realpathSync(execFileSync('git', ['rev-parse', '--show-toplevel'], { cwd: dir, encoding: 'utf8' }).trim());
    if (resolvedToplevel !== expectedToplevel) {
        throw new Error(`Git fixture isolation failed: expected ${expectedToplevel}, resolved ${resolvedToplevel}`);
    }

    execFileSync('git', args, { cwd: dir });
}

function initRepo(): string {
    // Git resolves symlinks when reporting --show-toplevel; compare physical paths.
    const dir = realpathSync(withTempDir('elepha-realrepo-'));
    execFileSync('git', ['-c', 'init.templateDir=/dev/null', 'init', '-q'], { cwd: dir });
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

    it('refuses a mutating git command when the fixture resolves to an ancestor repository', () => {
        const dir = initRepo();
        const uninitializedDir = path.join(dir, 'uninitialized-repo');
        mkdirSync(uninitializedDir);

        expect(() => runGitInIsolatedFixture(uninitializedDir, ['config', 'user.name', 'Escaped fixture'])).toThrow(
            `Git fixture isolation failed: expected ${uninitializedDir}, resolved ${dir}`,
        );
        expect(execFileSync('git', ['config', 'user.name'], { cwd: dir, encoding: 'utf8' }).trim()).toBe('Test');
    });
});
