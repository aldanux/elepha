import { existsSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { DAEMON_HEALTH_CHECK_DEADLINE_MS, DAEMON_OUTPUT_MAX_CHARS } from '../../src/config/constants.js';
import { elephaPaths } from '../../src/config/paths.js';
import {
    defaultLaunchdServicePaths,
    type LaunchctlExecutor,
    LaunchdBackend,
    launchdArtifactsMatch,
    managedPlistEnvironment,
    renderDaemonPlist,
} from '../../src/install/launchd-backend.js';
import { launcherHash } from '../../src/install/launcher.js';

const savedEnvironment = { ...process.env };

afterEach(() => {
    process.env = { ...savedEnvironment };
});

beforeEach(() => {
    delete process.env.ELEPHA_SERVICE_LABEL;
});

class FakeLaunchctl implements LaunchctlExecutor {
    loaded = false;
    disabled = false;
    calls: string[][] = [];

    run(args: readonly string[]) {
        this.calls.push([...args]);
        if (args[0] === 'print') return { stdout: '', stderr: '', status: this.loaded ? 0 : 3 };
        if (args[0] === 'print-disabled')
            return { stdout: `"com.elepha.daemon" => ${this.disabled ? 'true' : 'false'}`, stderr: '', status: 0 };
        if (args[0] === 'disable') this.disabled = true;
        if (args[0] === 'enable') this.disabled = false;
        if (args[0] === 'bootstrap') this.loaded = true;
        if (args[0] === 'bootout') this.loaded = false;
        return { stdout: '', stderr: '', status: 0 };
    }
}

describe('daemon service ownership', () => {
    it('requires an explicit launchctl executor at construction', () => {
        const constructWithoutExecutor = () => {
            // @ts-expect-error The real launchctl executor must never be an implicit test fallback.
            new LaunchdBackend(defaultLaunchdServicePaths('/Users/test'));
        };

        expect(constructWithoutExecutor).toBeTypeOf('function');
    });

    it('uses the canonical elepha layout for every managed artifact path', () => {
        const home = '/Users/test';
        const layout = elephaPaths(home);

        expect(defaultLaunchdServicePaths(home)).toMatchObject({
            home,
            launcher: layout.launcher,
            plist: layout.launchAgent,
            state: layout.installState,
            transaction: layout.installTransaction,
            heartbeat: layout.heartbeat,
            stdout: layout.stdout,
            stderr: layout.stderr,
        });
    });

    it('reports a definitive status for launchd probes', () => {
        const executor = new FakeLaunchctl();
        executor.loaded = true;
        const service = new LaunchdBackend(defaultLaunchdServicePaths('/Users/test'), executor, 501);

        expect(service.status()).toEqual({ loaded: true, disabled: false, unknown: false });
    });

    it('accepts a heartbeat that appears late but before the 60-second deadline', () => {
        const home = mkdtempSync(path.join(tmpdir(), 'elepha-service-'));
        let now = 0;
        const sleeps: number[] = [];
        const service = new LaunchdBackend(defaultLaunchdServicePaths(home), new FakeLaunchctl(), 501, {
            now: () => now,
            sleep(milliseconds) {
                sleeps.push(milliseconds);
                now += milliseconds;
            },
        });
        vi.spyOn(service, 'healthy').mockImplementation(() => now >= DAEMON_HEALTH_CHECK_DEADLINE_MS - 250);

        expect(service.waitForHealthy()).toBe(true);
        expect(now).toBe(DAEMON_HEALTH_CHECK_DEADLINE_MS - 250);
        expect(sleeps).toHaveLength((DAEMON_HEALTH_CHECK_DEADLINE_MS - 250) / 250);
    });

    it('fails only after the complete 60-second heartbeat deadline', () => {
        const home = mkdtempSync(path.join(tmpdir(), 'elepha-service-'));
        let now = 0;
        const sleeps: number[] = [];
        const service = new LaunchdBackend(defaultLaunchdServicePaths(home), new FakeLaunchctl(), 501, {
            now: () => now,
            sleep(milliseconds) {
                sleeps.push(milliseconds);
                now += milliseconds;
            },
        });
        vi.spyOn(service, 'healthy').mockReturnValue(false);

        expect(service.waitForHealthy()).toBe(false);
        expect(now).toBe(DAEMON_HEALTH_CHECK_DEADLINE_MS);
        expect(sleeps).toHaveLength(DAEMON_HEALTH_CHECK_DEADLINE_MS / 250);
    });

    it('uses the override label for every launchctl target and the LaunchAgents plist name', () => {
        const home = mkdtempSync(path.join(tmpdir(), 'elepha-service-'));
        process.env.ELEPHA_SERVICE_LABEL = 'com.elepha.gate7test';
        const paths = defaultLaunchdServicePaths(home);
        const executor = new FakeLaunchctl();
        const service = new LaunchdBackend(paths, executor, 501);

        service.start();
        service.stop();

        expect(paths.label).toBe('com.elepha.gate7test');
        expect(paths.plist).toBe(path.join(home, 'Library', 'LaunchAgents', 'com.elepha.gate7test.plist'));
        expect(executor.calls).toContainEqual(['bootstrap', 'gui/501', paths.plist]);
        expect(executor.calls).toContainEqual(['bootout', 'gui/501/com.elepha.gate7test']);
    });

    it('restarts by booting out before bootstrapping the service again', () => {
        const home = mkdtempSync(path.join(tmpdir(), 'elepha-service-'));
        const executor = new FakeLaunchctl();
        executor.loaded = true;
        const service = new LaunchdBackend(defaultLaunchdServicePaths(home), executor, 501);

        service.restart();

        expect(executor.calls.filter(([verb]) => verb === 'bootout' || verb === 'bootstrap').map(([verb]) => verb)).toEqual([
            'bootout',
            'bootstrap',
        ]);
    });

    it('waits for an asynchronous bootout to unload the service', () => {
        const home = mkdtempSync(path.join(tmpdir(), 'elepha-service-'));
        let now = 0;
        let bootedOut = false;
        let printsAfterBootout = 0;
        const sleeps: number[] = [];
        const executor: LaunchctlExecutor = {
            run(args) {
                if (args[0] === 'bootout') {
                    bootedOut = true;
                    return { stdout: '', stderr: '', status: 0 };
                }
                if (args[0] === 'print') {
                    if (!bootedOut) {
                        return { stdout: 'loaded', stderr: '', status: 0 };
                    }
                    printsAfterBootout++;
                    return { stdout: '', stderr: '', status: printsAfterBootout <= 3 ? 0 : 3 };
                }
                return { stdout: '', stderr: '', status: 0 };
            },
        };
        const service = new LaunchdBackend(defaultLaunchdServicePaths(home), executor, 501, {
            now: () => now,
            sleep(milliseconds) {
                sleeps.push(milliseconds);
                now += milliseconds;
            },
        });

        service.stop();

        expect(printsAfterBootout).toBe(4);
        expect(sleeps).toEqual([250, 250, 250]);
        expect(now).toBe(750);
    });

    it('fails when bootout does not unload the service before its deadline', () => {
        const home = mkdtempSync(path.join(tmpdir(), 'elepha-service-'));
        let now = 0;
        const executor: LaunchctlExecutor = {
            run(args) {
                if (args[0] === 'print') return { stdout: 'loaded', stderr: '', status: 0 };
                return { stdout: '', stderr: '', status: 0 };
            },
        };
        const service = new LaunchdBackend(defaultLaunchdServicePaths(home), executor, 501, {
            now: () => now,
            sleep(milliseconds) {
                now += milliseconds;
            },
        });

        expect(() => service.stop()).toThrow('launchctl bootout did not unload the service within 20s');
        expect(now).toBe(20_000);
    });

    it('propagates only active isolation locations into the managed plist', () => {
        const home = mkdtempSync(path.join(tmpdir(), 'elepha-service-'));
        const paths = defaultLaunchdServicePaths(home);
        const service = new LaunchdBackend(paths, new FakeLaunchctl(), 501);
        const environment = {
            ELEPHA_HOME: '/tmp/elepha-gate7test/elepha',
            ELEPHA_DB_PATH: '/tmp/elepha-gate7test/elepha/elepha.db',
            ELEPHA_ENV_FILE: '/tmp/elepha-gate7test/elepha/.env',
            CLAUDE_CONFIG_DIR: '/tmp/elepha-gate7test/claude',
            CODEX_HOME: '/tmp/elepha-gate7test/codex',
            ELEPHA_CLAUDE_MCP_PATH: '/tmp/elepha-gate7test/claude-mcp.json',
            ANTHROPIC_API_KEY: 'must-not-enter-a-plist',
        };
        Object.assign(process.env, environment);
        service.install('#!/bin/sh\n', { kind: 'standalone', command: '/usr/local/bin/elepha', node: '/usr/local/bin/node' });
        const plist = readFileSync(paths.plist, 'utf8');

        for (const [key, value] of managedPlistEnvironment(environment)) {
            expect(plist).toContain(`<key>${key}</key><string>${value}</string>`);
        }
        expect(plist).not.toContain('must-not-enter-a-plist');
    });

    it('renders an identical plist and manifest hash for equivalent install paths however the installing shell expressed them', () => {
        const physical = realpathSync(mkdtempSync(path.join(tmpdir(), 'elepha-service-')));
        const aliasParent = realpathSync(mkdtempSync(path.join(tmpdir(), 'elepha-service-alias-')));
        const alias = path.join(aliasParent, 'home-link');
        symlinkSync(physical, alias);
        mkdirSync(path.join(physical, 'claude'), { recursive: true });

        const physicalEnvironment = {
            ELEPHA_HOME: path.join(physical, 'elepha'),
            CLAUDE_CONFIG_DIR: path.join(physical, 'claude'),
        };
        const shellEnvironment = {
            ELEPHA_HOME: path.join(alias, 'elepha'),
            CLAUDE_CONFIG_DIR: path.relative(process.cwd(), path.join(physical, 'claude')),
        };

        const fromPhysical = renderDaemonPlist(defaultLaunchdServicePaths(physical), physicalEnvironment);
        const fromShell = renderDaemonPlist(defaultLaunchdServicePaths(alias), shellEnvironment);

        expect(fromShell).toBe(fromPhysical);
        expect(launcherHash(fromShell)).toBe(launcherHash(fromPhysical));
        expect(fromShell).toContain(`<key>ELEPHA_HOME</key><string>${path.join(physical, 'elepha')}</string>`);
        expect(fromShell).toContain(`<key>CLAUDE_CONFIG_DIR</key><string>${path.join(physical, 'claude')}</string>`);
        expect(fromShell).toContain(
            `<key>ProgramArguments</key><array><string>${path.join(physical, '.elepha', 'bin', 'elepha')}</string>`,
        );
        expect(fromShell).not.toContain(alias);
    });

    it('keeps the default label and plist environment unchanged when overrides are absent', () => {
        const home = mkdtempSync(path.join(tmpdir(), 'elepha-service-'));
        delete process.env.ELEPHA_SERVICE_LABEL;
        const paths = defaultLaunchdServicePaths(home);
        const plist = renderDaemonPlist(paths, {});

        expect(paths.label).toBe('com.elepha.daemon');
        expect(paths.plist).toBe(path.join(home, 'Library', 'LaunchAgents', 'com.elepha.daemon.plist'));
        expect(plist).toContain('<key>Label</key><string>com.elepha.daemon</string>');
        expect(plist).toContain('<key>EnvironmentVariables</key><dict><key>HOME</key>');
        expect(plist).not.toContain('<key>ELEPHA_HOME</key>');
        expect(plist).not.toContain('<key>CLAUDE_CONFIG_DIR</key>');
    });

    it('does not treat an absent target as proof that the service is disabled', () => {
        const home = mkdtempSync(path.join(tmpdir(), 'elepha-service-'));
        const executor: LaunchctlExecutor = {
            run(args) {
                if (args[0] === 'print') return { stdout: '', stderr: 'Could not find service', status: 3 };
                if (args[0] === 'print-disabled') return { stdout: `\t\t"com.elepha.daemon" => enabled`, stderr: '', status: 0 };
                if (args[0] === 'disable') return { stdout: '', stderr: 'Could not find service', status: 113 };
                return { stdout: '', stderr: '', status: 0 };
            },
        };

        expect(() => new LaunchdBackend(defaultLaunchdServicePaths(home), executor, 501).disable()).toThrow(
            /launchctl disable .*status 113.*Could not find service/,
        );
    });

    it('accepts disable only after print-disabled reports the label disabled', () => {
        const home = mkdtempSync(path.join(tmpdir(), 'elepha-service-'));
        let disabled = false;
        const executor: LaunchctlExecutor = {
            run(args) {
                if (args[0] === 'print-disabled') {
                    return {
                        stdout: `\t\t"com.elepha.daemon" => ${disabled ? 'disabled' : 'enabled'}`,
                        stderr: '',
                        status: 0,
                    };
                }
                if (args[0] === 'disable') {
                    disabled = true;
                }
                return { stdout: '', stderr: '', status: 0 };
            },
        };

        const service = new LaunchdBackend(defaultLaunchdServicePaths(home), executor, 501);

        expect(() => service.disable()).not.toThrow();
        expect(service.isDisabled()).toBe(true);
    });

    it('parses the real macOS print-disabled enabled and disabled output', () => {
        const home = mkdtempSync(path.join(tmpdir(), 'elepha-service-'));
        let stdout = '\t\t"com.elepha.daemon" => enabled';
        const executor: LaunchctlExecutor = {
            run(args) {
                if (args[0] === 'print-disabled') return { stdout, stderr: '', status: 0 };
                return { stdout: '', stderr: '', status: 0 };
            },
        };
        const service = new LaunchdBackend(defaultLaunchdServicePaths(home), executor, 501);

        expect(service.isDisabled()).toBe(false);
        stdout = '\t\t"com.elepha.daemon" => disabled';
        expect(service.isDisabled()).toBe(true);
    });

    it('rejects lifecycle failures with bounded diagnostics and no false healthy state', () => {
        const cases = [
            { verb: 'disable', status: 77, loaded: true, disabled: false },
            { verb: 'bootstrap', status: 78, loaded: false, disabled: false },
            { verb: 'enable', status: 79, loaded: false, disabled: true },
        ] as const;

        for (const testCase of cases) {
            const home = mkdtempSync(path.join(tmpdir(), 'elepha-service-'));
            const omittedHead = `UNBOUNDED_${testCase.verb.toUpperCase()}_HEAD`;
            const outputTail = `${testCase.verb} output tail`;
            const errorTail = `${testCase.verb}\u0000 denied tail`;
            const executor: LaunchctlExecutor = {
                run(args) {
                    if (args[0] === testCase.verb) {
                        return {
                            stdout: `${omittedHead}${'o'.repeat(DAEMON_OUTPUT_MAX_CHARS + 50)}${outputTail}`,
                            stderr: `${omittedHead}${'e'.repeat(DAEMON_OUTPUT_MAX_CHARS + 50)}${errorTail}`,
                            status: testCase.status,
                        };
                    }
                    if (args[0] === 'print') {
                        return {
                            stdout: testCase.loaded ? 'service loaded' : 'service absent',
                            stderr: '',
                            status: testCase.loaded ? 0 : 3,
                        };
                    }
                    if (args[0] === 'print-disabled') {
                        return {
                            stdout: `"com.elepha.daemon" => ${testCase.disabled ? 'true' : 'false'}`,
                            stderr: '',
                            status: 0,
                        };
                    }
                    return { stdout: '', stderr: '', status: 0 };
                },
            };
            const service = new LaunchdBackend(defaultLaunchdServicePaths(home), executor, 501);
            const invoke = () => {
                if (testCase.verb === 'disable') service.disable();
                if (testCase.verb === 'bootstrap') service.start();
                if (testCase.verb === 'enable') service.enable();
            };

            let failure: Error | undefined;
            try {
                invoke();
            } catch (error) {
                failure = error as Error;
            }

            expect(failure, testCase.verb).toBeInstanceOf(Error);
            expect(failure?.message).toContain(`launchctl ${testCase.verb}`);
            expect(failure?.message).toContain(`status ${testCase.status}`);
            expect(failure?.message).toContain('older characters omitted');
            expect(failure?.message).toContain(outputTail);
            expect(failure?.message).toContain(errorTail.replace('\u0000', ' '));
            expect(failure?.message).not.toContain(omittedHead);
            expect(failure?.message).not.toContain('\u0000');
            expect(service.status()).toEqual({ loaded: testCase.loaded, disabled: testCase.disabled, unknown: false });
        }
    });

    it('writes deterministic managed artifacts and leaves an inert service disabled and unloaded', () => {
        const home = mkdtempSync(path.join(tmpdir(), 'elepha-service-'));
        const paths = defaultLaunchdServicePaths(home);
        const executor = new FakeLaunchctl();
        const service = new LaunchdBackend(paths, executor, 501);
        const launcher = '#!/bin/sh\nset -eu\n';

        service.disable();
        service.install(launcher, { kind: 'standalone', command: '/usr/local/bin/elepha', node: '/usr/local/bin/node' });

        expect(launchdArtifactsMatch(paths)).toBe(true);
        expect(executor.loaded).toBe(false);
        expect(executor.disabled).toBe(true);
        expect(readFileSync(paths.plist, 'utf8')).toBe(renderDaemonPlist(paths));
        // Rendered paths are physical because the tmpdir home is itself a symlink on macOS.
        expect(readFileSync(paths.plist, 'utf8')).toContain(
            `<key>ProgramArguments</key><array><string>${realpathSync(paths.launcher)}</string><string>start</string>`,
        );
        expect(readFileSync(paths.plist, 'utf8')).not.toContain('/usr/local/bin/node');
    });

    it('refuses a modified managed artifact instead of classifying it as healthy ownership', () => {
        const home = mkdtempSync(path.join(tmpdir(), 'elepha-service-'));
        const paths = defaultLaunchdServicePaths(home);
        const service = new LaunchdBackend(paths, new FakeLaunchctl(), 501);
        service.install('#!/bin/sh\n', { kind: 'standalone', command: '/usr/local/bin/elepha', node: '/usr/local/bin/node' });
        writeFileSync(paths.launcher, '# modified\n');
        expect(launchdArtifactsMatch(paths)).toBe(false);
        service.uninstall();
        expect(existsSync(paths.launcher)).toBe(false);
    });
});
