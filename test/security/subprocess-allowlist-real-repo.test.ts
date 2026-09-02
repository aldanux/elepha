// Subprocess hardening must not break a real repo with no hostile config.
// This runs against an actual `git`
// binary, unmocked - the mock-based test in subprocess-cwd-hardening.test.ts
// checks the args are constructed correctly; this checks they still work.

import { execFileSync } from 'node:child_process';
import { mkdtempSync, realpathSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import { gitRemoteGetUrlOrigin, gitRevParseShowToplevel } from '../../src/security/subprocess-allowlist.js';

function initRepo(): string {
    // realpath: macOS's /tmp -> /private/tmp, and git itself resolves
    // symlinks when reporting --show-toplevel - compare like for like.
    const dir = realpathSync(mkdtempSync(path.join(tmpdir(), 'elepha-realrepo-')));
    execFileSync('git', ['init', '-q'], { cwd: dir });
    execFileSync('git', ['config', 'user.email', 'test@example.com'], { cwd: dir });
    execFileSync('git', ['config', 'user.name', 'Test'], { cwd: dir });
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

        execFileSync('git', ['remote', 'add', 'origin', 'https://example.com/repo.git'], { cwd: dir });
        expect(gitRemoteGetUrlOrigin(dir)).toBe('https://example.com/repo.git');
    });

    it('is not derailed by a hostile local config setting command-executing keys', () => {
        const dir = initRepo();
        const sentinel = path.join(dir, 'sentinel-fired');
        execFileSync('git', ['config', 'pager.rev-parse', 'true'], { cwd: dir });
        execFileSync('git', ['config', 'core.pager', `touch '${sentinel}'; cat`], { cwd: dir });
        writeFileSync(path.join(dir, '.git', 'hooks', 'pre-commit'), '#!/bin/sh\ntouch nope\n');

        expect(gitRevParseShowToplevel(dir)).toBe(dir);
        expect(() => execFileSync('test', ['-f', sentinel])).toThrow();
    });
});
