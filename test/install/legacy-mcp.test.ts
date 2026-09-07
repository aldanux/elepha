import { mkdirSync, renameSync, statSync, symlinkSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { LEGACY_MCP_INSPECTION_MAX_BYTES } from '../../src/config/constants.js';
import {
    type LegacyMcpProcess,
    linuxLegacyMcpProbe,
    macosLegacyMcpProbe,
    retiredNpmPackageRoot,
    retireLegacyMcpReaders,
} from '../../src/install/legacy-mcp.js';
import { withGrantableTestDir } from '../helpers/tmp.js';

const uid = process.getuid?.() ?? 0;
const installed = { bin: '/opt/npm/bin/elepha', packageRoot: '/opt/npm/lib/node_modules/elepha' };
const retiredRoot = retiredNpmPackageRoot(installed.packageRoot);

function candidate(overrides: Partial<LegacyMcpProcess> = {}): LegacyMcpProcess {
    return {
        pid: 4242,
        uid,
        startedAt: 'Mon Sep  7 12:00:00 2026',
        command: ['node', path.join(installed.packageRoot, 'bin', 'elepha.js'), 'mcp', 'serve'],
        executable: '/opt/npm/bin/node',
        readOnly: true,
        mappedFiles: [`${retiredRoot}/node_modules/better-sqlite3/prebuilds/darwin-arm64.node`],
        ...overrides,
    };
}

function databaseFixture(): string {
    const file = path.join(withGrantableTestDir('legacy-mcp-'), 'elepha.db');
    writeFileSync(file, 'untouched database');
    return file;
}

afterEach(() => vi.restoreAllMocks());

describe('legacy MCP retirement', () => {
    it('matches npm retirement to the exact installed path, including spaces', () => {
        expect(
            retiredNpmPackageRoot('/Users/dani/Library/Application Support/Herd/config/nvm/versions/node/v24.19.0/lib/node_modules/elepha'),
        ).toBe('/Users/dani/Library/Application Support/Herd/config/nvm/versions/node/v24.19.0/lib/node_modules/.elepha-iZEjl8ck');
    });

    it('revalidates a same-user old read-only MCP and sends SIGTERM once', async () => {
        let active = true;
        const inspect = vi.fn(() => (active ? candidate() : undefined));
        const signal = vi.fn(() => {
            active = false;
        });
        await expect(
            retireLegacyMcpReaders(databaseFixture(), installed, {
                probe: { list: () => [4242], inspect },
                signal,
            }),
        ).resolves.toBe(1);
        expect(inspect).toHaveBeenCalledTimes(3);
        expect(signal).toHaveBeenCalledExactlyOnceWith(4242, 'SIGTERM');
    });

    it('retries a signaled Linux reader while its proc descriptors are inaccessible', async () => {
        const inspect = vi
            .fn()
            .mockReturnValueOnce(candidate())
            .mockReturnValueOnce(candidate())
            .mockImplementationOnce(() => {
                throw Object.assign(new Error('proc descriptor is closing'), { code: 'EACCES' });
            })
            .mockReturnValueOnce(undefined);
        const signal = vi.fn();

        await expect(
            retireLegacyMcpReaders(databaseFixture(), installed, {
                probe: { list: () => [4242], inspect },
                signal,
            }),
        ).resolves.toBe(1);
        expect(signal).toHaveBeenCalledExactlyOnceWith(4242, 'SIGTERM');
    });

    it.each([
        ['another user', { uid: uid + 1 }],
        ['a database writer', { readOnly: false }],
        ['this updater', { pid: process.pid }],
        ['the daemon', { command: ['node', installed.bin, 'start'] }],
        ['the self-update CLI', { command: ['node', installed.bin, 'self-update'] }],
        ['the parent coding app', { command: ['node', '/Applications/Codex.app/app.js', 'mcp', 'serve'] }],
        ['an extra argument', { command: ['node', installed.bin, 'mcp', 'serve', '--unknown'] }],
        ['a current package', { mappedFiles: [`${installed.packageRoot}/node_modules/better-sqlite3/prebuilds/darwin-arm64.node`] }],
        [
            'a different retired package',
            { mappedFiles: ['/other/node_modules/.elepha-iZEjl8ck/node_modules/better-sqlite3/prebuilds/darwin-arm64.node'] },
        ],
        ['a guessed retirement prefix', { mappedFiles: [`${retiredRoot}-extra/node_modules/better-sqlite3/prebuilds/darwin-arm64.node`] }],
        ['a non-Node executable', { executable: '/bin/sh' }],
        ['a traversing map path', { mappedFiles: [`${retiredRoot}/node_modules/better-sqlite3/../../../other.node`] }],
    ] satisfies Array<[string, Partial<LegacyMcpProcess>]>)('does not signal %s', async (_name, changes) => {
        const signal = vi.fn();
        await expect(
            retireLegacyMcpReaders(databaseFixture(), installed, {
                probe: { list: () => [4242], inspect: () => candidate(changes) },
                signal,
            }),
        ).resolves.toBe(0);
        expect(signal).not.toHaveBeenCalled();
    });

    it.each([
        { startedAt: 'reused PID' },
        { uid: uid + 1 },
        { command: ['node', installed.bin, 'start'] },
        { mappedFiles: ['/other/addon.node'] },
        { readOnly: false },
    ] satisfies Partial<LegacyMcpProcess>[])('refuses changed process proof before signaling: %j', async (changes) => {
        const inspect = vi.fn().mockReturnValueOnce(candidate()).mockReturnValue(candidate(changes));
        const signal = vi.fn();
        await expect(
            retireLegacyMcpReaders(databaseFixture(), installed, {
                probe: { list: () => [4242], inspect },
                signal,
            }),
        ).resolves.toBe(0);
        expect(signal).not.toHaveBeenCalled();
    });

    it('does not disguise unavailable OS inspection as an empty result', async () => {
        const signal = vi.fn();
        await expect(
            retireLegacyMcpReaders(databaseFixture(), installed, {
                probe: {
                    list: () => {
                        throw new Error('process inspection denied');
                    },
                    inspect: () => undefined,
                },
                signal,
            }),
        ).rejects.toThrow('process inspection denied');
        expect(signal).not.toHaveBeenCalled();
    });

    it('does not signal a reader when the primary is replaced during its final proof', async () => {
        const database = databaseFixture();
        const replacement = `${database}.replacement`;
        writeFileSync(replacement, 'replacement database');
        let inspections = 0;
        const signal = vi.fn();
        await expect(
            retireLegacyMcpReaders(database, installed, {
                probe: {
                    list: () => [4242],
                    inspect: () => {
                        if (++inspections === 2) renameSync(replacement, database);
                        return candidate();
                    },
                },
                signal,
            }),
        ).resolves.toBe(0);
        expect(signal).not.toHaveBeenCalled();
    });

    it('reports earlier signals if a later OS inspection fails', async () => {
        const signal = vi.fn();
        await expect(
            retireLegacyMcpReaders(databaseFixture(), installed, {
                probe: {
                    list: () => [4242, 4243],
                    inspect: (pid) => {
                        if (pid === 4243) throw new Error('inspection denied');
                        return candidate();
                    },
                },
                signal,
            }),
        ).rejects.toThrow('Legacy MCP retirement stopped after signaling 1 process(es): inspection denied');
        expect(signal).toHaveBeenCalledExactlyOnceWith(4242, 'SIGTERM');
    });

    it('does not escalate a refused SIGTERM to SIGKILL', async () => {
        const signal = vi.fn(() => {
            throw Object.assign(new Error('signal denied'), { code: 'EPERM' });
        });
        await expect(
            retireLegacyMcpReaders(databaseFixture(), installed, {
                probe: { list: () => [4242], inspect: () => candidate() },
                signal,
            }),
        ).rejects.toThrow('signal denied');
        expect(signal).toHaveBeenCalledExactlyOnceWith(4242, 'SIGTERM');
    });

    it('bounds the wait when a retired reader keeps its database open', async () => {
        let reads = 0;
        vi.spyOn(Date, 'now').mockImplementation(() => (++reads < 5 ? 100 : 100_000));
        const signal = vi.fn();
        await expect(
            retireLegacyMcpReaders(databaseFixture(), installed, {
                probe: { list: () => [4242], inspect: () => candidate() },
                signal,
            }),
        ).rejects.toThrow('A retired elepha MCP did not release the database before the timeout.');
        expect(signal).toHaveBeenCalledExactlyOnceWith(4242, 'SIGTERM');
    });
});

describe('macOS process inspection', () => {
    const identity = { dev: 17n, ino: 42n };
    const command = ` 4242 ${uid} Mon Sep  7 12:00:00 2026 node ${installed.bin} mcp serve\n`;
    const lsof = `p4242\0R2000\0cnode\0u${uid}\0\nftxt\0a \0tREG\0D0x11\0i43\0n/opt/npm/bin/node\0\nftxt\0a \0tREG\0D0x11\0i44\0n${retiredRoot}/node_modules/better-sqlite3/prebuilds/darwin-arm64.node\0\nf13\0ar\0tREG\0D0x11\0i42\0n/state/elepha.db\0\n`;

    it('reads machine-delimited open-file identity and verifies the command twice', () => {
        const processCommand = vi.fn(() => command);
        const probe = macosLegacyMcpProbe('/state/elepha.db', identity, {
            databaseFiles: () => lsof,
            processFiles: () => lsof,
            processCommand,
        });
        expect(probe.list()).toEqual([4242]);
        expect(probe.inspect(4242)).toMatchObject({ pid: 4242, uid, readOnly: true, command: `node ${installed.bin} mcp serve` });
        expect(processCommand).toHaveBeenCalledTimes(2);
    });

    it('rejects a replaced process generation during native file inspection', () => {
        const processCommand = vi.fn().mockReturnValueOnce(command).mockReturnValue(command.replace('12:00:00', '12:00:01'));
        const probe = macosLegacyMcpProbe('/state/elepha.db', identity, {
            databaseFiles: () => lsof,
            processFiles: () => lsof,
            processCommand,
        });
        expect(probe.inspect(4242)).toBeUndefined();
    });

    it('does not match a different open database inode', () => {
        const probe = macosLegacyMcpProbe(
            '/state/elepha.db',
            { ...identity, ino: 99n },
            {
                databaseFiles: () => lsof,
                processFiles: () => lsof,
                processCommand: () => command,
            },
        );
        expect(probe.inspect(4242)).toBeUndefined();
    });

    it('identifies a read-write primary descriptor as a writer', () => {
        const probe = macosLegacyMcpProbe('/state/elepha.db', identity, {
            databaseFiles: () => lsof,
            processFiles: () => lsof.replace('f13\0ar\0', 'f13\0au\0'),
            processCommand: () => command,
        });
        expect(probe.inspect(4242)?.readOnly).toBe(false);
    });

    it.each([lsof.slice(0, -2), lsof.replace(`u${uid}\0`, ''), 'malformed output'])(
        'rejects incomplete or malformed lsof output',
        (text) => {
            const probe = macosLegacyMcpProbe('/state/elepha.db', identity, {
                databaseFiles: () => text,
                processFiles: () => text,
                processCommand: () => command,
            });
            expect(() => probe.list()).toThrow(/inspection returned/);
        },
    );
});

describe('Linux and WSL process inspection', () => {
    function procFixture() {
        const database = databaseFixture();
        const root = withGrantableTestDir('legacy-proc-');
        const processRoot = path.join(root, '4242');
        mkdirSync(path.join(processRoot, 'fd'), { recursive: true });
        mkdirSync(path.join(processRoot, 'fdinfo'));
        writeFileSync(path.join(processRoot, 'stat'), `4242 (node (mcp)) S ${Array(18).fill('0').join(' ')} 12345 0\n`);
        writeFileSync(path.join(processRoot, 'cmdline'), `node\0${installed.bin}\0mcp\0serve\0`);
        symlinkSync('/opt/npm/bin/node', path.join(processRoot, 'exe'));
        symlinkSync(database, path.join(processRoot, 'fd', '13'));
        writeFileSync(path.join(processRoot, 'fdinfo', '13'), 'pos:\t0\nflags:\t0100000\n');
        writeFileSync(
            path.join(processRoot, 'maps'),
            `1000-2000 r-xp 00000000 01:11 44 ${retiredRoot}/node_modules/better-sqlite3/prebuilds/linux-x64.node (deleted)\n`,
        );
        return { root, processRoot, probe: linuxLegacyMcpProbe(statSync(database, { bigint: true }), uid, root) };
    }

    it('reads exact argv, process generation, loaded retired package and RO descriptor without external tools', () => {
        const { probe } = procFixture();
        expect(probe.list()).toEqual([4242]);
        expect(probe.inspect(4242)).toEqual(
            candidate({
                startedAt: '12345',
                command: ['node', installed.bin, 'mcp', 'serve'],
                mappedFiles: [`${retiredRoot}/node_modules/better-sqlite3/prebuilds/linux-x64.node`],
            }),
        );
    });

    it('rejects writable access and does not assume opening the primary means read-only', () => {
        const { processRoot, probe } = procFixture();
        writeFileSync(path.join(processRoot, 'fdinfo', '13'), 'flags:\t0100002\n');
        expect(probe.inspect(4242)?.readOnly).toBe(false);
    });

    it('distinguishes an unknown descriptor mode from a disappeared process', () => {
        const { processRoot, probe } = procFixture();
        writeFileSync(path.join(processRoot, 'fdinfo', '13'), 'unrecognized\n');
        expect(() => probe.inspect(4242)).toThrow('Legacy MCP database descriptor access mode is unrecognized.');
        expect(probe.inspect(4243)).toBeUndefined();
    });

    it('bounds proc input while reading', () => {
        const { processRoot, probe } = procFixture();
        writeFileSync(path.join(processRoot, 'maps'), 'x'.repeat(LEGACY_MCP_INSPECTION_MAX_BYTES + 1));
        expect(() => probe.inspect(4242)).toThrow('exceeded its byte limit');
    });
});
