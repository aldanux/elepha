// Even a canonicalized, consent-checked project can contain hostile local
// .git/config values such as
// like core.fsmonitor/core.sshCommand/core.pager to command strings git
// executes. Git's `-c key=value` outranks repo-local config (system < global
// < local < worktree < -c), so passing explicit neutralizing overrides
// defeats a hostile local config regardless of which directory git runs in -
// this is the actual fix; path validation alone would not be, since the
// attacker plants the directory itself.
//
// This test enforces the cwd half of the rule: the existing
// subprocess-allowlist.test.ts checks argv provenance (which git subcommands
// run), while this proves that hostile cwd config is neutralized.

import type { execFile, execFileSync } from 'node:child_process';
import path from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { SYSTEMD_SERVICE_NAME } from '../../src/config/constants.js';
import { daemonLaunchAgentPath, elephaServiceLabel } from '../../src/config/paths.js';

const execFileSyncMock = vi.fn((..._args: Parameters<typeof execFileSync>) => Buffer.from('/some/toplevel\n'));
const execFileMock = vi.fn((...args: unknown[]) => {
    const callback = args[3] as (error: Error | null, stdout: Buffer, stderr: Buffer) => void;
    callback(null, Buffer.from('/some/toplevel\n'), Buffer.alloc(0));
    return {} as ReturnType<typeof execFile>;
});
vi.mock('node:child_process', () => ({
    execFile: execFileMock,
    execFileSync: execFileSyncMock,
}));

const {
    gitRemoteGetUrlOrigin,
    gitRootCommit,
    gitRevListCountHead,
    gitRevListCountHeadAsync,
    gitRevParseAbbrevRefHead,
    gitRevParseAbbrevRefHeadAsync,
    gitRevParseShowToplevel,
    launchctl,
    npmInvocationForBackend,
    npmViewElephaLatest,
    systemctl,
} = await import('../../src/security/subprocess-allowlist.js');

const DANGEROUS_KEYS = ['core.fsmonitor', 'core.sshCommand', 'core.pager', 'core.editor', 'credential.helper', 'core.hooksPath'];
const LOCAL_ENV_KEYS = ['PATH', 'HOME', 'TMPDIR', 'LANG', 'LC_ALL'] as const;
const NETWORK_ENV_KEYS = [
    'HTTP_PROXY',
    'http_proxy',
    'HTTPS_PROXY',
    'https_proxy',
    'NO_PROXY',
    'no_proxy',
    'NODE_EXTRA_CA_CERTS',
    'SSL_CERT_FILE',
    'SSL_CERT_DIR',
] as const;

function expectedEnvironment(keys: readonly string[]): NodeJS.ProcessEnv {
    const environment: NodeJS.ProcessEnv = {};
    for (const key of keys) {
        const value = process.env[key];
        if (value !== undefined) {
            environment[key] = value;
        }
    }
    return environment;
}

