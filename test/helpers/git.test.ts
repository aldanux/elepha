import { execFileSync } from 'node:child_process';
import { existsSync, mkdirSync, readFileSync, realpathSync } from 'node:fs';
import path from 'node:path';
import { expect, it, onTestFinished, vi } from 'vitest';
import { fixtureGitEnv } from './git.js';
import { withTempDir } from './tmp.js';

it.each([false, true])('isolates fixture init and discovery from a linked-worktree hook (extra selectors: %s)', (extraSelectors) => {
    const directory = realpathSync(withTempDir('elepha-git-env-'));
    const parent = path.join(directory, 'parent');
    const linked = path.join(directory, 'linked');
    const fixture = path.join(directory, 'fixture');
    // Capture the clean environment before simulating a hook. The setup and
    // oracle must stay independent of the environment being tested.
    const cleanEnv = fixtureGitEnv();
    const git = (cwd: string, args: string[]) => execFileSync('git', args, { cwd, env: cleanEnv, encoding: 'utf8' }).trim();
    mkdirSync(parent);
    mkdirSync(fixture);
    git(parent, ['-c', 'init.templateDir=/dev/null', 'init', '-q']);
    git(parent, ['-c', 'user.name=Fixture', '-c', 'user.email=fixture@example.invalid', 'commit', '--allow-empty', '-qm', 'fixture']);
    git(parent, ['worktree', 'add', '--detach', linked]);
    const linkedGitDir = git(linked, ['rev-parse', '--absolute-git-dir']);
    const config = path.join(parent, '.git', 'config');
    const before = readFileSync(config);
    const index = path.join(linkedGitDir, 'index');
    const indexBefore = readFileSync(index);

    onTestFinished(() => {
        vi.unstubAllEnvs();
    });
    vi.stubEnv('GIT_DIR', linkedGitDir);
    vi.stubEnv('GIT_INDEX_FILE', index);
    if (extraSelectors) {
        vi.stubEnv('GIT_COMMON_DIR', path.join(parent, '.git'));
        vi.stubEnv('GIT_WORK_TREE', linked);
        vi.stubEnv('GIT_CONFIG_COUNT', '1');
        vi.stubEnv('GIT_CONFIG_KEY_0', 'core.bare');
        vi.stubEnv('GIT_CONFIG_VALUE_0', 'true');
    }

    const env = fixtureGitEnv();
    execFileSync('git', ['-c', 'init.templateDir=/dev/null', 'init', '-q', fixture], { cwd: linked, env });
    const toplevel = execFileSync('git', ['-C', fixture, 'rev-parse', '--show-toplevel'], { env, encoding: 'utf8' }).trim();

    expect(readFileSync(config)).toEqual(before);
    expect(readFileSync(index)).toEqual(indexBefore);
    expect(existsSync(path.join(fixture, '.git', 'config'))).toBe(true);
    expect(realpathSync(toplevel)).toBe(fixture);
    expect(git(fixture, ['rev-parse', '--absolute-git-dir'])).toBe(path.join(fixture, '.git'));
    expect(realpathSync(path.resolve(fixture, git(fixture, ['rev-parse', '--git-common-dir'])))).toBe(path.join(fixture, '.git'));
    expect(git(fixture, ['rev-parse', '--is-bare-repository'])).toBe('false');
});
