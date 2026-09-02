// Fail-open SessionStart hook. This module never reads an event transcript:
// source_path comes from the consented database row and adapters own parsing.

import { existsSync, realpathSync } from 'node:fs';
import type Database from 'better-sqlite3';
import {
    AUTO_BRIEF_CHAR_BUDGET,
    AUTO_BRIEF_MAX_AGE_MS,
    AUTO_BRIEF_MAX_COMMITS_BEHIND,
    AUTO_BRIEF_NOTIFY_AGE_MS,
    HOOK_WATCHDOG_TIMEOUT_MS,
    PACKAGE_VERSION,
} from '../config/constants.js';
import { readMemoryConfig, type StartupMode } from '../config/memory-config.js';
import { updateAvailablePath } from '../config/paths.js';
import { isNewerVersion, readUpdateAvailable, type UpdateAvailable } from '../daemon/update-check.js';
import { daemonHealth as classifyDaemonHealth } from '../install/health-checks.js';
import { terminalHandoff } from '../markers.js';
import { escapeShellSyntax } from '../security/sanitize.js';
import { buildInjectionId, wrap } from '../security/sentinel.js';
import { gitRevListCountHeadAsync, gitRevParseAbbrevRefHeadAsync } from '../security/subprocess-allowlist.js';
import { servedContextInstructions } from '../serving/instructions.js';
import { endedAt, hasRealContent, newestActivity, SessionReader, surfaceLabel, titleOf } from '../serving/session-reader.js';
import { ConsentStore } from '../storage/consent-store.js';
import { defaultDbPath, openDb } from '../storage/db.js';
import { MemoryStore } from '../storage/memory-store.js';
import { ProjectResolver, type ProjectSet } from '../storage/project-resolver.js';
import { relativeTime } from '../util/relative-time.js';
import { consentedProject, type HookSource, type HookTool, parsePayload, readStdin, type SessionStartPayload } from './common.js';
import { appendHookLog } from './hook-log.js';

export interface SessionStartDependencies {
    dbPath?: string;
    now?: () => number;
    log?: (line: string) => void;
    projectResolver?: (db: Database.Database) => ProjectResolver;
    readConfig?: typeof readMemoryConfig;
    gitBranch?: (cwd: string, signal: AbortSignal) => string | null | PromiseLike<string | null>;
    gitCommitCount?: (cwd: string, signal: AbortSignal) => number | null | PromiseLike<number | null>;
    daemonHealth?: typeof classifyDaemonHealth;
    // Local daemon marker only. The hook never performs the registry check.
    readUpdateAvailable?: (markerPath: string) => UpdateAvailable | undefined;
    writeInjection?: (store: MemoryStore, input: Parameters<MemoryStore['recordInjection']>[0]) => boolean;
}

export type HookResult = { output: Record<string, unknown> } | { reason: string };

const GIT_PROBE_DEADLINE_MS = HOOK_WATCHDOG_TIMEOUT_MS / 2;

function logLine(message: string): void {
    appendHookLog(message);
}

function sessionLogLine(tool: HookTool, payload: SessionStartPayload | undefined, outcome: string): string {
    return `session-start ${tool} source=${payload?.source ?? 'unknown'} session_id=${payload?.session_id ?? 'unknown'}: ${outcome}`;
}

function projectStillConsented(db: Database.Database, projectId: number): boolean {
    return new ProjectResolver(db).listConsentedStored(new ConsentStore(db)).some((project) => project.projectIds.includes(projectId));
}

async function probeGitState(
    cwd: string,
    branchProbe: NonNullable<SessionStartDependencies['gitBranch']>,
    countProbe: NonNullable<SessionStartDependencies['gitCommitCount']>,
): Promise<{ branch: string | null; count: number | null }> {
    const controller = new AbortController();
    let branch: string | null = null;
    let count: number | null = null;
    const probes = Promise.all([
        Promise.resolve()
            .then(() => branchProbe(cwd, controller.signal))
            .then((value) => {
                branch = value;
            })
            .catch(() => undefined),
        Promise.resolve()
            .then(() => countProbe(cwd, controller.signal))
            .then((value) => {
                count = value;
            })
            .catch(() => undefined),
    ]);
    let deadline: ReturnType<typeof setTimeout> | undefined;
    const expired = new Promise<void>((resolve) => {
        deadline = setTimeout(() => {
            controller.abort();
            resolve();
        }, GIT_PROBE_DEADLINE_MS);
    });

    await Promise.race([probes, expired]);
    if (deadline !== undefined) {
        clearTimeout(deadline);
    }
    return { branch, count };
}

