import { describe, expect, it, vi } from 'vitest';
import { type DoctorRuntime, runDoctor } from '../../src/install/doctor.js';
import type { DaemonHealth, IntegrationHealth } from '../../src/install/health-checks.js';
import { terminalHandoff } from '../../src/markers.js';

const activeIntegrations: IntegrationHealth = {
    bin: '/Users/test/.elepha/bin/elepha',
    status: {
        claudeHook: 'active',
        claudeUserPromptSubmitHook: 'active',
        codexHook: 'active',
        codexUserPromptSubmitHook: 'active',
        claudeMcp: 'registered',
        codexMcp: 'registered',
        deepseekMcp: 'registered',
        deepseekCommands: 'active',
        opencodeMcp: 'registered',
        kimiMcp: 'registered',
        kimiHook: 'active',
        opencodePlugin: 'installed',
        ready: true,
    },
    present: { claude: true, codex: true, deepseek: true, opencode: true, kimi: true },
};

function daemon(healthy: boolean): DaemonHealth {
    return { state: healthy ? 'RUNNING (pid 123, heartbeat 1s ago)' : 'NOT RUNNING (no heartbeat file)', healthy };
}

function runtime(overrides: Partial<DoctorRuntime> = {}): DoctorRuntime {
    return {
        inspectDaemon: () => daemon(true),
        inspectIntegrations: () => activeIntegrations,
        inspectDatabase: () => ({ approvedRoots: 1 }),
        inspectLauncher: () => ({ healthy: true, detail: 'managed launcher is valid' }),
        waitForHealthy: (service) => service.waitForHealthy(),
        ...overrides,
        approvedRoots: overrides.approvedRoots ?? 1,
    };
}

