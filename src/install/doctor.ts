import { existsSync } from 'node:fs';
import { elephaInstallTransactionPath } from '../config/paths.js';
import { terminalHandoff } from '../markers.js';
import { TOOL_METADATA } from '../types/index.js';
import { errorMessage } from '../util/error.js';
import {
    type DaemonHealth,
    daemonHealth,
    type IntegrationHealth,
    integrationHealth,
    type LauncherHealth,
    managedLauncherHealth,
} from './health-checks.js';
import { reconcileCaptureService, type ServiceBackend, serviceBackend } from './service-backend.js';

export interface DoctorRuntime {
    approvedRoots: number;
    service?: ServiceBackend;
    inspectDaemon?: () => DaemonHealth;
    inspectIntegrations?: () => IntegrationHealth;
    inspectDatabase?: () => void;
    inspectLauncher?: () => LauncherHealth;
    inspectInstallRecovery?: () => boolean;
    reconcile?: (service: ServiceBackend, approvedRoots: number) => 'not installed' | 'awaiting consent' | 'active';
}

export interface DoctorResult {
    lines: string[];
    nextSteps: string[];
    exitCode: 0 | 1;
}

function hasCodexApprovalIssue(status: IntegrationHealth['status']): boolean {
    return status.codexHook === 'awaiting approval' || status.codexUserPromptSubmitHook === 'awaiting approval';
}

function addNextStep(nextSteps: string[], line: string): void {
    if (!nextSteps.includes(line)) {
        nextSteps.push(line);
    }
}

/**
 * Read every recovery prerequisite, repairing only a non-healthy managed daemon.
 * The injected seams make the service lifecycle deterministic in unit tests.
 */
