import { describe, expect, it } from 'vitest';
import { type SelfUpdateRuntime, selfUpdate } from '../../src/install/self-update.js';
import type { ServiceBackend } from '../../src/install/service-backend.js';

interface Scenario {
    platform?: NodeJS.Platform;
    latest?: string;
    latestError?: Error;
    installVersionError?: Error;
    approvedRoots?: number;
    reconciliation: Array<'active' | 'awaiting consent' | 'not installed' | Error>;
}

function runtimeFor(scenario: Scenario): { runtime: SelfUpdateRuntime; events: string[] } {
    const events: string[] = [];
    let packageReads = 0;

    return {
        events,
        runtime: {
            platform: scenario.platform ?? 'darwin',
            resolveInstalledBin: () => ({ bin: '/opt/npm/bin/elepha', packageRoot: '/opt/npm/lib/node_modules/elepha' }),
            readPackageVersion: () => (packageReads++ === 0 ? '1.2.3' : (scenario.latest ?? '1.2.3')),
            detectBackend: () => ({
                kind: 'standalone',
                command: '/usr/local/bin/elepha',
                node: '/usr/local/bin/node',
                npmBin: '/usr/local/bin',
            }),
            npm: {
                latestVersion() {
                    events.push('npm view elepha@latest');
                    if (scenario.latestError) {
                        throw scenario.latestError;
                    }
                    return scenario.latest ?? '1.2.4';
                },
                installLatest() {
                    events.push('npm install elepha@latest');
                },
                installVersion(version) {
                    events.push(`npm install elepha@${version}`);
                    if (scenario.installVersionError) {
                        throw scenario.installVersionError;
                    }
                },
            },
            service: {
                stop() {
                    events.push('service stop');
                },
            } as ServiceBackend,
            approvedRoots: scenario.approvedRoots ?? 1,
            reconcile() {
                events.push('service reconcile and verify heartbeat');
                const next = scenario.reconciliation.shift();
                if (next instanceof Error) {
                    throw next;
                }
                return next ?? 'active';
            },
        },
    };
}

