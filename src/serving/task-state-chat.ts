import { statSync } from 'node:fs';
import type Database from 'better-sqlite3-multiple-ciphers';
import { CodexAdapter, readCodexKindPreamble } from '../adapters/codex.js';
import { defaultAdapters } from '../adapters/index.js';
import { CODEX_TASK_SOURCE_LOOKUP_CODE } from '../config/codex.js';
import {
    CURRENT_CHAT_EVIDENCE_MAX_ID_BYTES,
    CURRENT_CHAT_EVIDENCE_MAX_PATH_BYTES,
    SESSION_EVIDENCE_SOURCE_MAX_BYTES,
    SESSION_KIND_PREAMBLE_MAX_BYTES,
} from '../config/constants.js';
import { canonicalizeExisting, samePath } from '../config/paths.js';
import { getSetting } from '../config/settings.js';
import {
    reportTaskStateHookRejection,
    TASK_STATE_HOOK_STAGE,
    type TaskStateHookDiagnostic,
    type TaskStateHookStage,
} from '../hooks/hook-log.js';
import { openProviderTranscript, validateOpenedProviderTranscriptIdentitySync } from '../security/provider-transcript.js';
import { ConsentStore } from '../storage/consent-store.js';
import type { MemoryStore } from '../storage/memory-store.js';
import { withMemoryReadGeneration } from '../storage/paranoid-gate.js';
import {
    type NativeTaskBinding,
    readNativeTaskChat,
    readTaskSourcePosition,
    readUncapturedNativeTaskChat,
} from '../storage/session-read-model.js';
import { sourceGeneration } from '../storage/source-reconciliation.js';
import { decodeResumeContext } from '../storage/source-resume-context.js';
import { sourceTurnDigests } from '../storage/source-turn-digest.js';
import { prepareTaskStateProjectScope, taskStateProjectScopeCurrent } from '../storage/task-state-project-scope.js';
import type { SessionAdapterTool } from '../types/index.js';

export interface TaskStateChatInput {
    tool: SessionAdapterTool;
    nativeSessionId: string;
    cwd: string;
    transcriptPath?: string | null;
    configPath?: string;
    signal: AbortSignal;
    onRejected?: TaskStateHookDiagnostic;
}

