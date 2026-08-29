import { existsSync, readFileSync, statSync, unlinkSync } from 'node:fs';
import path from 'node:path';
import { parse } from 'smol-toml';
import { MINIMUM_NODE_MAJOR, PRIVATE_FILE_MODE } from '../config/constants.js';
import { claudeMcpPath, claudeSettingsPath, codexConfigPath, elephaHome } from '../config/paths.js';
import { transformClaudeHook, transformCodexHook } from '../hooks/installer.js';
import { transformClaudeMcp, transformCodexMcp } from '../mcp/installer.js';
import { SUPPORTED_TOOLS, TOOL_METADATA } from '../types/index.js';
import { atomicWrite } from '../util/fs.js';
import { resolveInstalledElephaBin } from './binary.js';
import {
    applyConfigTransaction,
    type ConfigChange,
    deleteInstallSnapshots,
    hasInstallSnapshot,
    rememberInstallSnapshots,
    restoreInstallSnapshot,
} from './config-file.js';
import { detectLauncherBackend, renderLauncher } from './launcher.js';
import { isSupportedPlatform, isWsl, linuxServiceManagerError } from './platform.js';
import { detectPresentTools, type ToolConfigPaths } from './present-tools.js';
import { reconcileCaptureService, type ServiceBackend, type ServiceStatus, serviceBackend } from './service-backend.js';
import { type InstallStatus, installationStatus } from './status.js';

export interface InstallPaths extends ToolConfigPaths {}

export interface InstallationResult {
    bin: string;
    launcher?: string;
    changed: boolean;
    status: InstallStatus;
    service?: 'registered, awaiting consent' | 'active' | 'not installed';
}

export type InstallPhaseReporter = (phase: string, event: 'start' | 'done' | 'fail') => void;

export interface InstallRuntime {
    platform?: NodeJS.Platform;
    home?: string;
    service?: ServiceBackend;
    serviceManager?: { hasSystemd: boolean; isWsl: boolean };
    approvedRoots: number;
    onPhase?: InstallPhaseReporter;
}

function missingApprovedRoots(entryPoint: string): never {
    throw new Error(`${entryPoint} requires an injected approved-root count`);
}

function paths(): InstallPaths {
    return { claudeSettings: claudeSettingsPath(), claudeMcp: claudeMcpPath(), codexConfig: codexConfigPath() };
}

function text(file: string): string {
    return existsSync(file) ? readFileSync(file, 'utf8') : '';
}

interface FileSnapshot {
    file: string;
    exists: boolean;
    text: string;
    mode?: number;
}

interface InstallRollbackJournal {
    version: 1;
    files: FileSnapshot[];
    service: ServiceStatus;
}

function snapshotFiles(files: string[]): FileSnapshot[] {
    return files.map((file) => ({
        file,
        exists: existsSync(file),
        text: existsSync(file) ? readFileSync(file, 'utf8') : '',
        mode: existsSync(file) ? statSync(file).mode & 0o777 : undefined,
    }));
}

function writeSnapshotFile(snapshot: FileSnapshot): void {
    if (!snapshot.exists) {
        if (existsSync(snapshot.file)) {
            unlinkSync(snapshot.file);
        }
        return;
    }
    atomicWrite(snapshot.file, snapshot.text, snapshot.mode ?? PRIVATE_FILE_MODE);
}

function writeRollbackJournal(file: string, journal: InstallRollbackJournal): void {
    const value = `${JSON.stringify(journal)}\n`;
    atomicWrite(file, value, PRIVATE_FILE_MODE);
    if (readFileSync(file, 'utf8') !== value || (statSync(file).mode & 0o777) !== PRIVATE_FILE_MODE) {
        throw new Error(`install rollback journal failed read-back verification: ${file}`);
    }
}

function malformedRollbackJournal(file: string): never {
    throw new Error(`install rollback journal is unreadable or malformed: ${file}; refusing to proceed with a possibly partial install`);
}