describe('selfUpdate', () => {
    it('updates and restarts the injected service on Linux', () => {
        const { runtime, events } = runtimeFor({ platform: 'linux', latest: '1.2.4', reconciliation: ['active'] });

        expect(selfUpdate(runtime)).toEqual({ status: 'updated', previousVersion: '1.2.3', version: '1.2.4' });
        expect(events).toContain('service stop');
        expect(events).toContain('service reconcile and verify heartbeat');
    });

    it('refuses Windows before resolving or mutating update state', () => {
        const { runtime, events } = runtimeFor({ platform: 'win32', reconciliation: [] });

        expect(() => selfUpdate(runtime)).toThrow('supported on macOS and Linux');
        expect(events).toEqual([]);
    });

    it('installs the registry version, restarts capture with approved roots, and reports the installed version after a healthy heartbeat', () => {
        const { runtime, events } = runtimeFor({ latest: '1.2.4', approvedRoots: 1, reconciliation: ['active'] });

        expect(selfUpdate(runtime)).toEqual({ status: 'updated', previousVersion: '1.2.3', version: '1.2.4' });
        expect(events).toEqual([
            'npm view elepha@latest',
            'npm install elepha@latest',
            'service stop',
            'service reconcile and verify heartbeat',
        ]);
    });

    it('reports updated without rollback when capture is awaiting consent', () => {
        const { runtime, events } = runtimeFor({ latest: '1.2.4', approvedRoots: 0, reconciliation: ['awaiting consent'] });

        expect(selfUpdate(runtime)).toEqual({ status: 'updated', previousVersion: '1.2.3', version: '1.2.4' });
        expect(events).toEqual([
            'npm view elepha@latest',
            'npm install elepha@latest',
            'service stop',
            'service reconcile and verify heartbeat',
        ]);
    });

    it('aborts before stopping capture when the latest registry version cannot be resolved', () => {
        const { runtime, events } = runtimeFor({
            latestError: new Error('npm ERR! code E404\nelepha@latest is unpublished'),
            reconciliation: [],
        });

        expect(() => selfUpdate(runtime)).toThrow('self-update preflight failed: could not resolve elepha@latest: npm ERR! code E404');
        expect(events).toEqual(['npm view elepha@latest']);
    });

    it('restores the recorded version when the updated daemon fails its health verification', () => {
        const { runtime, events } = runtimeFor({
            latest: '1.2.4',
            reconciliation: [new Error('capture service did not produce a healthy heartbeat; daemon stderr: migration failed'), 'active'],
        });

        expect(selfUpdate(runtime)).toEqual({
            status: 'rolled-back',
            previousVersion: '1.2.3',
            attemptedVersion: '1.2.4',
            failure: 'capture service did not produce a healthy heartbeat; daemon stderr: migration failed',
        });
        expect(events).toEqual([
            'npm view elepha@latest',
            'npm install elepha@latest',
            'service stop',
            'service reconcile and verify heartbeat',
            'npm install elepha@1.2.3',
            'service stop',
            'service reconcile and verify heartbeat',
        ]);
    });

    it('reports a failed package rollback and directs recovery to doctor', () => {
        const { runtime, events } = runtimeFor({
            latest: '1.2.4',
            installVersionError: new Error('npm ERR! network timeout'),
            reconciliation: [new Error('updated launchctl bootstrap failed')],
        });

        expect(() => selfUpdate(runtime)).toThrow(
            'self-update failed after installing 1.2.4: updated launchctl bootstrap failed; rollback to 1.2.3 failed: npm ERR! network timeout; run elepha doctor',
        );
        expect(events).toEqual([
            'npm view elepha@latest',
            'npm install elepha@latest',
            'service stop',
            'service reconcile and verify heartbeat',
            'npm install elepha@1.2.3',
        ]);
    });

    it('distinguishes a reverted package from a service that failed to restart after the revert', () => {
        const { runtime, events } = runtimeFor({
            latest: '1.2.4',
            reconciliation: [new Error('updated launchctl bootstrap failed'), new Error('rollback launchctl bootstrap failed')],
        });

        let thrown: unknown;
        try {
            selfUpdate(runtime);
        } catch (error) {
            thrown = error;
        }
        expect(thrown).toBeInstanceOf(Error);
        const message = (thrown as Error).message;
        expect(message).toContain('self-update failed after installing 1.2.4: updated launchctl bootstrap failed');
        expect(message).toContain('package reverted to 1.2.3');
        expect(message).toContain('rollback launchctl bootstrap failed');
        expect(message).toContain('run elepha doctor');
        expect(message).not.toContain('rollback to 1.2.3 failed');
        expect(events).toEqual([
            'npm view elepha@latest',
            'npm install elepha@latest',
            'service stop',
            'service reconcile and verify heartbeat',
            'npm install elepha@1.2.3',
            'service stop',
            'service reconcile and verify heartbeat',
        ]);
    });

    it('does not report a rollback failure when the package was reverted and only the service is not installed', () => {
        const { runtime, events } = runtimeFor({
            latest: '1.2.4',
            reconciliation: ['not installed', 'not installed'],
        });

        let thrown: unknown;
        try {
            selfUpdate(runtime);
        } catch (error) {
            thrown = error;
        }
        expect(thrown).toBeInstanceOf(Error);
        const message = (thrown as Error).message;
        expect(message).toContain('package reverted to 1.2.3');
        expect(message).toContain('capture service is not installed');
        expect(message).toContain('run elepha install');
        expect(message).not.toContain('rollback to 1.2.3 failed');
        expect(message).not.toContain('rollback failed');
        expect(events).toEqual([
            'npm view elepha@latest',
            'npm install elepha@latest',
            'service stop',
            'service reconcile and verify heartbeat',
            'npm install elepha@1.2.3',
            'service stop',
            'service reconcile and verify heartbeat',
        ]);
    });
});
