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
        const pending = requests.currentPendingOutput({
            tool: input.tool,
            nativeSessionId: input.nativeSessionId,
            cwd: input.cwd,
            mode: 'precompact_manifest',
        });
        if (pending) {
            stage = TASK_STATE_HOOK_STAGE.currentState;
            return chat.current() ? pending.output : reportTaskStateHookRejection(input.onRejected, stage);
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
