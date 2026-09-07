import { describe, expect, it, vi } from 'vitest';
import { migrateDatabaseForInstall, retiredLegacyMcpMessage } from '../../src/install/database-migration.js';
import { DATABASE_MIGRATION_CONNECTIONS_ACTIVE } from '../../src/storage/database-migration.js';

const installed = { bin: '/opt/npm/bin/elepha', packageRoot: '/opt/npm/lib/node_modules/elepha' };
const database = '/state/elepha.db';

describe('install database migration', () => {
    it('does not inspect or retire processes when migration succeeds', async () => {
        const retireReaders = vi.fn();
        const resolveInstalledBin = vi.fn();
        await migrateDatabaseForInstall(database, { migrate: async () => undefined, retireReaders, resolveInstalledBin });
        expect(retireReaders).not.toHaveBeenCalled();
        expect(resolveInstalledBin).not.toHaveBeenCalled();
    });

    it('preserves unrelated migration failures without process inspection', async () => {
        const failure = new Error('key commitment indeterminate');
        const retireReaders = vi.fn();
        await expect(
            migrateDatabaseForInstall(database, {
                migrate: async () => {
                    throw failure;
                },
                retireReaders,
            }),
        ).rejects.toBe(failure);
        expect(retireReaders).not.toHaveBeenCalled();
    });

    it('retires verified old readers, reports the action exactly, then retries migration once', async () => {
        const events: string[] = [];
        const migrate = vi
            .fn()
            .mockImplementationOnce(async () => {
                events.push('blocked');
                throw new Error(DATABASE_MIGRATION_CONNECTIONS_ACTIVE);
            })
            .mockImplementationOnce(async () => {
                events.push('migrated');
            });
        const retireReaders = vi.fn(async () => {
            events.push('retired');
            return 1;
        });
        await migrateDatabaseForInstall(database, {
            migrate,
            retireReaders,
            resolveInstalledBin: () => installed,
            report: (message) => events.push(message),
        });
        expect(retireReaders).toHaveBeenCalledExactlyOnceWith(database, installed);
        expect(events).toEqual(['blocked', 'retired', retiredLegacyMcpMessage(1), 'migrated']);
        expect(retiredLegacyMcpMessage(1)).toBe('Retired 1 stale elepha MCP process(es); retrying database migration.');
        expect(migrate).toHaveBeenCalledTimes(2);
    });

    it('keeps unknown readers blocked without retry or a false retirement report', async () => {
        const failure = new Error(DATABASE_MIGRATION_CONNECTIONS_ACTIVE);
        const migrate = vi.fn(async () => {
            throw failure;
        });
        const report = vi.fn();
        await expect(
            migrateDatabaseForInstall(database, {
                migrate,
                retireReaders: async () => 0,
                resolveInstalledBin: () => installed,
                report,
            }),
        ).rejects.toBe(failure);
        expect(migrate).toHaveBeenCalledOnce();
        expect(report).not.toHaveBeenCalled();
    });

    it('does not repeat retirement when the single retry is still blocked', async () => {
        const failure = new Error(DATABASE_MIGRATION_CONNECTIONS_ACTIVE);
        const migrate = vi.fn(async () => {
            throw failure;
        });
        const retireReaders = vi.fn(async () => 1);
        await expect(
            migrateDatabaseForInstall(database, {
                migrate,
                retireReaders,
                resolveInstalledBin: () => installed,
                report: () => undefined,
            }),
        ).rejects.toBe(failure);
        expect(migrate).toHaveBeenCalledTimes(2);
        expect(retireReaders).toHaveBeenCalledOnce();
    });
});