describe('elepha doctor', () => {
    it.each(['registered', 'not installed', 'stale binary', 'conflict', 'invalid', 'disabled', 'not present'] as const)(
        'reports Kimi user registration %s with project override precedence',
        async (kimiMcp) => {
            const result = await runDoctor(
                runtime({
                    inspectIntegrations: () => ({
                        ...activeIntegrations,
                        present: { ...activeIntegrations.present, kimi: kimiMcp !== 'not present' },
                        status: { ...activeIntegrations.status, kimiMcp },
                    }),
                }),
            );
            const line = result.lines.find((value) => value.includes('Kimi Code MCP (user)'));
            expect(line).toContain(kimiMcp);
            expect(line).toContain('project .kimi-code/mcp.json can override elepha');
            const ready = kimiMcp === 'registered' || kimiMcp === 'not present';
            expect(result.exitCode).toBe(ready ? 0 : 1);
            expect(result.nextSteps).toEqual(ready ? [] : [terminalHandoff('install')]);
        },
    );

    it.each(['active', 'not installed', 'stale bridge', 'stale hooks', 'conflict', 'invalid', 'disabled', 'not present'] as const)(
        'reports DeepSeek Harness in-chat command registration %s',
        async (deepseekCommands) => {
            const result = await runDoctor(
                runtime({
                    inspectIntegrations: () => ({
                        ...activeIntegrations,
                        present: { ...activeIntegrations.present, deepseek: deepseekCommands !== 'not present' },
                        status: { ...activeIntegrations.status, deepseekCommands },
                    }),
                }),
            );
            expect(result.lines).toContain(
                `${deepseekCommands === 'active' ? '✓' : deepseekCommands === 'not present' ? '⚠' : '✗'} DeepSeek Harness in-chat commands: ${deepseekCommands}`,
            );
            const ready = deepseekCommands === 'active' || deepseekCommands === 'not present';
            expect(result.exitCode).toBe(ready ? 0 : 1);
            expect(result.nextSteps).toEqual(ready ? [] : [terminalHandoff('install')]);
        },
    );

    it.each(['not installed', 'stale binary', 'conflict', 'stale plugin'] as const)(
        'reports an OpenCode plugin %s and provides the install handoff',
        async (opencodePlugin) => {
            const result = await runDoctor(
                runtime({
                    inspectIntegrations: () => ({
                        ...activeIntegrations,
                        status: { ...activeIntegrations.status, opencodePlugin, ready: false },
                    }),
                }),
            );
            expect(result.exitCode).toBe(1);
            expect(result.lines).toContain(`✗ OpenCode plugin: ${opencodePlugin}`);
            expect(result.nextSteps).toContain(terminalHandoff('install'));
        },
    );

    it.each(['registered', 'not installed', 'stale binary', 'conflict', 'invalid', 'disabled', 'not present'] as const)(
        'reports DeepSeek Harness MCP registration %s',
        async (deepseekMcp) => {
            const result = await runDoctor(
                runtime({
                    inspectIntegrations: () => ({
                        ...activeIntegrations,
                        present: { ...activeIntegrations.present, deepseek: deepseekMcp !== 'not present' },
                        status: { ...activeIntegrations.status, deepseekMcp },
                    }),
                }),
            );
            expect(result.lines).toContain(
                `${deepseekMcp === 'registered' ? '✓' : deepseekMcp === 'not present' ? '⚠' : '✗'} DeepSeek Harness MCP: ${deepseekMcp}`,
            );
            const ready = deepseekMcp === 'registered' || deepseekMcp === 'not present';
            expect(result.exitCode).toBe(ready ? 0 : 1);
            expect(result.nextSteps).toEqual(ready ? [] : [terminalHandoff('install')]);
        },
    );

    it('reports every healthy check and exits zero', async () => {
        const result = await runDoctor(runtime());

        expect(result.exitCode).toBe(0);
        expect(result.lines).toEqual(
            expect.arrayContaining([
                '✓ Daemon: RUNNING (pid 123, heartbeat 1s ago)',
                '✓ Claude Code hooks: SessionStart + UserPromptSubmit installed',
                '✓ Codex hooks: SessionStart + UserPromptSubmit installed and approved',
                '✓ MCP: Claude, Codex, OpenCode, Kimi Code, and DeepSeek Harness registered where detected',
                '✓ Database: opens and migrations apply',
                '✓ Consent: 1 approved root',
                '✓ Launcher: managed launcher is valid',
                'Summary: all checks passed.',
            ]),
        );
        expect(result.nextSteps).toEqual([]);
    });

    it('restarts a down daemon with the live approved-root count and exits zero after a healthy recheck', async () => {
        const service = { stop: vi.fn(), waitForHealthy: vi.fn(() => true) };
        const reconcile = vi.fn(() => 'active' as const);
        let checks = 0;

        const result = await runDoctor(
            runtime({
                service: service as never,
                inspectDaemon: () => daemon(checks++ > 0),
                approvedRoots: 3,
                inspectDatabase: () => ({ approvedRoots: 3 }),
                reconcile,
            }),
        );

        expect(service.stop).toHaveBeenCalledOnce();
        expect(reconcile).toHaveBeenCalledWith(service, 3);
        expect(service.waitForHealthy).toHaveBeenCalledOnce();
        expect(result.lines).toContain('✓ Daemon repair: restarted and heartbeat is healthy');
        expect(result.exitCode).toBe(0);
    });

    it('reports a failed daemon restart and exits non-zero', async () => {
        const service = { stop: vi.fn(), waitForHealthy: vi.fn(() => false) };

        const result = await runDoctor(
            runtime({
                service: service as never,
                inspectDaemon: () => daemon(false),
                reconcile: () => 'active',
            }),
        );

        expect(result.lines).toContain('✗ Daemon repair: restart did not produce a healthy heartbeat');
        expect(result.nextSteps).toEqual([terminalHandoff('install')]);
        expect(result.exitCode).toBe(1);
    });

    it('hands off to elepha install when the managed daemon service is not installed', async () => {
        const service = { stop: vi.fn(), waitForHealthy: vi.fn(() => true) };

        const result = await runDoctor(
            runtime({
                service: service as never,
                inspectDaemon: () => daemon(false),
                reconcile: () => 'not installed',
            }),
        );

        expect(result.lines).toContain('✗ Daemon repair: managed daemon service is not installed');
        expect(result.nextSteps).toEqual([terminalHandoff('install')]);
        expect(result.exitCode).toBe(1);
    });

    it('hands off to elepha install when the daemon repair throws', async () => {
        const service = {
            stop: vi.fn(() => {
                throw new Error('launchctl bootout failed');
            }),
            waitForHealthy: vi.fn(() => true),
        };

        const result = await runDoctor(
            runtime({ service: service as never, inspectDaemon: () => daemon(false), reconcile: () => 'active' }),
        );

        expect(result.lines).toContain('✗ Daemon repair: launchctl bootout failed');
        expect(result.nextSteps).toEqual([terminalHandoff('install')]);
        expect(result.exitCode).toBe(1);
    });

    it('hands off to elepha install when the launcher check itself fails', async () => {
        const result = await runDoctor(
            runtime({
                inspectLauncher: () => {
                    throw new Error('launcher manifest is unreadable');
                },
            }),
        );

        expect(result.lines).toContain('✗ Launcher: launcher manifest is unreadable');
        expect(result.nextSteps).toEqual([terminalHandoff('install')]);
        expect(result.exitCode).toBe(1);
    });

    it('hands off missing hooks and consent without installing or modifying consent', async () => {
        const result = await runDoctor(
            runtime({
                inspectIntegrations: () => ({
                    ...activeIntegrations,
                    status: { ...activeIntegrations.status, claudeHook: 'not installed', claudeMcp: 'not installed', ready: false },
                }),
                approvedRoots: 0,
                inspectDatabase: () => ({ approvedRoots: 0 }),
            }),
        );

        expect(result.exitCode).toBe(1);
        expect(result.nextSteps).toEqual([terminalHandoff('install'), terminalHandoff('consent grant <path>')]);
    });

    it('hands off to install when a detected OpenCode MCP registration is missing', async () => {
        const result = await runDoctor(
            runtime({
                inspectIntegrations: () => ({
                    ...activeIntegrations,
                    status: { ...activeIntegrations.status, opencodeMcp: 'not installed', ready: false },
                }),
            }),
        );

        expect(result.lines).toContain('✗ MCP: Claude, Codex, OpenCode, Kimi Code, and DeepSeek Harness must be registered where detected');
        expect(result.nextSteps).toEqual([terminalHandoff('install')]);
        expect(result.exitCode).toBe(1);
    });

    it('requires the detected Kimi prompt hook even when its MCP is registered', async () => {
        const result = await runDoctor(
            runtime({
                inspectIntegrations: () => ({
                    ...activeIntegrations,
                    status: { ...activeIntegrations.status, kimiHook: 'not installed', ready: false },
                }),
            }),
        );
        expect(result.lines.some((line) => line.includes('Kimi Code UserPromptSubmit hook') && line.includes('not installed'))).toBe(true);
        expect(result.nextSteps).toContain(terminalHandoff('install'));
        expect(result.exitCode).toBe(1);
    });

    it('hands off Codex hook approval without trying to change its trust state', async () => {
        const result = await runDoctor(
            runtime({
                inspectIntegrations: () => ({
                    ...activeIntegrations,
                    status: { ...activeIntegrations.status, codexHook: 'awaiting approval', ready: false },
                }),
            }),
        );

        expect(result.nextSteps).toEqual(['Open Codex → /hooks → approve the elepha hooks']);
        expect(result.exitCode).toBe(1);
    });

    it('reports database and launcher failures without attempting a repair beyond the daemon', async () => {
        const result = await runDoctor(
            runtime({
                inspectDatabase: () => {
                    throw new Error('database is unreadable');
                },
                inspectLauncher: () => ({ healthy: false, detail: 'launcher manifest is invalid' }),
            }),
        );

        expect(result.lines).toEqual(
            expect.arrayContaining([
                '✗ Database: database is unreadable',
                '✗ Consent: unavailable because the database could not be opened (database is unreadable)',
                '✗ Launcher: launcher manifest is invalid',
            ]),
        );
        expect(result.nextSteps).toContain(terminalHandoff('install'));
        expect(result.exitCode).toBe(1);
    });

    it('surfaces an interrupted install transaction as a recoverable install hand-off', async () => {
        const result = await runDoctor(runtime({ inspectInstallRecovery: () => true }));

        expect(result.lines).toContain(
            '✗ Install recovery: interrupted install transaction detected; elepha install will restore the previous state before retrying',
        );
        expect(result.nextSteps).toEqual([terminalHandoff('install')]);
        expect(result.exitCode).toBe(1);
    });
});