export function readRollbackJournal(file: string): InstallRollbackJournal | undefined {
    if (!existsSync(file)) {
        return undefined;
    }
    let parsed: unknown;
    try {
        parsed = JSON.parse(readFileSync(file, 'utf8'));
    } catch {
        return malformedRollbackJournal(file);
    }
    if (!parsed || typeof parsed !== 'object') {
        return malformedRollbackJournal(file);
    }
    const journal = parsed as Partial<InstallRollbackJournal>;
    if (
        journal.version !== 1 ||
        !Array.isArray(journal.files) ||
        !journal.service ||
        typeof journal.service !== 'object' ||
        typeof journal.service.loaded !== 'boolean' ||
        typeof journal.service.disabled !== 'boolean' ||
        (journal.service.unknown !== undefined && typeof journal.service.unknown !== 'boolean')
    ) {
        return malformedRollbackJournal(file);
    }
    for (const snapshot of journal.files) {
        if (
            !snapshot ||
            typeof snapshot !== 'object' ||
            typeof snapshot.file !== 'string' ||
            snapshot.file.length === 0 ||
            typeof snapshot.exists !== 'boolean' ||
            typeof snapshot.text !== 'string' ||
            (snapshot.mode !== undefined && (!Number.isInteger(snapshot.mode) || snapshot.mode < 0 || snapshot.mode > 0o777))
        ) {
            return malformedRollbackJournal(file);
        }
    }
    journal.service.unknown ??= false;
    return journal as InstallRollbackJournal;
}

function removeRollbackJournal(file: string): void {
    if (existsSync(file)) {
        unlinkSync(file);
    }
}

function validateJson(label: string): (value: string) => void {
    return (value) => {
        try {
            JSON.parse(value);
        } catch {
            throw new Error(`${label} is malformed after write`);
        }
    };
}

function validateToml(value: string): void {
    parse(value);
}

function isDefaultPaths(input: InstallPaths): boolean {
    const current = paths();
    return (
        input.claudeSettings === current.claudeSettings &&
        input.claudeMcp === current.claudeMcp &&
        input.codexConfig === current.codexConfig
    );
}

function installSnapshotsDirectory(runtime: InstallRuntime): string {
    return path.join(runtime.home ? path.join(runtime.home, '.elepha') : elephaHome(), 'install-snapshots');
}

function warnServiceRecovery(error: unknown): void {
    console.warn(`elepha install recovery restored files but service reconciliation failed: ${String(error)}`);
}

function compensateInstall(service: ServiceBackend, journal: InstallRollbackJournal): void {
    // File restoration is the recovery contract. Service reconciliation is
    // best-effort because the prior daemon may itself be the broken state that
    // prompted this install.
    for (const snapshot of journal.files) {
        writeSnapshotFile(snapshot);
    }
    if (journal.service.unknown) {
        // Pre-install probe was inconclusive: journal.service.loaded/disabled
        // are not trustworthy, so never enable/start (that would start capture
        // we cannot justify). Drive to the safe stopped+disabled state.
        try {
            service.stop();
            service.disable();
        } catch (error) {
            warnServiceRecovery(error);
            return;
        }
        warnServiceRecovery('prior service state was unknown at install time; left stopped and disabled — verify with `elepha status`');
        return;
    }
    try {
        service.stop();
        if (journal.service.disabled) {
            service.disable();
        } else {
            service.enable();
        }
        if (journal.service.loaded) {
            service.start();
            if (!service.waitForHealthy()) {
                warnServiceRecovery('prior daemon did not produce a healthy heartbeat after journal recovery');
            }
        }
    } catch (error) {
        warnServiceRecovery(error);
    }
}

function replayRollbackJournal(service: ServiceBackend): void {
    const journal = readRollbackJournal(service.transactionPath);
    if (!journal) {
        return;
    }
    try {
        compensateInstall(service, journal);
        removeRollbackJournal(service.transactionPath);
    } catch (error) {
        throw new Error(`unfinished install recovery failed for ${service.transactionPath}: ${String(error)}`, { cause: error });
    }
}

