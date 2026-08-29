import type { execFileSync } from 'node:child_process';
import { afterEach, describe, expect, it, vi } from 'vitest';

const execFileSyncMock = vi.fn((..._args: Parameters<typeof execFileSync>) => Buffer.from('ok\n'));
vi.mock('node:child_process', () => ({
    execFile: vi.fn(),
    execFileSync: execFileSyncMock,
}));

const { systemctl } = await import('../../src/security/subprocess-allowlist.js');

const SESSION_BUS_ENV_KEYS = ['XDG_RUNTIME_DIR', 'DBUS_SESSION_BUS_ADDRESS'] as const;
const originalSessionBusEnvironment = Object.fromEntries(SESSION_BUS_ENV_KEYS.map((key) => [key, process.env[key]])) as Record<
    (typeof SESSION_BUS_ENV_KEYS)[number],
    string | undefined
>;

describe('systemctl subprocess allowlist', () => {
    afterEach(() => {
        execFileSyncMock.mockClear();
        for (const key of SESSION_BUS_ENV_KEYS) {
            const value = originalSessionBusEnvironment[key];
            if (value === undefined) delete process.env[key];
            else process.env[key] = value;
        }
    });

    it('allows only the fixed user-service lifecycle argv shapes', () => {
        const allowed = [
            ['--user', 'daemon-reload'],
            ['--user', 'enable', 'elepha.service'],
            ['--user', 'disable', 'elepha.service'],
            ['--user', 'start', 'elepha.service'],
            ['--user', 'stop', 'elepha.service'],
            ['--user', 'restart', 'elepha.service'],
            ['--user', 'is-active', 'elepha.service'],
            ['--user', 'is-enabled', 'elepha.service'],
            ['--user', 'show', 'elepha.service'],
        ] as const;

        for (const args of allowed) {
            expect(systemctl(args).status).toBe(0);
        }
        expect(execFileSyncMock).toHaveBeenCalledTimes(allowed.length);
        for (const call of execFileSyncMock.mock.calls) {
            expect(call[0]).toBe('/usr/bin/systemctl');
            expect(call[2]).toEqual(expect.objectContaining({ env: expect.any(Object) }));
        }
    });

    it('passes the caller session-bus coordinates to systemctl', () => {
        process.env.XDG_RUNTIME_DIR = '/run/user/1000';
        process.env.DBUS_SESSION_BUS_ADDRESS = 'unix:path=/run/user/1000/custom-bus';

        systemctl(['--user', 'is-active', 'elepha.service']);

        expect(execFileSyncMock).toHaveBeenCalledWith(
            '/usr/bin/systemctl',
            ['--user', 'is-active', 'elepha.service'],
            expect.objectContaining({
                env: expect.objectContaining({
                    XDG_RUNTIME_DIR: '/run/user/1000',
                    DBUS_SESSION_BUS_ADDRESS: 'unix:path=/run/user/1000/custom-bus',
                }),
            }),
        );
    });

    it('omits undefined session-bus coordinates from the systemctl environment', () => {
        delete process.env.XDG_RUNTIME_DIR;
        delete process.env.DBUS_SESSION_BUS_ADDRESS;

        systemctl(['--user', 'is-active', 'elepha.service']);

        const options = execFileSyncMock.mock.calls[0]?.[2] as { env?: NodeJS.ProcessEnv };
        expect(options.env).toBeDefined();
        expect(options.env).not.toHaveProperty('XDG_RUNTIME_DIR');
        expect(options.env).not.toHaveProperty('DBUS_SESSION_BUS_ADDRESS');
    });

    it.each([
        [['start', 'elepha.service']],
        [['--system', 'start', 'elepha.service']],
        [['--user', 'kill', 'elepha.service']],
        [['--user', 'start', 'other.service']],
        [['--user', 'start', 'elepha.service', '--no-block']],
        [['--user', 'daemon-reload', 'elepha.service']],
        [['--user', 'show', 'elepha.service', '--property=LoadState']],
    ])('rejects non-allowlisted argv %j', (args) => {
        expect(() => systemctl(args)).toThrow('systemctl invocation is outside elepha allowlist');
        expect(execFileSyncMock).not.toHaveBeenCalled();
    });
});
