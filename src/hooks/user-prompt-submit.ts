// Fail-open UserPromptSubmit hook. Historical turns are rendered exclusively
// by SessionReader; this hook never reads a transcript itself.

import { existsSync } from 'node:fs';
import type Database from 'better-sqlite3';
import { ELEPHA_LIST_DEFAULT_LIMIT, ELEPHA_LIST_MAX_LIMIT } from '../config/constants.js';
import { getSetting } from '../config/settings.js';
import { terminalHandoff } from '../markers.js';
import { escapeShellSyntax } from '../security/sanitize.js';
import { buildInjectionId, wrap } from '../security/sentinel.js';
import {
    DISPLAY_VERBATIM_INSTRUCTIONS,
    HELP,
    REMEMBER_HERE_UNCONSENTED,
    REMEMBER_QUERY_REQUIRED,
    SELECT_HINT,
    servedContextInstructions,
} from '../serving/instructions.js';
import { lexicalRecall, tokenizeRecallQuery } from '../serving/lexical-recall.js';
import { endedAt, type ServedSession, SessionReader, surfaceLabel, titleOf } from '../serving/session-reader.js';
import { ConsentStore } from '../storage/consent-store.js';
import { defaultDbPath, openDb } from '../storage/db.js';
import { MemoryStore } from '../storage/memory-store.js';
import { ProjectResolver, type ProjectSet } from '../storage/project-resolver.js';
import type { ToolName } from '../types/index.js';
import { relativeTime } from '../util/relative-time.js';
import { consentedProject, type HookTool, parsePayload, readStdin, type UserPromptSubmitPayload } from './common.js';
import { appendHookLog } from './hook-log.js';

export type UserPromptCommand =
    | { kind: 'help' }
    | { kind: 'last' }
    | { kind: 'list'; count: number; tool?: ToolName }
    | { kind: 'select'; index: number }
    | { kind: 'query'; query: string; scope: 'global' | 'here' }
    | { kind: 'action'; command: 'self-update' };

export interface UserPromptSubmitDependencies {
    dbPath?: string;
    configPath?: string;
    now?: () => number;
    log?: (line: string) => void;
    projectResolver?: (db: Database.Database) => ProjectResolver;
    writeInjection?: (store: MemoryStore, input: Parameters<MemoryStore['recordInjection']>[0]) => boolean;
}

export type UserPromptSubmitResult = { output: Record<string, unknown> } | { reason: string };
type ProjectCommand = Exclude<UserPromptCommand, { kind: 'query' }>;
interface CommandBodyResult {
    body: string;
    shownSessionIds?: number[];
}

interface StoredSelectTarget {
    hasStoredList: boolean;
    session?: ServedSession;
}

const ACTIONS: Record<string, Extract<UserPromptCommand, { kind: 'action' }>> = {
    'elepha:update': { kind: 'action', command: 'self-update' },
};

function logLine(message: string): void {
    appendHookLog(message);
}

function promptLogLine(tool: HookTool, payload: UserPromptSubmitPayload | undefined, outcome: string): string {
    return `user-prompt-submit ${tool} session_id=${payload?.session_id ?? 'unknown'}: ${outcome}`;
}

function contributingSessionsStillConsented(db: Database.Database, reader: SessionReader, sessionIds: readonly number[]): boolean {
    const consentedProjectIds = new Set(
        new ProjectResolver(db).listConsentedStored(new ConsentStore(db)).flatMap((project) => project.projectIds),
    );
    return sessionIds.every((sessionId) => {
        const session = reader.sessionById(sessionId);
        return session !== undefined && consentedProjectIds.has(session.project_id);
    });
}

export function parseUserPromptCommand(prompt: string): UserPromptCommand | undefined {
    const command = prompt.trim();
    if (command === 'elepha:help') {
        return { kind: 'help' };
    }
    if (command === 'elepha:last') {
        return { kind: 'last' };
    }
    const queryHere = /^elepha:query:here(?:\s+([\s\S]*))?$/.exec(command);
    if (queryHere) {
        return { kind: 'query', query: queryHere[1] ?? '', scope: 'here' };
    }
    const queryGlobal = /^elepha:query(?:\s+([\s\S]*))?$/.exec(command);
    if (queryGlobal) {
        return { kind: 'query', query: queryGlobal[1] ?? '', scope: 'global' };
    }
    const select = /^elepha:select:([1-9]\d*)$/.exec(command);
    if (select?.[1]) {
        return { kind: 'select', index: Number(select[1]) };
    }
    const list = /^elepha:list(?::([1-9]\d*))?(?::(codex|claude))?$/.exec(command);
    if (list) {
        const count = list[1] === undefined ? ELEPHA_LIST_DEFAULT_LIMIT : Number(list[1]);
        if (count >= 1 && count <= ELEPHA_LIST_MAX_LIMIT) {
            return { kind: 'list', count, tool: list[2] === 'claude' ? 'claude-code' : (list[2] as ToolName | undefined) };
        }
        return undefined;
    }
    return ACTIONS[command];
}