describe('git subprocess cwd hardening (E-1)', () => {
    afterEach(() => {
        execFileMock.mockClear();
        execFileSyncMock.mockClear();
    });

    it('overrides every known command-executing config key via -c, for all allowlisted calls', () => {
        gitRevParseShowToplevel('/some/cwd');
        gitRemoteGetUrlOrigin('/some/cwd');
        gitRevParseAbbrevRefHead('/some/cwd');
        gitRevListCountHead('/some/cwd');
        gitRootCommit('/some/cwd');

        expect(execFileSyncMock.mock.calls.length).toBe(5);
        for (const call of execFileSyncMock.mock.calls) {
            const argv = call[1] as string[];
            for (const key of DANGEROUS_KEYS) {
                expect(argv.some((a) => a === '-c' || a.startsWith(`${key}=`))).toBe(true);
                expect(argv.some((a) => a.startsWith(`${key}=`))).toBe(true);
            }
        }
    });

    it('sorts root commits into one deterministic identity string', () => {
        execFileSyncMock.mockReturnValueOnce(Buffer.from('bbbb\naaaa\n'));

        expect(gitRootCommit('/some/cwd')).toBe('aaaa,bbbb');
        expect(execFileSyncMock).toHaveBeenCalledWith(
            expect.stringMatching(/^\/.*\/git$/),
            expect.arrayContaining(['rev-list', '--max-parents=0', 'HEAD']),
            expect.objectContaining({ cwd: '/some/cwd' }),
        );
    });

    it('uses the sync probes executable, hardened argv, cwd, and environment for async probes', async () => {
        gitRevParseAbbrevRefHead('/some/cwd');
        gitRevListCountHead('/some/cwd');
        const controller = new AbortController();

        await expect(gitRevParseAbbrevRefHeadAsync('/some/cwd', controller.signal)).resolves.toBe('/some/toplevel');
        await expect(gitRevListCountHeadAsync('/some/cwd', controller.signal)).resolves.toBeNull();

        expect(execFileMock).toHaveBeenCalledTimes(2);
        for (const [index, asyncCall] of execFileMock.mock.calls.entries()) {
            const syncCall = execFileSyncMock.mock.calls[index]!;
            expect(asyncCall[0]).toBe(syncCall[0]);
            expect(asyncCall[1]).toEqual(syncCall[1]);
            expect(asyncCall[2]).toEqual({
                cwd: (syncCall[2] as { cwd: string }).cwd,
                env: (syncCall[2] as { env: NodeJS.ProcessEnv }).env,
                signal: controller.signal,
                shell: false,
            });
        }
    });

    it('uses a trusted absolute git even when PATH starts with a hostile directory', () => {
        const previousPath = process.env.PATH;
        process.env.PATH = `/hostile/project/bin${path.delimiter}${previousPath ?? ''}`;

        try {
            gitRevParseShowToplevel('/some/cwd');

            const executable = execFileSyncMock.mock.calls[0]?.[0];
            expect(typeof executable).toBe('string');
            expect(path.isAbsolute(executable as string)).toBe(true);
            expect(executable).not.toBe('/hostile/project/bin/git');
        } finally {
            if (previousPath === undefined) delete process.env.PATH;
            else process.env.PATH = previousPath;
        }
    });

    it('keeps proxy and CA configuration npm-only and excludes ambient secrets everywhere', () => {
        const environmentOverrides = {
            HTTP_PROXY: 'http://proxy-user:proxy-password@proxy.example:8080',
            HTTPS_PROXY: 'http://proxy.example:8080',
            NODE_EXTRA_CA_CERTS: '/corporate/ca.pem',
            SSL_CERT_FILE: '/corporate/cert.pem',
            ANTHROPIC_API_KEY: 'must-not-reach-subprocesses',
            'npm_config_//registry.example/:_authToken': 'must-not-reach-subprocesses',
            FOO: 'must-not-reach-subprocesses',
        };
        const previousEnvironment = Object.fromEntries(Object.keys(environmentOverrides).map((key) => [key, process.env[key]])) as Record<
            string,
            string | undefined
        >;
        Object.assign(process.env, environmentOverrides);

        try {
            gitRevParseShowToplevel('/some/cwd');
            const gitOptions = execFileSyncMock.mock.calls[0]?.[2] as { env?: NodeJS.ProcessEnv };
            expect(gitOptions.env).toBeDefined();
            const gitEnvironment = gitOptions.env!;
            expect(gitOptions.env).toEqual({
                ...expectedEnvironment(LOCAL_ENV_KEYS),
                GIT_CONFIG_NOSYSTEM: '1',
                GIT_CONFIG_GLOBAL: '/dev/null',
                GIT_TERMINAL_PROMPT: '0',
            });

            const npmInvocation = npmInvocationForBackend({
                kind: 'nvm',
                command: '/opt/nvm/nvm-exec',
                root: '/opt/nvm',
            });
            execFileSyncMock.mockReturnValueOnce('"1.2.4"\n' as never);
            expect(npmViewElephaLatest(npmInvocation)).toBe('1.2.4');
            const npmOptions = execFileSyncMock.mock.calls[1]?.[2] as { env?: NodeJS.ProcessEnv };
            expect(npmOptions.env).toBeDefined();
            const npmEnvironment = npmOptions.env!;
            expect(npmEnvironment).toMatchObject({
                HTTP_PROXY: environmentOverrides.HTTP_PROXY,
                HTTPS_PROXY: environmentOverrides.HTTPS_PROXY,
                NODE_EXTRA_CA_CERTS: environmentOverrides.NODE_EXTRA_CA_CERTS,
                SSL_CERT_FILE: environmentOverrides.SSL_CERT_FILE,
            });

            for (const environment of [gitEnvironment, npmEnvironment]) {
                expect(environment).not.toHaveProperty('ANTHROPIC_API_KEY');
                expect(Object.hasOwn(environment, 'npm_config_//registry.example/:_authToken')).toBe(false);
                expect(environment).not.toHaveProperty('FOO');
            }

            const uid = process.getuid?.();
            expect(uid).toBeTypeOf('number');
            launchctl(['print', `gui/${uid}/${elephaServiceLabel()}`]);
            const launchctlOptions = execFileSyncMock.mock.calls[2]?.[2] as { env?: NodeJS.ProcessEnv };
            expect(launchctlOptions.env).toEqual(expectedEnvironment(LOCAL_ENV_KEYS));

            systemctl(['--user', 'is-active', SYSTEMD_SERVICE_NAME]);
            const systemctlOptions = execFileSyncMock.mock.calls[3]?.[2] as { env?: NodeJS.ProcessEnv };
            for (const key of NETWORK_ENV_KEYS) {
                expect(systemctlOptions.env).not.toHaveProperty(key);
            }
        } finally {
            for (const [key, value] of Object.entries(previousEnvironment)) {
                if (value === undefined) delete process.env[key];
                else process.env[key] = value;
            }
        }
    });
});

describe('launchctl target hardening', () => {
    afterEach(() => {
        execFileSyncMock.mockClear();
    });

    it('accepts only the canonical target shape for every allowlisted verb', () => {
        const uid = process.getuid?.();
        expect(uid).toBeTypeOf('number');
        const domain = `gui/${uid}`;
        const target = `${domain}/${elephaServiceLabel()}`;
        const allowed = [
            ['print', target],
            ['print-disabled', domain],
            ['enable', target],
            ['disable', target],
            ['bootstrap', domain, daemonLaunchAgentPath()],
            ['bootout', target],
            ['kickstart', '-k', target],
        ] as const;

        for (const args of allowed) {
            expect(() => launchctl(args)).not.toThrow();
        }
        expect(execFileSyncMock).toHaveBeenCalledTimes(allowed.length);
    });

    it.each([
        ['wrong UID domain', () => ['print-disabled', `gui/${(process.getuid?.() ?? 0) + 1}`]],
        ['wrong UID service target', () => ['print', `gui/${(process.getuid?.() ?? 0) + 1}/${elephaServiceLabel()}`]],
        ['non-elepha service label', () => ['disable', `gui/${process.getuid?.()}/com.example.not-elepha`]],
        ['arbitrary bootstrap plist', () => ['bootstrap', `gui/${process.getuid?.()}`, '/tmp/not-elepha.plist']],
    ])('rejects a %s before spawning', (_name, args) => {
        expect(() => launchctl(args())).toThrow('launchctl invocation is outside elepha allowlist');
        expect(execFileSyncMock).not.toHaveBeenCalled();
    });
});
