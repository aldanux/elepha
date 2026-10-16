import type Database from 'better-sqlite3-multiple-ciphers';
import { reportTaskStateHookRejection, TASK_STATE_HOOK_STAGE, type TaskStateHookStage } from '../hooks/hook-log.js';
import { recordHookOutput } from '../hooks/output.js';
import type { MemoryStore } from '../storage/memory-store.js';
import { newTaskStateRequestId, TaskStateRequestStore, taskStateRequestMarker } from '../storage/task-state-request-store.js';
import { TASK_STATE_REQUEST_INSTRUCTIONS } from './instructions.js';
import { authenticateTaskStateChat, type TaskStateChatInput } from './task-state-chat.js';

export async function requestTaskState(
    db: Database.Database,
    store: MemoryStore,
    input: TaskStateChatInput,
    injectedAt: string,
    writeInjection?: Parameters<typeof recordHookOutput>[0]['writeInjection'],
): Promise<string | undefined> {
    const chat = await authenticateTaskStateChat(db, input, store).catch((error: unknown) => {
        reportTaskStateHookRejection(input.onRejected, TASK_STATE_HOOK_STAGE.authentication, error);
        throw error;
    });
    if (!chat) {
        return undefined;
    }
    let stage: TaskStateHookStage = TASK_STATE_HOOK_STAGE.pendingRequest;
    try {
        const requests = new TaskStateRequestStore(db);
        const pendingInput = {
            tool: input.tool,
            nativeSessionId: input.nativeSessionId,
            cwd: input.cwd,
            mode: 'precompact_manifest' as const,
        };
        const pending = requests.currentPendingOutput(pendingInput, TASK_STATE_REQUEST_INSTRUCTIONS);
        if (pending) {
            stage = TASK_STATE_HOOK_STAGE.currentState;
            if (!chat.current()) {
                return reportTaskStateHookRejection(input.onRejected, stage);
            }
            if (!pending.needsRefresh) {
                return pending.output;
            }
            const refreshed = db.transaction(() => {
                stage = TASK_STATE_HOOK_STAGE.currentState;
                if (!chat.current()) {
                    return undefined;
                }
                const current = requests.currentPendingOutput(pendingInput, TASK_STATE_REQUEST_INSTRUCTIONS);
                if (current?.requestId !== pending.requestId) {
                    return undefined;
                }
                if (!current.needsRefresh) {
                    return current.output;
                }
                stage = TASK_STATE_HOOK_STAGE.injectionWrite;
                const output = recordHookOutput({
                    store,
                    tool: input.tool,
                    nativeSessionId: input.nativeSessionId,
                    injectedAt,
                    body: `${taskStateRequestMarker(pendingInput.mode, pending.requestId)}\n${TASK_STATE_REQUEST_INSTRUCTIONS}`,
                    kind: 'brief',
                    attribution: 'exact',
                    writeInjection,
                });
                if (output === undefined) {
                    throw new Error('Task-state request refresh injection failed.');
                }
                const recorded = requests.currentPendingOutput(pendingInput, TASK_STATE_REQUEST_INSTRUCTIONS);
                if (recorded?.requestId !== pending.requestId || recorded.needsRefresh) {
                    throw new Error('Task-state request refresh was not recorded.');
                }
                return recorded.output;
            })();
            return refreshed === undefined ? reportTaskStateHookRejection(input.onRejected, stage) : refreshed;
        }
        const requestId = newTaskStateRequestId();
        stage = TASK_STATE_HOOK_STAGE.requestPreparation;
        const prepared = requests.prepareIssue({
            tool: input.tool,
            nativeSessionId: input.nativeSessionId,
            cwd: input.cwd,
            mode: 'precompact_manifest',
            requestId,
        });
        if (!prepared) {
            return reportTaskStateHookRejection(input.onRejected, stage);
        }
        const result = db.transaction(() => {
            stage = TASK_STATE_HOOK_STAGE.currentState;
            if (!chat.current()) {
                return undefined;
            }
            stage = TASK_STATE_HOOK_STAGE.injectionWrite;
            const output = recordHookOutput({
                store,
                tool: input.tool,
                nativeSessionId: input.nativeSessionId,
                injectedAt,
                body: `${taskStateRequestMarker('precompact_manifest', requestId)}\n${TASK_STATE_REQUEST_INSTRUCTIONS}`,
                kind: 'brief',
                writeInjection: (memory, injection) => {
                    const written = (writeInjection ?? ((target, value) => target.recordInjection(value)))(memory, injection);
                    if (!written) {
                        return false;
                    }
                    stage = TASK_STATE_HOOK_STAGE.currentState;
                    if (!chat.current()) {
                        return false;
                    }
                    stage = TASK_STATE_HOOK_STAGE.requestIssue;
                    return requests.issuePrepared(prepared, injection.injectionId);
                },
            });
            if (output === undefined) {
                throw new Error('Task-state request injection failed.');
            }
            return output;
        })();
        return result === undefined ? reportTaskStateHookRejection(input.onRejected, stage) : result;
    } catch (error) {
        return reportTaskStateHookRejection(input.onRejected, stage, error);
    } finally {
        await chat.close().catch(() => undefined);
    }
}