export function handleWatchdogTimeout(
    tool: HookTool,
    log: (line: string) => void = logLine,
    exit: (code: number) => void = process.exit,
): void {
    log(sessionLogLine(tool, undefined, `watchdog timeout after ${HOOK_WATCHDOG_TIMEOUT_MS}ms`));
    exit(0);
}

function requestedMode(source: HookSource, config: Record<`on_${HookSource}`, StartupMode>): StartupMode {
    return config[`on_${source}`];
}

function envelope(tool: HookTool, body: string, channel: 'additionalContext' | 'systemMessage'): Record<string, unknown> {
    const hookSpecificOutput =
        channel === 'additionalContext' ? { hookEventName: 'SessionStart', additionalContext: body } : { hookEventName: 'SessionStart' };
    return tool === 'claude-code'
        ? channel === 'systemMessage'
            ? { hookSpecificOutput, systemMessage: body }
            : { hookSpecificOutput }
        : {
              continue: true,
              hookSpecificOutput,
              stopReason: null,
              suppressOutput: false,
              systemMessage: channel === 'systemMessage' ? body : null,
          };
}

function notifyChannel(tool: HookTool): 'additionalContext' | 'systemMessage' {
    // Claude Code renders systemMessage at startup. Codex renders only
    // additionalContext there; its developer-channel record is not ingested.
    return tool === 'claude-code' ? 'systemMessage' : 'additionalContext';
}

function notifyBody(
    consentedProjects: readonly ProjectSet[],
    reader: SessionReader,
    currentProject: ProjectSet,
    currentNativeId: string,
    now: number,
): string {
    const session = newestActivity(reader.recentConsentedSessions(consentedProjects), { excludeNativeId: currentNativeId });
    const total = reader.consentedTotal(consentedProjects);
    const here = reader.consentedTotal([currentProject]);
    const countLabel = here === total ? `${total} sessions` : `${here}/${total} sessions`;
    let last = '';
    if (session !== undefined && Number.isFinite(Date.parse(endedAt(session)))) {
        last = ` · last in ${surfaceLabel(session.tool, session.surface)}, ${relativeTime(endedAt(session), now)}`;
    }
    return `🐘 elepha · ${countLabel} · capture on${last} · type elepha:last to resume`;
}

function autoBody(
    project: ProjectSet,
    session: Parameters<SessionReader['render']>[0],
    raw: string,
    nonce: string,
    reader: SessionReader,
    now: number,
): string {
    const aggregate = reader.aggregate(project);
    const files = aggregate.files.length > 0 ? aggregate.files.join(', ') : 'none';
    const tools = aggregate.surfaces.length > 0 ? aggregate.surfaces.join(', ') : 'none';
    return [
        servedContextInstructions(nonce),
        `# ${titleOf(session)} · ${surfaceLabel(session.tool, session.surface)} · ${relativeTime(endedAt(session), now)} · ${session.git_branch ?? 'unknown branch'}`,
        raw.trimEnd(),
        'durable decisions: not available',
        `Recent files: ${files} · tools: ${tools} · last activity: ${aggregate.lastActivity ?? 'unknown'}`,
    ].join('\n\n');
}

function withDaemonHealthWarning(body: string, now: number, healthCheck: typeof classifyDaemonHealth): string {
    try {
        const health = healthCheck(undefined, now);
        if (health.healthy) {
            return body;
        }
        const warning = health.state.startsWith('STUCK')
            ? `⚠ elepha: capture may be stalled — daemon heartbeat is stale. ${terminalHandoff('doctor')}`
            : `⚠ elepha: capture is paused — daemon not running. ${terminalHandoff('doctor')}`;
        return body ? `${warning}\n${body}` : warning;
    } catch {
        return body;
    }
}