export function installElepha(inputPaths: InstallPaths | undefined, runtime: InstallRuntime): InstallationResult;
export function installElepha(
    inputPaths: InstallPaths = paths(),
    runtime: InstallRuntime = missingApprovedRoots('installElepha'),
): InstallationResult {
    const platform = runtime.platform ?? process.platform;
    if (!isSupportedPlatform(platform)) {
        throw new Error('elepha install is supported on macOS and Linux.');
    }
    if (platform === 'linux') {
        const serviceManager = runtime.serviceManager ?? {
            hasSystemd: existsSync('/run/systemd/system'),
            isWsl: isWsl(),
        };
        const serviceManagerProblem = linuxServiceManagerError(serviceManager);
        if (serviceManagerProblem) {
            throw new Error(serviceManagerProblem);
        }
    }
    const recoveryService = runtime.service ?? serviceBackend({ platform, home: runtime.home });
    replayRollbackJournal(recoveryService);
    const present = detectPresentTools(inputPaths);
    if (!present.claude && !present.codex) {
        const choices = SUPPORTED_TOOLS.map((tool) => TOOL_METADATA[tool].displayName).join(' or ');
        throw new Error(`no supported tool found; install ${choices} first`);
    }
    const resolved = resolveInstalledElephaBin();
    // Existing config-transform unit tests deliberately pass synthetic paths;
    // they retain their filesystem-only scope. Real lifecycle callers always
    // use default paths or inject a service backend and receive the service.
    const manageService = isDefaultPaths(inputPaths) || runtime.service !== undefined;
    const service = manageService ? recoveryService : undefined;
    const backend = service
        ? detectLauncherBackend({
              packageRoot: resolved.packageRoot,
              sourceBin: resolved.bin,
              minimumNodeMajor: MINIMUM_NODE_MAJOR,
              home: runtime.home,
          })
        : undefined;
    const launcher = service?.launcherPath ?? resolved.bin;
    const servicePlan = service && backend ? { service, backend, launcherText: renderLauncher(backend, MINIMUM_NODE_MAJOR) } : undefined;
    // Rendering is part of preflight. Keep this invariant outside the
    // compensating block: no client config, service artifact, or journal has
    // been mutated at this point.
    if (service && !servicePlan) {
        throw new Error('launcher rendering failed before service install');
    }
    const before = {
        claudeSettings: text(inputPaths.claudeSettings),
        claudeMcp: text(inputPaths.claudeMcp),
        codex: text(inputPaths.codexConfig),
    };
    const preparingPhase = 'Preparing hooks & MCP';
    runtime.onPhase?.(preparingPhase, 'start');
    let changes: ConfigChange[];
    try {
        // Transform all documents before a transaction writes a single byte.
        changes = [
            ...(present.claude
                ? [
                      {
                          kind: 'write' as const,
                          file: inputPaths.claudeSettings,
                          text: transformClaudeHook(before.claudeSettings, launcher),
                          validate: validateJson('Claude settings.json'),
                      },
                      {
                          kind: 'write' as const,
                          file: inputPaths.claudeMcp,
                          text: transformClaudeMcp(before.claudeMcp, launcher),
                          validate: validateJson('Claude ~/.claude.json'),
                      },
                  ]
                : []),
            ...(present.codex
                ? [
                      {
                          kind: 'write' as const,
                          file: inputPaths.codexConfig,
                          text: transformCodexMcp(transformCodexHook(before.codex, launcher), launcher),
                          validate: validateToml,
                      },
                  ]
                : []),
        ];
    } catch (error) {
        runtime.onPhase?.(preparingPhase, 'fail');
        throw error;
    }
    runtime.onPhase?.(preparingPhase, 'done');
    // The service shares the client configuration transaction: an active
    // legacy daemon cannot be left booted out after its managed replacement
    // fails health verification. Capture every mutable file and service state
    // before the first config write, then retain the journal until success.
    const journal = service
        ? {
              version: 1 as const,
              files: snapshotFiles([...changes.map((change) => change.file), ...service.artifactPaths]),
              service: service.status(),
          }
        : undefined;
    if (service && journal) {
        writeRollbackJournal(service.transactionPath, journal);
    }
    let changed: boolean;
    let serviceState: InstallationResult['service'];
    let activePhase: string | undefined;
    try {
        activePhase = 'Registering integrations';
        runtime.onPhase?.(activePhase, 'start');
        const transaction = applyConfigTransaction(changes);
        changed = transaction !== false;
        runtime.onPhase?.(activePhase, 'done');
        activePhase = undefined;
        if (servicePlan) {
            activePhase = 'Starting the capture daemon';
            runtime.onPhase?.(activePhase, 'start');
            const approved = runtime.approvedRoots;
            if (!serviceArtifactsMatchOrWrite(servicePlan.service, servicePlan.launcherText)) {
                servicePlan.service.stop();
                if (approved === 0) {
                    servicePlan.service.disable();
                }
                servicePlan.service.install(servicePlan.launcherText, servicePlan.backend);
            }
            const reconciled = reconcileCaptureService(servicePlan.service, approved);
            serviceState =
                reconciled === 'awaiting consent' ? 'registered, awaiting consent' : reconciled === 'active' ? 'active' : 'not installed';
            runtime.onPhase?.(activePhase, 'done');
            activePhase = undefined;
        }
        if (transaction) {
            rememberInstallSnapshots(changes, transaction.originals, installSnapshotsDirectory(runtime));
        }
        if (service) {
            removeRollbackJournal(service.transactionPath);
        }
    } catch (error) {
        if (activePhase) {
            runtime.onPhase?.(activePhase, 'fail');
            activePhase = undefined;
        }
        if (!service || !journal) {
            throw error;
        }
        if (process.env.ELEPHA_SERVICE_KEEP_ON_FAILURE === '1') {
            throw error;
        }
        let compensationError: unknown;
        try {
            compensateInstall(service, journal);
            removeRollbackJournal(service.transactionPath);
        } catch (rollbackError) {
            compensationError = rollbackError;
        }
        if (compensationError) {
            throw new Error(`install failed and rollback failed: ${String(compensationError)}`, { cause: error });
        }
        throw error;
    }
    const after = installationStatus(
        text(inputPaths.claudeSettings),
        text(inputPaths.claudeMcp),
        text(inputPaths.codexConfig),
        inputPaths.codexConfig,
        launcher,
        present,
    );
    return { bin: resolved.bin, launcher: service?.launcherPath, changed, status: after, service: serviceState };
}

