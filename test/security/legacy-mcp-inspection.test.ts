import { afterEach, describe, expect, it, vi } from 'vitest';
import { LEGACY_MCP_INSPECTION_MAX_BYTES, LEGACY_MCP_INSPECTION_TIMEOUT_MS } from '../../src/config/constants.js';

const subprocess = vi.hoisted(() => ({ spawnSync: vi.fn() }));
vi.mock('node:child_process', async (original) => ({ ...(await original<typeof import('node:child_process')>()), ...subprocess }));

const { macosDatabaseOpenFiles, macosProcessCommand, macosProcessOpenFiles } = await import('../../src/security/subprocess-allowlist.js');

afterEach(() => {
    vi.clearAllMocks();
    vi.unstubAllEnvs();
});

describe('legacy MCP inspection subprocess allowlist', () => {
    it('uses only fixed absolute read-only tools, argv arrays, bounded output, and a credential-free local environment', () => {
        vi.stubEnv('ANTHROPIC_API_KEY', 'test-provider-secret');
        vi.stubEnv('HTTPS_PROXY', 'https://test-proxy-secret@example.invalid');
        subprocess.spawnSync.mockReturnValue({ status: 0, stdout: 'inspection', stderr: '' });
        const database = '/state with spaces/$(inert)/elepha.db';
        expect(macosDatabaseOpenFiles(database)).toBe('inspection');
        expect(macosProcessOpenFiles(4242)).toBe('inspection');
        expect(macosProcessCommand(4242)).toBe('inspection');
        const calls = subprocess.spawnSync.mock.calls;
        expect(calls.map((call) => call.slice(0, 2))).toEqual([
            ['/usr/sbin/lsof', ['-nP', '-F0pRcuftanDi', '--', database]],
            ['/usr/sbin/lsof', ['-nP', '-F0pRcuftanDi', '-a', '-p', '4242']],
            ['/bin/ps', ['-ww', '-p', '4242', '-o', 'pid=,uid=,lstart=,command=']],
        ]);
        for (const call of calls) {
            expect(call[2]).toMatchObject({
                shell: false,
                timeout: LEGACY_MCP_INSPECTION_TIMEOUT_MS,
                maxBuffer: LEGACY_MCP_INSPECTION_MAX_BYTES,
                stdio: ['ignore', 'pipe', 'pipe'],
                env: { LC_ALL: 'C' },
            });
            expect(call[2].env).not.toHaveProperty('ANTHROPIC_API_KEY');
            expect(call[2].env).not.toHaveProperty('HTTPS_PROXY');
        }
    });

    it.each([0, 1, -1, 1.5, Number.NaN, Number.POSITIVE_INFINITY])('rejects invalid process ID %s before spawning', (pid) => {
        expect(() => macosProcessCommand(pid)).toThrow('positive process ID');
        expect(() => macosProcessOpenFiles(pid)).toThrow('positive process ID');
        expect(subprocess.spawnSync).not.toHaveBeenCalled();
    });

    it.each(['relative.db', '-p4242', '/state/invalid\0.db'])('rejects invalid database selector %j before spawning', (database) => {
        expect(() => macosDatabaseOpenFiles(database)).toThrow('absolute database path');
        expect(subprocess.spawnSync).not.toHaveBeenCalled();
    });

    it('accepts a vanished process only when the tool returned the documented empty result', () => {
        subprocess.spawnSync.mockReturnValue({ status: 1, stdout: '', stderr: '' });
        expect(macosProcessOpenFiles(4242)).toBe('');
    });

    it.each([
        { status: 1, stdout: '', stderr: 'permission denied' },
        { status: 1, stdout: 'partial output', stderr: '' },
        { status: 0, stdout: 'partial output', stderr: 'warning: incomplete' },
        { status: null, stdout: '', stderr: '' },
    ])('refuses failed or incomplete inspections: %j', (result) => {
        subprocess.spawnSync.mockReturnValue(result);
        expect(() => macosProcessOpenFiles(4242)).toThrow('Legacy MCP process inspection failed');
    });

    it('preserves missing-tool and bounded-output errors', () => {
        const error = Object.assign(new Error('spawn unavailable'), { code: 'ENOENT' });
        subprocess.spawnSync.mockReturnValue({ error });
        expect(() => macosProcessOpenFiles(4242)).toThrow(error);
    });
});
