import { createHash } from 'node:crypto';
import { appendFileSync, mkdirSync, readFileSync, statSync, writeFileSync } from 'node:fs';
import { constants as osConstants } from 'node:os';
import path from 'node:path';
import { HOOK_LOG_LINE_MAX_CHARS, HOOK_LOG_MAX_BYTES, PRIVATE_FILE_MODE } from '../config/constants.js';
import { hookLogPath } from '../config/paths.js';
import { DATABASE_LIFECYCLE_AMBIGUOUS, DATABASE_LIFECYCLE_BUSY } from '../storage/database-lifecycle.js';
import type { HookTool } from './common.js';

export const TASK_STATE_HOOK_STAGE = {
    databasePath: 'database_path',
    databaseOpen: 'database_open',
    memoryRead: 'memory_read',
    authentication: 'authentication',
    eligibility: 'eligibility',
    nativeBinding: 'native_binding',
    consent: 'consent',
    checkout: 'checkout',
    sourceBinding: 'source_binding',
    projectScope: 'project_scope',
    sourceLookup: 'source_lookup',
    sourceIdentity: 'source_identity',
    sourceOpen: 'source_open',
    sourcePosition: 'source_position',
    sourceReplay: 'source_replay',
    nativeKind: 'native_kind',
    classification: 'classification',
    currentState: 'current_state',
    pendingRequest: 'pending_request',
    requestPreparation: 'request_preparation',
    injectionWrite: 'injection_write',
    requestIssue: 'request_issue',
    deadline: 'deadline',
    hook: 'hook',
    watchdog: 'watchdog',
} as const;

export type TaskStateHookStage = (typeof TASK_STATE_HOOK_STAGE)[keyof typeof TASK_STATE_HOOK_STAGE];
export type TaskStateHookDiagnostic = (stage: TaskStateHookStage, error?: unknown) => void;

const HOOK_LOG_ERROR_CAUSE_LIMIT = 2;
const SAFE_ERROR_NAMES = new Set([
    'Error',
    'TypeError',
    'RangeError',
    'SyntaxError',
    'AggregateError',
    'SqliteError',
    'AbortError',
    'TimeoutError',
    'TranscriptReadBudgetError',
    'ResumeContextRequiredError',
    'OversizedTranscriptRecordError',
    'RetiredTurnSearchSchemaError',
    'DatabasePathMutationError',
]);
const SAFE_ERROR_CODES = new Set([
    ...Object.keys(osConstants.errno),
    'SQLITE_ERROR',
    'SQLITE_BUSY',
    'SQLITE_BUSY_SNAPSHOT',
    'SQLITE_LOCKED',
    'SQLITE_READONLY',
    'SQLITE_IOERR',
    'SQLITE_CORRUPT',
    'SQLITE_CANTOPEN',
    'SQLITE_NOTADB',
    'SQLITE_CONSTRAINT',
    'SQLITE_FULL',
    'SQLITE_AUTH',
    'transcript_missing',
    'transcript_unreadable',
    'transcript_outside_store',
]);
const SAFE_ERROR_SYSCALLS = new Set([
    'open',
    'close',
    'read',
    'write',
    'stat',
    'lstat',
    'fstat',
    'realpath',
    'mkdir',
    'rename',
    'unlink',
    'scandir',
]);

function errorMetadata(error: unknown): string {
    const name =
        error instanceof Error
            ? SAFE_ERROR_NAMES.has(error.constructor.name)
                ? error.constructor.name
                : SAFE_ERROR_NAMES.has(error.name)
                  ? error.name
                  : 'unknown'
            : 'unknown';
    const code = error !== null && typeof error === 'object' ? Object.getOwnPropertyDescriptor(error, 'code')?.value : undefined;
    const syscall = error !== null && typeof error === 'object' ? Object.getOwnPropertyDescriptor(error, 'syscall')?.value : undefined;
    const lifecycle =
        error instanceof Error
            ? [DATABASE_LIFECYCLE_BUSY, DATABASE_LIFECYCLE_AMBIGUOUS].find((value) => error.message.startsWith(`${value}:`))
            : undefined;
    return `error=${name}${SAFE_ERROR_CODES.has(code) ? ` code=${code}` : lifecycle ? ` code=${lifecycle}` : ''}${SAFE_ERROR_SYSCALLS.has(syscall) ? ` syscall=${syscall}` : ''}`;
}

