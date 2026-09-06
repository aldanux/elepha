import { describe, expect, it } from 'vitest';
import { LaunchdBackend } from '../../src/install/launchd-backend.js';
import { isSupportedPlatform } from '../../src/install/platform.js';
import type { ServiceBackend } from '../../src/install/service-backend.js';
import { reconcileCaptureServiceAsync, SERVICE_BACKEND_PLATFORM_ERROR, serviceBackend } from '../../src/install/service-backend.js';
import { SystemdBackend } from '../../src/install/systemd-backend.js';

describe('service backend factory', () => {
    it('selects the backend from each supported reported platform, including WSL', () => {
        const cases = [
            { platform: 'darwin', runtime: 'Darwin', backend: LaunchdBackend },
            { platform: 'linux', runtime: 'Linux', backend: SystemdBackend },
            { platform: 'linux', runtime: 'WSL reporting Linux', backend: SystemdBackend },
        ] as const;

        for (const testCase of cases) {
            expect(serviceBackend({ platform: testCase.platform, home: '/tmp/elepha-service-factory' }), testCase.runtime).toBeInstanceOf(
                testCase.backend,
            );
        }
    });

    it.each(['win32', 'freebsd'] as const)('rejects the unsupported %s runtime instead of selecting launchd', (platform) => {
        expect(() => serviceBackend({ platform, home: '/tmp/elepha-service-factory' })).toThrow(SERVICE_BACKEND_PLATFORM_ERROR);
    });
});

describe('install lifecycle platform support', () => {
    it('supports only macOS and Linux', () => {
        expect(isSupportedPlatform('darwin')).toBe(true);
        expect(isSupportedPlatform('linux')).toBe(true);
        expect(isSupportedPlatform('win32')).toBe(false);
        expect(isSupportedPlatform('freebsd')).toBe(false);
    });
});

describe('async service reconciliation', () => {
    it('yields between heartbeat checks while keeping the service enabled', async () => {
        const events: string[] = [];
        let healthChecks = 0;
        let now = 0;
        const service = {
            isInstalled: () => true,
            enable: () => events.push('enable'),
            start: () => events.push('start'),
            healthy: () => ++healthChecks === 2,
        } as unknown as ServiceBackend;

        await expect(
            reconcileCaptureServiceAsync(service, 1, {
                now: () => now,
                sleep: async (milliseconds) => {
                    events.push('yield');
                    now += milliseconds;
                },
            }),
        ).resolves.toBe('active');

        expect(events).toEqual(['enable', 'start', 'yield']);
        expect(healthChecks).toBe(2);
    });
});