function withUpdateNotice(body: string, readMarker: (markerPath: string) => UpdateAvailable | undefined): string {
    try {
        const update = readMarker(updateAvailablePath());
        if (!update || !isNewerVersion(update.version, PACKAGE_VERSION)) {
            return body;
        }
        const notice = `⬆ elepha ${update.version} available — ${terminalHandoff('self-update')}`;
        return body ? `${notice}\n${body}` : notice;
    } catch {
        return body;
    }
}

// Pure orchestration seam used by tests and the thin CLI adapter.
export async function runSessionStart(rawStdin: string, tool: HookTool, dependencies: SessionStartDependencies = {}): Promise<HookResult> {
    const log = dependencies.log ?? logLine;
    const payload = parsePayload(rawStdin, tool, 'SessionStart');
    if (!payload) {
        return { reason: 'invalid_payload' };
    }
    let configResult: ReturnType<typeof readMemoryConfig>;
    try {
        configResult = (dependencies.readConfig ?? readMemoryConfig)();
    } catch (error) {
        log(sessionLogLine(tool, payload, (error as Error).message));
        return { reason: 'hook_error' };
    }
    if ('error' in configResult) {
        return { reason: configResult.error };
    }
    const mode = requestedMode(payload.source, configResult.config);
    if (mode === 'off') {
        return { reason: 'off' };
    }
    if (mode === 'ask') {
        return { reason: 'ask_unsupported' };
    }
    let db: Database.Database;
    try {
        const dbPath = dependencies.dbPath ?? defaultDbPath();
        if (!existsSync(dbPath)) {
            return { reason: 'database_unavailable' };
        }
        // Hooks must see additive schema migrations before selecting a live
        // session. `openDb` is idempotent and refuses no existing data.
        db = openDb(dbPath);
    } catch {
        return { reason: 'database_unavailable' };
    }
    try {
        const project = consentedProject(db, payload.cwd);
        if (!project) {
            let canonicalCwd: string;
            try {
                canonicalCwd = realpathSync(payload.cwd);
            } catch {
                return { reason: 'project_unavailable_or_unconsented' };
            }
            const consent = new MemoryStore(db).consent;
            const captureOffRoot = consent.captureOffNudge(canonicalCwd);
            if (captureOffRoot) {
                const reader = new SessionReader(db);
                const projectResolver = dependencies.projectResolver ?? ((database: Database.Database) => new ProjectResolver(database));
                const consentedProjects = projectResolver(db).listConsentedStored(consent);
                const total = reader.consentedTotal(consentedProjects);
                const resolution = projectResolver(db).resolve(canonicalCwd);
                const here =
                    'project' in resolution && resolution.project !== null
                        ? reader.sessionsFor(resolution.project).filter(hasRealContent).length
                        : 0;
                const countLabel = here === total ? `${total} sessions` : `${here}/${total} sessions`;
                const grantHint =
                    captureOffRoot !== 'refused' && captureOffRoot.state === 'pending'
                        ? ` · run 'elepha consent grant ${captureOffRoot.path}' to capture here`
                        : '';
                const body = escapeShellSyntax(`🐘 elepha · ${countLabel} · capture off · type elepha:list to recall${grantHint}`);
                log(sessionLogLine(tool, payload, 'emitted capture-off nudge'));
                return { output: envelope(tool, body, notifyChannel(tool)) };
            }
            return { reason: 'project_unavailable_or_unconsented' };
        }
        const reader = new SessionReader(db);
        const projectResolver = dependencies.projectResolver ?? ((database: Database.Database) => new ProjectResolver(database));
        const consentedProjects = projectResolver(db).listConsentedStored(new MemoryStore(db).consent);
        if (reader.consentedTotal(consentedProjects) === 0) {
            return { reason: 'no_consented_sessions' };
        }
        const session = reader.newestSubstantive(project);
        const now = (dependencies.now ?? Date.now)();
        const age = session === undefined ? undefined : now - Date.parse(endedAt(session));
        let effective = mode;
        if (
            session === undefined ||
            age === undefined ||
            !Number.isFinite(age) ||
            age > AUTO_BRIEF_MAX_AGE_MS ||
            (effective === 'auto' && age > AUTO_BRIEF_NOTIFY_AGE_MS)
        ) {
            effective = 'notify';
        }
        if (effective === 'auto' && session !== undefined && session.has_external_content === 1) {
            effective = 'notify';
            log(sessionLogLine(tool, payload, 'auto degraded: session has external content'));
        }
        if (effective === 'auto' && session !== undefined) {
            const cwd = project.gitRoot ?? project.paths[0];
            if (cwd) {
                const { branch, count } = await probeGitState(
                    cwd,
                    dependencies.gitBranch ?? gitRevParseAbbrevRefHeadAsync,
                    dependencies.gitCommitCount ?? gitRevListCountHeadAsync,
                );
                if (branch !== null && session.git_branch !== null && branch !== session.git_branch) {
                    effective = 'notify';
                    // Historical and manually resegmented rows do not have a trustworthy
                    // baseline. Auto must fail closed to the smaller notify injection.
                } else if (session.git_commit_count === null) {
                    effective = 'notify';
                    log(sessionLogLine(tool, payload, 'auto degraded: stored git commit count unavailable'));
                } else if (count !== null && count - session.git_commit_count > AUTO_BRIEF_MAX_COMMITS_BEHIND) {
                    effective = 'notify';
                } else if (count === null) {
                    log(sessionLogLine(tool, payload, 'git commit count unavailable; retaining auto'));
                }
            }
        }
        let body: string;
        if (effective === 'auto' && session !== undefined) {
            const rendered = await reader.render(session, undefined, undefined, AUTO_BRIEF_CHAR_BUDGET);
            if (!projectStillConsented(db, session.project_id)) {
                log(sessionLogLine(tool, payload, 'discarded reason=project_unavailable_or_unconsented'));
                return { reason: 'project_unavailable_or_unconsented' };
            }
            if (!rendered.episode) {
                log(sessionLogLine(tool, payload, `auto degraded: ${rendered.reason}`));
                effective = 'notify';
                body = notifyBody(consentedProjects, reader, project, payload.session_id, now);
            } else {
                body = autoBody(project, session, rendered.episode.text, rendered.episode.nonce, reader, now);
            }
        } else {
            body = notifyBody(consentedProjects, reader, project, payload.session_id, now);
        }
        body = withDaemonHealthWarning(body, now, dependencies.daemonHealth ?? classifyDaemonHealth);
        body = withUpdateNotice(body, dependencies.readUpdateAvailable ?? readUpdateAvailable);
        body = escapeShellSyntax(body);
        const injectionId = buildInjectionId();
        const output = effective === 'auto' ? wrap('brief', injectionId, body) : body;
        const store = new MemoryStore(db);
        const recorded = (dependencies.writeInjection ?? ((s, input) => s.recordInjection(input)))(store, {
            tool,
            nativeSessionId: payload.session_id,
            injectedAt: new Date(now).toISOString(),
            injectionId,
            body,
        });
        if (!recorded) {
            return { reason: 'injection_record_failed' };
        }
        log(sessionLogLine(tool, payload, `emitted ${effective}`));
        return { output: envelope(tool, output, effective === 'auto' ? 'additionalContext' : notifyChannel(tool)) };
    } catch (error) {
        log(sessionLogLine(tool, payload, (error as Error).message));
        return { reason: 'hook_error' };
    } finally {
        db.close();
    }
}

// CLI boundary: no diagnostics or partial JSON may reach stdout.
export async function runSessionStartCli(tool: HookTool): Promise<void> {
    const watchdog = setTimeout(() => {
        handleWatchdogTimeout(tool);
    }, HOOK_WATCHDOG_TIMEOUT_MS);
    try {
        const input = await readStdin();
        const result = await runSessionStart(input, tool);
        if ('output' in result) {
            process.stdout.write(JSON.stringify(result.output));
        } else {
            const payload = parsePayload(input, tool, 'SessionStart');
            logLine(sessionLogLine(tool, payload, result.reason));
        }
    } catch (error) {
        logLine(sessionLogLine(tool, undefined, (error as Error).message));
    } finally {
        clearTimeout(watchdog);
    }
}

export { envelope, parsePayload, relativeTime };