export function reportTaskStateHookRejection(
    diagnostic: TaskStateHookDiagnostic | undefined,
    stage: TaskStateHookStage,
    error?: unknown,
): undefined {
    try {
        diagnostic?.(stage, error);
    } catch {
        // Optional diagnostics never become a new failure path.
    }
    return undefined;
}

// Messages and stacks may contain source text or secrets. Only finite metadata
// vocabularies cross this boundary; nested causes are never recursively read.
function errorDetails(error: unknown): string {
    try {
        const cause = error !== null && typeof error === 'object' ? Object.getOwnPropertyDescriptor(error, 'cause')?.value : undefined;
        const causes: unknown[] = error instanceof AggregateError ? error.errors : cause === undefined ? [] : [cause];
        const omitted = Math.max(0, causes.length - HOOK_LOG_ERROR_CAUSE_LIMIT);
        return `${errorMetadata(error)}${causes
            .slice(-HOOK_LOG_ERROR_CAUSE_LIMIT)
            .map((item) => ` cause_${errorMetadata(item)}`)
            .join('')}${omitted > 0 ? ` causes_omitted=${omitted}` : ''}`;
    } catch {
        return 'error=unknown';
    }
}

// At most one bounded rejection per hook invocation. Non-native identifiers
// remain correlatable without allowing arbitrary payload text into the log.
export function taskStateHookDiagnostic(log: (line: string) => void, tool: HookTool, nativeSessionId: string): TaskStateHookDiagnostic {
    const sessionId = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(nativeSessionId)
        ? nativeSessionId
        : `sha256:${createHash('sha256').update(nativeSessionId).digest('hex')}`;
    let reported = false;
    return (stage, error) => {
        if (reported) {
            return;
        }
        reported = true;
        const reason =
            stage === TASK_STATE_HOOK_STAGE.databasePath || stage === TASK_STATE_HOOK_STAGE.databaseOpen
                ? 'database_unavailable'
                : stage === TASK_STATE_HOOK_STAGE.hook || stage === TASK_STATE_HOOK_STAGE.watchdog
                  ? 'hook_error'
                  : 'task_state_unavailable';
        try {
            log(
                `user-prompt-submit ${tool} session_id=${sessionId}: failed reason=${reason} stage=${stage}${error === undefined ? '' : ` ${errorDetails(error)}`}`.slice(
                    0,
                    HOOK_LOG_LINE_MAX_CHARS,
                ),
            );
        } catch {
            // Diagnostic failures cannot change the hook's result.
        }
    };
}

interface HookLogDependencies {
    replaceFile(file: string, content: Buffer): void;
}

const DEFAULT_DEPENDENCIES: HookLogDependencies = {
    replaceFile: (file, content) => writeFileSync(file, content, { mode: PRIVATE_FILE_MODE }),
};

function trimHookLog(file: string, dependencies: HookLogDependencies): void {
    if (statSync(file).size <= HOOK_LOG_MAX_BYTES) {
        return;
    }

    const content = readFileSync(file);
    const start = content.length - HOOK_LOG_MAX_BYTES;
    let retained = content.subarray(start);
    if (content[start - 1] !== 0x0a) {
        const firstCompleteLine = retained.indexOf(0x0a);
        if (firstCompleteLine >= 0 && firstCompleteLine < retained.length - 1) {
            retained = retained.subarray(firstCompleteLine + 1);
        }
    }
    dependencies.replaceFile(file, retained);
}

// Best-effort hook diagnostics must never affect hook delivery.
export function appendHookLog(message: string, dependencyOverrides: Partial<HookLogDependencies> = {}): void {
    try {
        const dependencies = { ...DEFAULT_DEPENDENCIES, ...dependencyOverrides };
        const file = hookLogPath();
        mkdirSync(path.dirname(file), { recursive: true });
        appendFileSync(file, `${new Date().toISOString()} ${message.replace(/[\r\n]+/g, ' ').slice(0, HOOK_LOG_LINE_MAX_CHARS)}\n`, {
            mode: PRIVATE_FILE_MODE,
        });
        trimHookLog(file, dependencies);
    } catch {
        // A memory aid never turns a tool startup into a failed session.
    }
}