export async function authenticateTaskStateChat(db: Database.Database, input: TaskStateChatInput, initialStore?: MemoryStore) {
    const reject = (stage: TaskStateHookStage, error?: unknown) => reportTaskStateHookRejection(input.onRejected, stage, error);
    if (
        input.signal.aborted ||
        !input.nativeSessionId ||
        Buffer.byteLength(input.nativeSessionId) > CURRENT_CHAT_EVIDENCE_MAX_ID_BYTES ||
        Buffer.byteLength(input.cwd) > CURRENT_CHAT_EVIDENCE_MAX_PATH_BYTES ||
        (input.transcriptPath != null && Buffer.byteLength(input.transcriptPath) > CURRENT_CHAT_EVIDENCE_MAX_PATH_BYTES) ||
        (input.tool === 'claude-code' && !input.transcriptPath) ||
        !getSetting(`capture-${input.tool}`, {}, input.configPath).value
    ) {
        return reject(input.signal.aborted ? TASK_STATE_HOOK_STAGE.deadline : TASK_STATE_HOOK_STAGE.eligibility);
    }
    const generation = withMemoryReadGeneration(
        db,
        () => undefined,
        (token) => token,
    );
    if (generation === undefined) {
        return reject(TASK_STATE_HOOK_STAGE.memoryRead);
    }
    const consent = new ConsentStore(db);
    const retained = readNativeTaskChat(db, input.tool, input.nativeSessionId);
    const initialGeneration = initialStore && sourceGeneration(initialStore, input.tool, input.nativeSessionId);
    let binding: NativeTaskBinding | undefined =
        retained ?? (initialStore && readUncapturedNativeTaskChat(db, input.tool, input.nativeSessionId));
    if (!binding && (!initialStore || initialStore.findSession(input.tool, input.nativeSessionId))) {
        return reject(TASK_STATE_HOOK_STAGE.nativeBinding);
    }
    if (consent.consentState(input.cwd) !== 'approved' || consent.isRefusedForCapture(input.cwd)) {
        return reject(TASK_STATE_HOOK_STAGE.consent);
    }
    let checkout: string;
    let checkoutStat: ReturnType<typeof statSync>;
    try {
        checkout = canonicalizeExisting(input.cwd);
        checkoutStat = statSync(checkout);
        if (!checkoutStat.isDirectory()) {
            return reject(TASK_STATE_HOOK_STAGE.checkout);
        }
        if (
            binding &&
            input.transcriptPath != null &&
            canonicalizeExisting(input.transcriptPath) !== canonicalizeExisting(binding.sourcePath)
        ) {
            return reject(TASK_STATE_HOOK_STAGE.sourceBinding);
        }
    } catch (error) {
        return reject(TASK_STATE_HOOK_STAGE.checkout, error);
    }
    const decision = consent.approvedDecisionForCanonicalPath(checkout);
    let project = binding && prepareTaskStateProjectScope(db, binding.projectId, binding.projectPath, checkout);
    if (!decision || (binding && !project)) {
        return reject(TASK_STATE_HOOK_STAGE.projectScope);
    }
    const adapter = defaultAdapters()[input.tool];
    let located: { sourcePath: string; current: () => boolean } | undefined;
    if (!binding && !input.transcriptPath && adapter instanceof CodexAdapter) {
        const lookup = await adapter.resolveTaskStateSource(input.nativeSessionId, input.signal);
        if ('code' in lookup) {
            return reject(input.signal.aborted ? TASK_STATE_HOOK_STAGE.deadline : TASK_STATE_HOOK_STAGE.sourceLookup, lookup);
        }
        located = lookup;
    }
    const sourcePath = binding?.sourcePath ?? located?.sourcePath ?? canonicalizeExisting(input.transcriptPath ?? '');
    const readPath = input.transcriptPath ?? sourcePath;
    if (!adapter.matches(sourcePath) || adapter.nativeSessionId(sourcePath) !== input.nativeSessionId) {
        return reject(TASK_STATE_HOOK_STAGE.sourceIdentity);
    }
    if (!adapter.matches(readPath) || adapter.nativeSessionId(readPath) !== input.nativeSessionId) {
        return reject(TASK_STATE_HOOK_STAGE.sourceIdentity);
    }
    const opened = await openProviderTranscript(input.tool, readPath);
    if ('reason' in opened) {
        return reject(TASK_STATE_HOOK_STAGE.sourceOpen, { code: opened.reason });
    }
    let stage: TaskStateHookStage = TASK_STATE_HOOK_STAGE.sourcePosition;
    try {
        const readBudget = { remaining: SESSION_EVIDENCE_SOURCE_MAX_BYTES };
        const position = retained && readTaskSourcePosition(db, input.tool, input.nativeSessionId, retained.memoryId);
        const end = position === undefined ? undefined : adapter.cursorPosition?.(position.cursor).byteOffset;
        if (retained && (!position || end === undefined || (position.turnIndex > 0 && !position.beforeCursor))) {
            await opened.handle.close();
            return reject(stage);
        }
        // A new Codex hook can precede its prompt record. This authenticates
        // the chat for a request only; publication still requires a real turn.
        let authenticated = !retained && input.tool === 'codex';
        let invalid = false;
        stage = TASK_STATE_HOOK_STAGE.sourceReplay;
        const scopeMatches = (turn: { tool: string; sessionId: string; projectPath: string }): boolean =>
            turn.tool === input.tool &&
            turn.sessionId === input.nativeSessionId &&
            samePath(canonicalizeExisting(turn.projectPath), checkout);
        // Retained evidence still requires its exact indexed digest. A first
        // request authenticates an actually pending native turn instead; it
        // does not close or retain that turn to manufacture stored history.
        for await (const turn of adapter.parseTurns(sourcePath, position?.beforeCursor ?? undefined, {
            handle: opened.handle,
            readBudget,
            signal: input.signal,
            endByteOffset: end,
            includeClosingBoundary: retained !== undefined,
            resumeContext: decodeResumeContext(position?.beforeContext ?? null),
            closeTrailingOnIdle: retained !== undefined,
            skipSessionTitle: true,
            onPendingTurn: retained
                ? undefined
                : (turn) => {
                      authenticated = scopeMatches(turn);
                  },
            onDesync: () => {
                invalid = true;
            },
            onMalformedRecords: () => {
                invalid = true;
            },
            onUnrecognizedRecords: () => {
                invalid = true;
            },
        })) {
            if (!retained) {
                invalid ||= !scopeMatches(turn);
            } else if (position && turn.turnIndex === position.turnIndex) {
                authenticated =
                    scopeMatches(turn) &&
                    adapter.cursorPosition?.(turn.cursor).byteOffset === end &&
                    sourceTurnDigests(turn).includes(retained.sourceDigest);
            }
        }
        if (!authenticated || invalid) {
            await opened.handle.close();
            return reject(input.signal.aborted ? TASK_STATE_HOOK_STAGE.deadline : stage);
        }
        if (input.tool === 'codex') {
            if (
                !retained &&
                adapter instanceof CodexAdapter &&
                !(await adapter.readInitialTaskContext(sourcePath, {
                    handle: opened.handle,
                    readBudget,
                    signal: input.signal,
                    authorizeCwd: (cwd) => samePath(canonicalizeExisting(cwd), checkout),
                }))
            ) {
                await opened.handle.close();
                return reject(TASK_STATE_HOOK_STAGE.sourceReplay);
            }
            stage = TASK_STATE_HOOK_STAGE.nativeKind;
            const header = await readCodexKindPreamble(
                sourcePath,
                opened.handle,
                (cwd, nativeId) =>
                    nativeId === input.nativeSessionId &&
                    consent.consentState(cwd) === 'approved' &&
                    !consent.isRefusedForCapture(cwd) &&
                    samePath(canonicalizeExisting(cwd), checkout),
            );
            if (header.malformed || header.guardian || !header.root) {
                await opened.handle.close();
                return reject(stage);
            }
        }
        stage = TASK_STATE_HOOK_STAGE.classification;
        const classification = await adapter.classifySession(sourcePath, {
            handle: opened.handle,
            maxReadBytes: SESSION_KIND_PREAMBLE_MAX_BYTES,
            signal: input.signal,
        });
        if (classification.kind !== 'primary' || classification.exclusion !== undefined) {
            await opened.handle.close();
            return reject(stage);
        }
        stage = TASK_STATE_HOOK_STAGE.currentState;
        const sourceCurrent = (): boolean =>
            withMemoryReadGeneration(
                db,
                () => false,
                () => {
                    if (input.signal.aborted || !getSetting(`capture-${input.tool}`, {}, input.configPath).value) {
                        return false;
                    }
                    if (located && !located.current()) {
                        reject(TASK_STATE_HOOK_STAGE.sourceLookup, { code: CODEX_TASK_SOURCE_LOOKUP_CODE.changed });
                        return false;
                    }
                    const currentDecision = consent.approvedDecisionForCanonicalPath(checkout);
                    try {
                        const physical = statSync(checkout);
                        const source = statSync(sourcePath);
                        return (
                            consent.consentState(input.cwd) === 'approved' &&
                            !consent.isRefusedForCapture(input.cwd) &&
                            currentDecision?.ulid === decision.ulid &&
                            currentDecision?.decided_at === decision.decided_at &&
                            samePath(canonicalizeExisting(input.cwd), checkout) &&
                            physical.dev === checkoutStat.dev &&
                            physical.ino === checkoutStat.ino &&
                            source.size === opened.stat.size &&
                            source.mtimeMs === opened.stat.mtimeMs &&
                            source.ctimeMs === opened.stat.ctimeMs &&
                            !('reason' in validateOpenedProviderTranscriptIdentitySync(input.tool, readPath, opened)) &&
                            !('reason' in validateOpenedProviderTranscriptIdentitySync(input.tool, sourcePath, opened))
                        );
                    } catch {
                        return false;
                    }
                },
                generation,
            );
        if (!binding && initialStore) {
            stage = TASK_STATE_HOOK_STAGE.nativeBinding;
            const registered = await initialStore.registerNativeTaskChat(
                { tool: input.tool, nativeId: input.nativeSessionId, cwd: checkout, sourcePath },
                () => sourceCurrent() && sourceGeneration(initialStore, input.tool, input.nativeSessionId) === initialGeneration,
                input.signal,
            );
            if (!registered) {
                await opened.handle.close();
                return reject(stage);
            }
            binding = readUncapturedNativeTaskChat(db, input.tool, input.nativeSessionId);
            project = binding && prepareTaskStateProjectScope(db, binding.projectId, binding.projectPath, checkout);
        }
        const current = (): boolean => {
            const fresh = retained
                ? readNativeTaskChat(db, input.tool, input.nativeSessionId)
                : readUncapturedNativeTaskChat(db, input.tool, input.nativeSessionId);
            return (
                sourceCurrent() &&
                binding !== undefined &&
                project !== undefined &&
                JSON.stringify(fresh) === JSON.stringify(binding) &&
                taskStateProjectScopeCurrent(db, project) &&
                samePath(canonicalizeExisting(binding.projectPath), project.canonicalPaths.get(binding.projectPath) ?? '')
            );
        };
        if (!binding || !current()) {
            await opened.handle.close();
            return reject(TASK_STATE_HOOK_STAGE.currentState);
        }
        return { binding, adapter, opened, readBudget, current, close: () => opened.handle.close() };
    } catch (error) {
        await opened.handle.close().catch(() => undefined);
        return reject(input.signal.aborted ? TASK_STATE_HOOK_STAGE.deadline : stage, error);
    }
}