export function serviceArtifactsMatchOrWrite(service: ServiceBackend, renderedLauncher: string): boolean {
    return service.installationMatches(renderedLauncher);
}

export function uninstallElepha(inputPaths: InstallPaths | undefined, runtime: InstallRuntime): InstallationResult;
export function uninstallElepha(
    inputPaths: InstallPaths = paths(),
    runtime: InstallRuntime = missingApprovedRoots('uninstallElepha'),
): InstallationResult {
    const platform = runtime.platform ?? process.platform;
    if (!isSupportedPlatform(platform)) {
        throw new Error('elepha uninstall is supported on macOS and Linux.');
    }
    const resolved = resolveInstalledElephaBin();
    const manageService = isDefaultPaths(inputPaths) || runtime.service !== undefined;
    const service = manageService ? (runtime.service ?? serviceBackend({ platform, home: runtime.home })) : undefined;
    if (service) {
        replayRollbackJournal(service);
    }
    const launcher = service?.launcherPath ?? resolved.bin;
    const before = {
        claudeSettings: text(inputPaths.claudeSettings),
        claudeMcp: text(inputPaths.claudeMcp),
        codex: text(inputPaths.codexConfig),
    };
    const snapshots = installSnapshotsDirectory(runtime);
    const uninstallConfigs = [
        {
            file: inputPaths.claudeSettings,
            current: before.claudeSettings,
            validate: validateJson('Claude settings.json'),
            remove: (current: string) => transformClaudeHook(current, launcher, true),
        },
        {
            file: inputPaths.claudeMcp,
            current: before.claudeMcp,
            validate: validateJson('Claude ~/.claude.json'),
            remove: (current: string) => transformClaudeMcp(current, launcher, true),
        },
        {
            file: inputPaths.codexConfig,
            current: before.codex,
            validate: validateToml,
            remove: (current: string) =>
                transformCodexMcp(transformCodexHook(current, launcher, true, inputPaths.codexConfig), launcher, true),
        },
    ];
    const changes = uninstallConfigs.flatMap<ConfigChange>(({ file, current, validate, remove }) => {
        if (!existsSync(file) && !hasInstallSnapshot(file, snapshots)) {
            return [];
        }
        const restore = restoreInstallSnapshot(file, current, snapshots);
        if (restore?.kind === 'delete') {
            return [{ kind: 'delete' as const, file }];
        }
        const restored = restore?.kind === 'text' ? restore.text : current;
        return [{ kind: 'write' as const, file, text: remove(restored), validate }];
    });
    if (service) {
        writeRollbackJournal(service.transactionPath, {
            version: 1,
            files: snapshotFiles([...changes.map((change) => change.file), ...service.artifactPaths]),
            service: service.status(),
        });
    }
    const transaction = applyConfigTransaction(changes);
    const changed = transaction !== false;
    if (service) {
        service.stop();
        service.disable();
        service.uninstall();
    }
    deleteInstallSnapshots(
        changes.map((change) => change.file),
        snapshots,
    );
    if (service) {
        removeRollbackJournal(service.transactionPath);
    }
    const after = installationStatus(
        text(inputPaths.claudeSettings),
        text(inputPaths.claudeMcp),
        text(inputPaths.codexConfig),
        inputPaths.codexConfig,
        launcher,
        detectPresentTools(inputPaths),
    );
    return { bin: resolved.bin, launcher: service?.launcherPath, changed, status: after, service: service ? 'not installed' : undefined };
}