function envelope(body: string): Record<string, unknown> {
    return { continue: true, hookSpecificOutput: { hookEventName: 'UserPromptSubmit', additionalContext: body } };
}

async function commandBody(
    command: ProjectCommand | undefined,
    reader: SessionReader,
    project: ProjectSet | undefined,
    consentedProjects: readonly ProjectSet[],
    storedSelectTarget: StoredSelectTarget = { hasStoredList: false },
    now: number = Date.now(),
): Promise<CommandBodyResult> {
    if (!command || command.kind === 'help') {
        return { body: `${DISPLAY_VERBATIM_INSTRUCTIONS}\n${HELP}` };
    }
    if (command.kind === 'action') {
        return { body: terminalHandoff('self-update') };
    }
    if (command.kind === 'list') {
        const sessions = reader.recentConsentedSessions(consentedProjects);
        const rows = command.tool === undefined ? sessions : sessions.filter((session) => session.tool === command.tool);
        if (rows.length === 0) {
            return { body: 'No sessions found in consented projects.', shownSessionIds: [] };
        }
        const shown = rows.slice(0, command.count);
        return {
            body: [
                DISPLAY_VERBATIM_INSTRUCTIONS,
                `Recent sessions (${shown.length}):`,
                ...shown.map(
                    (session, index) =>
                        `${index + 1}. [${relativeTime(endedAt(session), now)} | ${surfaceLabel(session.tool, session.surface)}] · ${titleOf(session)}`,
                ),
                '',
                SELECT_HINT,
            ].join('\n'),
            shownSessionIds: shown.map((session) => session.id),
        };
    }
    const session =
        command.kind === 'select' && storedSelectTarget.hasStoredList
            ? storedSelectTarget.session
            : command.kind === 'last'
              ? reader.recentConsentedSessions(consentedProjects)[0]
              : project === undefined
                ? undefined
                : reader.sessionsFor(project)[command.index - 1];
    if (!session) {
        return { body: 'No session found at that position.' };
    }
    const rendered = await reader.render(session);
    if (!rendered.episode) {
        return { body: `Unable to render ${titleOf(session)}: ${rendered.reason ?? 'unknown error'}.`, shownSessionIds: [session.id] };
    }
    return {
        body: `${servedContextInstructions(rendered.episode.nonce)}\n\n# ${titleOf(session)}\n\n${rendered.episode.text.trimEnd()}`,
        shownSessionIds: [session.id],
    };
}