export function runDoctor(runtime: DoctorRuntime): DoctorResult;
export function runDoctor(runtime: DoctorRuntime = missingApprovedRoots()): DoctorResult {
    const lines: string[] = [];
    const repairLines: string[] = [];
    const nextSteps: string[] = [];
    const inspectDaemon = runtime.inspectDaemon ?? daemonHealth;
    const inspectIntegrations = runtime.inspectIntegrations ?? integrationHealth;
    const inspectDatabase = runtime.inspectDatabase ?? (() => undefined);
    const inspectLauncher = runtime.inspectLauncher ?? managedLauncherHealth;
    const inspectInstallRecovery = runtime.inspectInstallRecovery ?? (() => existsSync(elephaInstallTransactionPath()));
    const service = runtime.service ?? serviceBackend();
    const reconcile = runtime.reconcile ?? reconcileCaptureService;

    let installRecoveryOk = true;
    try {
        if (inspectInstallRecovery()) {
            installRecoveryOk = false;
            lines.push(
                '✗ Install recovery: interrupted install transaction detected; elepha install will restore the previous state before retrying',
            );
            addNextStep(nextSteps, terminalHandoff('install'));
        }
    } catch (error) {
        installRecoveryOk = false;
        lines.push(`✗ Install recovery: ${errorMessage(error)}`);
    }

    let daemon = inspectDaemon();
    let daemonOk = daemon.healthy;
    if (daemon.healthy) {
        lines.push(`✓ Daemon: ${daemon.state}`);
    } else {
        lines.push(`⚠ Daemon: ${daemon.state}`);
    }

    let approvedRoots: number | undefined = runtime.approvedRoots;
    let databaseError: string | undefined;
    let databaseLine: string;
    try {
        inspectDatabase();
        databaseLine = '✓ Database: opens and migrations apply';
    } catch (error) {
        approvedRoots = undefined;
        databaseError = errorMessage(error);
        databaseLine = `✗ Database: ${databaseError}`;
    }

    if (!daemon.healthy) {
        if (approvedRoots === undefined) {
            repairLines.push('✗ Daemon repair: skipped because the consent store could not be opened');
            daemonOk = false;
        } else {
            // Doctor repairs only by restarting; anything it cannot restart
            // hands off to the installer, which owns the managed artifacts.
            const installHandOff = terminalHandoff('install');
            try {
                service.stop();
                const reconciled = reconcile(service, approvedRoots);
                if (reconciled === 'not installed') {
                    daemonOk = false;
                    repairLines.push('✗ Daemon repair: managed daemon service is not installed');
                    addNextStep(nextSteps, installHandOff);
                } else if (reconciled === 'awaiting consent') {
                    daemonOk = false;
                    repairLines.push('✗ Daemon repair: capture is awaiting consent');
                } else if (!service.waitForHealthy()) {
                    daemonOk = false;
                    repairLines.push('✗ Daemon repair: restart did not produce a healthy heartbeat');
                    addNextStep(nextSteps, installHandOff);
                } else {
                    daemon = inspectDaemon();
                    daemonOk = daemon.healthy;
                    repairLines.push(daemonOk ? '✓ Daemon repair: restarted and heartbeat is healthy' : `✗ Daemon repair: ${daemon.state}`);
                    if (!daemonOk) {
                        addNextStep(nextSteps, installHandOff);
                    }
                }
            } catch (error) {
                daemonOk = false;
                repairLines.push(`✗ Daemon repair: ${errorMessage(error)}`);
                addNextStep(nextSteps, installHandOff);
            }
        }
    }

    let integrations: IntegrationHealth | undefined;
    try {
        integrations = inspectIntegrations();
        const { present, status } = integrations;
        const claudeReady = status.claudeHook === 'active' && status.claudeUserPromptSubmitHook === 'active';
        const codexReady = status.codexHook === 'active' && status.codexUserPromptSubmitHook === 'active';
        const mcpReady = (!present.claude || status.claudeMcp === 'registered') && (!present.codex || status.codexMcp === 'registered');
        const claudeDisplayName = TOOL_METADATA['claude-code'].displayName;
        const codexDisplayName = TOOL_METADATA.codex.displayName;
        lines.push(
            !present.claude
                ? `⚠ ${claudeDisplayName} hooks: ${claudeDisplayName} not detected`
                : claudeReady
                  ? `✓ ${claudeDisplayName} hooks: SessionStart + UserPromptSubmit installed`
                  : `✗ ${claudeDisplayName} hooks: SessionStart + UserPromptSubmit must be installed`,
        );
        lines.push(
            !present.codex
                ? `⚠ ${codexDisplayName} hooks: ${codexDisplayName} not detected`
                : codexReady
                  ? `✓ ${codexDisplayName} hooks: SessionStart + UserPromptSubmit installed and approved`
                  : hasCodexApprovalIssue(status)
                    ? `✗ ${codexDisplayName} hooks: approval is required`
                    : `✗ ${codexDisplayName} hooks: SessionStart + UserPromptSubmit must be installed and approved`,
        );
        lines.push(mcpReady ? '✓ MCP: Claude and Codex registered' : '✗ MCP: Claude and Codex must be registered');
        const needsInstall =
            (present.claude && (!claudeReady || status.claudeMcp !== 'registered')) ||
            (present.codex && ((!codexReady && !hasCodexApprovalIssue(status)) || status.codexMcp !== 'registered'));
        if (needsInstall) {
            addNextStep(nextSteps, terminalHandoff('install'));
        }
        if (present.codex && hasCodexApprovalIssue(status)) {
            addNextStep(nextSteps, 'Open Codex → /hooks → approve the elepha hooks');
        }
    } catch (error) {
        lines.push(`✗ Hooks and MCP: ${errorMessage(error)}`);
    }

    lines.push(databaseLine);

    if (approvedRoots === undefined) {
        lines.push(`✗ Consent: unavailable because the database could not be opened${databaseError ? ` (${databaseError})` : ''}`);
    } else if (approvedRoots === 0) {
        lines.push('✗ Consent: no approved roots; nothing can be captured');
        addNextStep(nextSteps, terminalHandoff('consent grant <path>'));
    } else {
        lines.push(`✓ Consent: ${approvedRoots} approved root${approvedRoots === 1 ? '' : 's'}`);
    }

    let launcherOk = false;
    try {
        const launcher = inspectLauncher();
        launcherOk = launcher.healthy;
        lines.push(`${launcher.healthy ? '✓' : '✗'} Launcher: ${launcher.detail}`);
        if (!launcher.healthy) {
            addNextStep(nextSteps, terminalHandoff('install'));
        }
    } catch (error) {
        lines.push(`✗ Launcher: ${errorMessage(error)}`);
        addNextStep(nextSteps, terminalHandoff('install'));
    }

    lines.push(...repairLines);

    const integrationsOk =
        !!integrations &&
        (!integrations.present.claude ||
            (integrations.status.claudeHook === 'active' &&
                integrations.status.claudeUserPromptSubmitHook === 'active' &&
                integrations.status.claudeMcp === 'registered')) &&
        (!integrations.present.codex ||
            (integrations.status.codexHook === 'active' &&
                integrations.status.codexUserPromptSubmitHook === 'active' &&
                integrations.status.codexMcp === 'registered'));
    const healthy = daemonOk && approvedRoots !== undefined && approvedRoots > 0 && integrationsOk && launcherOk && installRecoveryOk;
    if (nextSteps.length > 0) {
        lines.push('Next steps:');
        lines.push(...nextSteps);
    }
    lines.push(healthy ? 'Summary: all checks passed.' : 'Summary: action required.');
    return { lines, nextSteps, exitCode: healthy ? 0 : 1 };
}

function missingApprovedRoots(): never {
    throw new Error('runDoctor requires an injected approved-root count');
}
