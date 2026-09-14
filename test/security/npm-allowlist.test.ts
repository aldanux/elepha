import { execFile, execFileSync } from 'node:child_process';
import { chmodSync, statSync, writeFileSync } from 'node:fs';
import { homedir } from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { MEMORY_PLUS_TRANSFORMERS_MIN_VERSION } from '../../src/config/constants.js';
import { elephaPaths } from '../../src/config/paths.js';
import {
    npmInstallGlobalElepha,
    npmInstallGlobalElephaAsync,
    npmInstallMemoryPlusAsync,
    npmInvocationForBackend,
    npmViewElephaLatest,
    npmViewElephaLatestAsync,
    npmViewMemoryPlusLatestAsync,
} from '../../src/security/subprocess-allowlist.js';
import { withTempDir } from '../helpers/tmp.js';

vi.mock('node:child_process', () => ({ execFile: vi.fn(), execFileSync: vi.fn() }));

const mockedExecFile = vi.mocked(execFile);
const mockedExecFileSync = vi.mocked(execFileSync);
const BASE_ENV_KEYS = [
    'PATH',
    'HOME',
    'TMPDIR',
    'LANG',
    'LC_ALL',
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

function expectedBaseEnvironment(): NodeJS.ProcessEnv {
    const environment: NodeJS.ProcessEnv = {};
    for (const key of BASE_ENV_KEYS) {
        const value = process.env[key];
        if (value !== undefined) {
            environment[key] = value;
        }
    }
    return environment;
}

function standaloneBackend() {
    const npmBin = withTempDir('elepha-npm-bin-');
    const npm = path.join(npmBin, 'npm');
    writeFileSync(npm, '#!/bin/sh\n');
    chmodSync(npm, 0o755);
    return {
        kind: 'standalone' as const,
        command: path.join(npmBin, 'elepha'),
        node: path.join(npmBin, 'node'),
        npmBin,
    };
}

describe('npm subprocess allowlist', () => {
    beforeEach(() => {
        mockedExecFile.mockReset();
        mockedExecFileSync.mockReset();
    });

    it('uses the resolved standalone npm executable with only the fixed registry and global-install argv shapes', () => {
        mockedExecFileSync.mockReturnValueOnce('"1.2.4"\n' as never).mockReturnValueOnce('' as never);
        const backend = standaloneBackend();
        const invocation = npmInvocationForBackend(backend);

        expect(npmViewElephaLatest(invocation)).toBe('1.2.4');
        npmInstallGlobalElepha(invocation, 'latest');

        expect(mockedExecFileSync).toHaveBeenNthCalledWith(
            1,
            path.join(backend.npmBin, 'npm'),
            ['view', 'elepha@latest', 'version', '--json'],
            expect.objectContaining({ cwd: homedir(), encoding: 'utf8', timeout: 60_000 }),
        );
        expect(mockedExecFileSync).toHaveBeenNthCalledWith(
            2,
            path.join(backend.npmBin, 'npm'),
            ['install', '-g', 'elepha@latest'],
            expect.objectContaining({ cwd: homedir(), encoding: 'utf8', timeout: 60_000 }),
        );
        for (const call of mockedExecFileSync.mock.calls) {
            expect(call[2]).not.toHaveProperty('shell');
        }
    });

    it('rejects a registry response that could change the install argv', () => {
        mockedExecFileSync.mockReturnValue('"latest; rm -rf /"\n' as never);
        const invocation = npmInvocationForBackend(standaloneBackend());

        expect(() => npmViewElephaLatest(invocation)).toThrow('npm view elepha@latest returned an invalid version');
        expect(mockedExecFileSync).toHaveBeenCalledTimes(1);
    });

    it('uses the short async npm view path for daemon checks without execFileSync', async () => {
        mockedExecFile.mockImplementationOnce(((_executable, _args, _options, callback) => {
            (callback as (error: Error | null, stdout: string, stderr: string) => void)(null, '"1.2.4"\n', '');
            return {} as ReturnType<typeof execFile>;
        }) as typeof execFile);
        const backend = standaloneBackend();

        await expect(npmViewElephaLatestAsync(npmInvocationForBackend(backend))).resolves.toBe('1.2.4');
        expect(mockedExecFileSync).not.toHaveBeenCalled();
        expect(mockedExecFile).toHaveBeenCalledWith(
            path.join(backend.npmBin, 'npm'),
            ['view', 'elepha@latest', 'version', '--json'],
            expect.objectContaining({ cwd: homedir(), encoding: 'utf8', timeout: 10_000, shell: false }),
            expect.any(Function),
        );
    });

    it('installs through the fixed async argv without blocking terminal progress', async () => {
        mockedExecFile.mockImplementationOnce(((_executable, _args, _options, callback) => {
            (callback as (error: Error | null, stdout: string, stderr: string) => void)(null, '', '');
            return {} as ReturnType<typeof execFile>;
        }) as typeof execFile);
        const backend = standaloneBackend();

        await expect(npmInstallGlobalElephaAsync(npmInvocationForBackend(backend), 'latest')).resolves.toBeUndefined();
        expect(mockedExecFileSync).not.toHaveBeenCalled();
        expect(mockedExecFile).toHaveBeenCalledWith(
            path.join(backend.npmBin, 'npm'),
            ['install', '-g', 'elepha@latest'],
            expect.objectContaining({ cwd: homedir(), encoding: 'utf8', timeout: 60_000, shell: false }),
            expect.any(Function),
        );
    });

    it('passes only allowlisted base variables and the selected manager variables to npm', () => {
        const previousKey = process.env.ANTHROPIC_API_KEY;
        const previousSecret = process.env.ELEPHA_TEST_SECRET;
        process.env.ANTHROPIC_API_KEY = 'must-not-reach-npm';
        process.env.ELEPHA_TEST_SECRET = 'must-not-reach-npm';

        try {
            expect(npmInvocationForBackend(standaloneBackend()).environment).toEqual(expectedBaseEnvironment());
            expect(npmInvocationForBackend({ kind: 'nvm', command: '/opt/nvm/nvm-exec', root: '/opt/nvm' }).environment).toEqual({
                ...expectedBaseEnvironment(),
                NVM_DIR: '/opt/nvm',
                NODE_VERSION: 'default',
            });
            expect(npmInvocationForBackend({ kind: 'fnm', command: '/opt/fnm/fnm', root: '/opt/fnm' }).environment).toEqual({
                ...expectedBaseEnvironment(),
                FNM_DIR: '/opt/fnm',
            });
            expect(npmInvocationForBackend({ kind: 'asdf', command: '/opt/asdf/asdf', root: '/opt/asdf' }).environment).toEqual({
                ...expectedBaseEnvironment(),
                ASDF_DATA_DIR: '/opt/asdf',
            });
        } finally {
            if (previousKey === undefined) delete process.env.ANTHROPIC_API_KEY;
            else process.env.ANTHROPIC_API_KEY = previousKey;
            if (previousSecret === undefined) delete process.env.ELEPHA_TEST_SECRET;
            else process.env.ELEPHA_TEST_SECRET = previousSecret;
        }
    });
});

describe('Memory Plus npm subprocess allowlist', () => {
    beforeEach(() => {
        vi.stubEnv('ELEPHA_HOME', withTempDir('memory-plus-npm-'));
        mockedExecFile.mockReset();
        mockedExecFileSync.mockReset();
    });
    afterEach(() => vi.unstubAllEnvs());

    function respond(output: string) {
        mockedExecFile.mockImplementationOnce(((_executable, _args, _options, callback) => {
            (callback as (error: Error | null, stdout: string, stderr: string) => void)(null, output, '');
            return {} as ReturnType<typeof execFile>;
        }) as typeof execFile);
    }

    it.each(['4.2.0', '4.3.0-rc.1+build.2', 'latest'])(
        'installs only Transformers in the private prefix with CUDA downloads disabled (%s)',
        async (version) => {
            respond('');
            const invocation = npmInvocationForBackend({ kind: 'nvm', command: '/opt/nvm/nvm-exec', root: '/opt/nvm' });
            const environment = { ...invocation.environment };
            await npmInstallMemoryPlusAsync(invocation, version);
            expect(mockedExecFile).toHaveBeenCalledExactlyOnceWith(
                '/opt/nvm/nvm-exec',
                [
                    'npm',
                    'install',
                    '--global=false',
                    '--no-save',
                    '--prefix',
                    elephaPaths().memoryPlus,
                    `@huggingface/transformers@${version}`,
                ],
                expect.objectContaining({
                    shell: false,
                    cwd: homedir(),
                    timeout: 60_000,
                    env: { ...environment, ONNXRUNTIME_NODE_INSTALL: 'skip' },
                }),
                expect.any(Function),
            );
            expect(invocation.environment).toEqual(environment);
            expect(statSync(elephaPaths().memoryPlus).mode & 0o777).toBe(0o700);
            expect(mockedExecFileSync).not.toHaveBeenCalled();
        },
    );

    it.each(['', 'next', '^4.2.0', '4.2', '4.2.0 --global', '4.2.0;id', '4.2.0\n', '01.2.3', '4.2.0-01', '4.2.0-rc..1', '4.2.0+'])(
        'rejects malformed version %j before spawning',
        async (version) => {
            await expect(npmInstallMemoryPlusAsync(npmInvocationForBackend(standaloneBackend()), version)).rejects.toThrow(
                'outside elepha allowlist',
            );
            expect(mockedExecFile).not.toHaveBeenCalled();
        },
    );

    it.each(['"4.2.0"', '["4.2.0", "4.10.0", "4.9.0"]'])('selects the highest compatible version from registry JSON %s', async (output) => {
        respond(output);
        const backend = standaloneBackend();
        expect(await npmViewMemoryPlusLatestAsync(npmInvocationForBackend(backend))).toBe(output.startsWith('[') ? '4.10.0' : '4.2.0');
        expect(mockedExecFile).toHaveBeenCalledWith(
            path.join(backend.npmBin, 'npm'),
            ['view', `@huggingface/transformers@^${MEMORY_PLUS_TRANSFORMERS_MIN_VERSION}`, 'version', '--json'],
            expect.objectContaining({ shell: false, timeout: 10_000 }),
            expect.any(Function),
        );
    });

    it.each(['[]', 'null', '"5.0.0"', '"4.1.9"', '"4.3.0-rc.1"', '["4.2.0", "latest;id"]', 'not json'])(
        'rejects invalid or incompatible registry output %s',
        async (output) => {
            respond(output);
            await expect(npmViewMemoryPlusLatestAsync(npmInvocationForBackend(standaloneBackend()))).rejects.toThrow();
        },
    );
});