// Pure orchestration seam used by tests and the thin CLI adapter.
export async function runUserPromptSubmit(
    rawStdin: string,
    tool: HookTool,
    dependencies: UserPromptSubmitDependencies = {},
): Promise<UserPromptSubmitResult> {
    const log = dependencies.log ?? logLine;
    const payload = parsePayload(rawStdin, tool, 'UserPromptSubmit');
    if (!payload) {
        log(promptLogLine(tool, payload, 'failed reason=invalid_payload'));
        return { reason: 'invalid_payload' };
    }
    const command = parseUserPromptCommand(payload.prompt);
    if (!command && !payload.prompt.trim().startsWith('elepha:')) {
        return { reason: 'not_command' };
    }
    let db: Database.Database;
    try {
        const dbPath = dependencies.dbPath ?? defaultDbPath();
        if (!existsSync(dbPath)) {
            log(promptLogLine(tool, payload, 'failed reason=database_unavailable'));
            return { reason: 'database_unavailable' };
        }
        db = openDb(dbPath);
    } catch {
        log(promptLogLine(tool, payload, 'failed reason=database_unavailable'));
        return { reason: 'database_unavailable' };
    }
    try {
        const reader = new SessionReader(db);
        const store = new MemoryStore(db);
        const projectResolver = dependencies.projectResolver ?? ((database: Database.Database) => new ProjectResolver(database));
        const clock = dependencies.now ?? Date.now;
        let commandOutput: string;
        let shownSessionIds: number[] | undefined;
        let storeShownSessionIds = false;
        if (command?.kind === 'query') {
            const query = tokenizeRecallQuery(command.query);
            if (!query) {
                commandOutput = `${DISPLAY_VERBATIM_INSTRUCTIONS}\n${REMEMBER_QUERY_REQUIRED}`;
            } else {
                const consent = new ConsentStore(db);
                const projects =
                    command.scope === 'global'
                        ? projectResolver(db).listConsentedStored(consent)
                        : [consentedProject(db, payload.cwd)].filter((project): project is ProjectSet => project !== undefined);
                if (command.scope === 'here' && projects.length === 0 && consent.consentState(payload.cwd) !== 'approved') {
                    log(promptLogLine(tool, payload, 'served notice=project_unavailable_or_unconsented'));
                    commandOutput = `${DISPLAY_VERBATIM_INSTRUCTIONS}\n${REMEMBER_HERE_UNCONSENTED}`;
                } else {
                    const matchingMode = getSetting('query-matching', process.env, dependencies.configPath).value;
                    const recall = await lexicalRecall(reader, projects, query, command.scope, Date.now, clock(), matchingMode);
                    if (!contributingSessionsStillConsented(db, reader, recall.sessionIds)) {
                        log(promptLogLine(tool, payload, 'discarded reason=project_unavailable_or_unconsented'));
                        if (command.scope !== 'here') {
                            return { reason: 'project_unavailable_or_unconsented' };
                        }
                        commandOutput = `${DISPLAY_VERBATIM_INSTRUCTIONS}\n${REMEMBER_HERE_UNCONSENTED}`;
                    } else {
                        commandOutput = recall.body;
                        shownSessionIds = recall.sessionIds;
                        storeShownSessionIds = true;
                    }
                }
            }
        } else {
            const project = consentedProject(db, payload.cwd);
            let storedSelectTarget: StoredSelectTarget = { hasStoredList: false };
            if (command?.kind === 'select') {
                const storedSessionIds = store.shownSessionLists.forChat(tool, payload.session_id);
                if (storedSessionIds !== undefined) {
                    const sessionId = storedSessionIds[command.index - 1];
                    const session = sessionId === undefined ? undefined : reader.sessionById(sessionId);
                    if (session !== undefined) {
                        const consentedProjects = projectResolver(db).listConsentedStored(store.consent);
                        if (!consentedProjects.some((candidate) => candidate.projectIds.includes(session.project_id))) {
                            log(promptLogLine(tool, payload, 'failed reason=project_unavailable_or_unconsented'));
                            return { reason: 'project_unavailable_or_unconsented' };
                        }
                    }
                    storedSelectTarget = { hasStoredList: true, session };
                }
            }
            const consentedProjects = projectResolver(db).listConsentedStored(store.consent);
            const commandNow = command?.kind === 'list' ? clock() : undefined;
            const result = await commandBody(command, reader, project, consentedProjects, storedSelectTarget, commandNow);
            if (result.shownSessionIds !== undefined && !contributingSessionsStillConsented(db, reader, result.shownSessionIds)) {
                log(promptLogLine(tool, payload, 'discarded reason=project_unavailable_or_unconsented'));
                return { reason: 'project_unavailable_or_unconsented' };
            }
            commandOutput = result.body;
            shownSessionIds = result.shownSessionIds;
            storeShownSessionIds = command?.kind === 'list';
        }
        const body = escapeShellSyntax(commandOutput);
        const injectionId = buildInjectionId();
        const output = wrap('brief', injectionId, body);
        const now = clock();
        const recorded = (dependencies.writeInjection ?? ((memoryStore, input) => memoryStore.recordInjection(input)))(store, {
            tool,
            nativeSessionId: payload.session_id,
            injectedAt: new Date(now).toISOString(),
            injectionId,
            body,
        });
        if (!recorded) {
            log(promptLogLine(tool, payload, 'failed reason=injection_record_failed'));
            return { reason: 'injection_record_failed' };
        }
        if (storeShownSessionIds && shownSessionIds !== undefined) {
            store.shownSessionLists.replace(tool, payload.session_id, shownSessionIds);
        }
        log(promptLogLine(tool, payload, command?.kind ?? 'help'));
        return { output: envelope(output) };
    } catch {
        log(promptLogLine(tool, payload, 'failed reason=hook_error'));
        return { reason: 'hook_error' };
    } finally {
        db.close();
    }
}

// CLI boundary: no diagnostics or partial JSON may reach stdout.
export async function runUserPromptSubmitCli(tool: HookTool): Promise<void> {
    try {
        const input = await readStdin();
        const result = await runUserPromptSubmit(input, tool);
        if ('output' in result) {
            process.stdout.write(JSON.stringify(result.output));
        }
    } catch {
        // Hooks are fail-open: stdout must stay empty on every failure path.
    }
}

export { envelope, parsePayload };
