import { lstatSync, readFileSync } from 'node:fs';
import {
    HOOK_PAYLOAD_MAX_CHARS,
    OPENCODE_COMPACTION_RECEIPT_CONTRACT,
    OPENCODE_COMPACTION_RECEIPT_HOST_VERSION,
    OPENCODE_COMPACTION_RECEIPT_MAX_CWD_BYTES,
    OPENCODE_COMPACTION_RECEIPT_MAX_TEXT_BYTES,
    OPENCODE_ELEPHA_MCP_PREFIX,
    OPENCODE_PLUGIN_OUTPUT_MAX_BYTES,
    OPENCODE_TASK_STATE_RECEIPT_CONTRACT,
    OPENCODE_TASK_STATE_RECEIPT_PENDING_MAX,
    OPENCODE_TASK_STATE_RECEIPT_PENDING_MAX_AGE_MS,
    OPENCODE_V2_HANDOFF_MAX_ID_BYTES,
    TASK_STATE_REPORT_ACK,
    TASK_STATE_REPORT_INPUT_MAX_BYTES,
    TASK_STATE_REPORT_TOOL,
} from '../config/constants.js';
import { CLOSE, OPEN } from '../security/sentinel.js';
import {
    renderOpencodeCompactionReceiptClient,
    renderOpencodeHookClient,
    renderOpencodeRulesClient,
    renderOpencodeTaskStateReceiptClient,
} from '../security/subprocess-allowlist.js';
import { DISPLAY_VERBATIM_INSTRUCTIONS } from '../serving/instructions.js';
import { OPENCODE_PLUGIN_MARKER } from './markers.js';

// OpenCode loads plugins listed in opencode.json's `plugin` array (the installer
// registers this file there). V1 PluginInput.directory is the working directory.
// Keep this standalone so OpenCode needs no elepha package imports.
//
// Transform only model-facing views: chat.message persists edits into the
// displayed user bubble and would duplicate the assistant's rendered response.
// Title generation may also consume this view; the empty hook input does not
// identify generation kind, so titles can reflect the payload on command sessions.
export function renderOpencodePlugin(launcher: string): string {
    return `${OPENCODE_PLUGIN_MARKER}
${renderOpencodeHookClient(launcher)}
${renderOpencodeRulesClient(launcher)}
${renderOpencodeCompactionReceiptClient(launcher)}
${renderOpencodeTaskStateReceiptClient(launcher)}
const briefOpen = ${JSON.stringify(`${OPEN}brief:`)};
const briefClose = ${JSON.stringify(CLOSE)};
const displayVerbatim = ${JSON.stringify(DISPLAY_VERBATIM_INSTRUCTIONS)};
const maxHookPayloadChars = ${HOOK_PAYLOAD_MAX_CHARS};
const maxHookOutputBytes = ${OPENCODE_PLUGIN_OUTPUT_MAX_BYTES};
const compactionReceiptContract = ${JSON.stringify(OPENCODE_COMPACTION_RECEIPT_CONTRACT)};
const compactionReceiptHostVersion = ${JSON.stringify(OPENCODE_COMPACTION_RECEIPT_HOST_VERSION)};
const maxCompactionTextBytes = ${OPENCODE_COMPACTION_RECEIPT_MAX_TEXT_BYTES};
const maxCompactionCwdBytes = ${OPENCODE_COMPACTION_RECEIPT_MAX_CWD_BYTES};
const taskStateReceiptContract = ${JSON.stringify(OPENCODE_TASK_STATE_RECEIPT_CONTRACT)};
const taskStateToolName = ${JSON.stringify(`${OPENCODE_ELEPHA_MCP_PREFIX}${TASK_STATE_REPORT_TOOL}`)};
const taskStateToolAck = ${JSON.stringify(TASK_STATE_REPORT_ACK)};
const maxTaskStateIdBytes = ${OPENCODE_V2_HANDOFF_MAX_ID_BYTES};
const maxTaskStateInputBytes = ${TASK_STATE_REPORT_INPUT_MAX_BYTES};
const maxTaskStatePending = ${OPENCODE_TASK_STATE_RECEIPT_PENDING_MAX};
const maxTaskStatePendingAgeMs = ${OPENCODE_TASK_STATE_RECEIPT_PENDING_MAX_AGE_MS};

// A subagent runs in its own native session whose parentID names the chat
// that spawned it. Only a host session matching the requested id with no
// parent is a top-level chat; a failed lookup, another id, or any other
// parentID value withholds chat authority while project rules still apply.
function rootSession(session, sessionID) {
    return typeof sessionID === 'string' && !!sessionID && !!session && typeof session === 'object' &&
        !Array.isArray(session) && session.id === sessionID &&
        (session.parentID === undefined || session.parentID === null);
}

function withSessionRoot(payload, root) {
    return root ? { ...payload, session_root: true } : payload;
}

function v1Hooks(directory, client) {
    async function sessionRoot(sessionID) {
        try {
            const result = await client.session.get({ path: { id: sessionID } });
            return rootSession(result?.data, sessionID);
        } catch {
            // Unknown parentage fails closed without logging the session id.
            return false;
        }
    }
    return {
    // OpenCode also uses this transform for auxiliary title/compaction calls.
    // There is no request-kind discriminator, so the same authorized rules apply.
    'experimental.chat.system.transform': async (input, output) => {
        try {
            if (typeof input?.sessionID !== 'string' || !input.sessionID.trim()) return;
            if (!Array.isArray(output?.system) || (output.system.length && typeof output.system[0] !== 'string')) return;
            const root = await sessionRoot(input.sessionID);
            const stdout = await runRulesHook(withSessionRoot({ session_id: input.sessionID, cwd: directory }, root));
            if (!stdout) return;
            const result = JSON.parse(stdout);
            if (!result || typeof result !== 'object' || Array.isArray(result) || Object.keys(result).length !== 1) return;
            const context = result.context;
            if (typeof context !== 'string' || !/^\\[\\[elepha:rules:[0-9A-HJKMNP-TV-Z]{26}]]\\n[\\s\\S]+\\n\\[\\[\\/elepha]]$/.test(context)) return;
            // Preserve the full sentinel and the primary system entry. Extra
            // entries belong to other plugins and must retain their positions.
            if (output.system.length === 0) output.system.push(context);
            else output.system[0] = output.system[0] ? output.system[0] + '\\n\\n' + context : context;
        } catch {
            // Fail open without logging private rules or project identity.
        }
    },
    'experimental.chat.messages.transform': async (_input, output) => {
        try {
            const messages = (output && output.messages) || [];
            let message;
            for (let index = messages.length - 1; index >= 0; index--) {
                if (messages[index].info.role === 'user') {
                    message = messages[index];
                    break;
                }
            }
            if (!message) return;
            const parts = message.parts;
            const textPart = parts.find((part) => part.type === 'text');
            if (!textPart) return;
            const prompt = parts.filter((part) => part.type === 'text').map((part) => part.text).join('\\n');
            if (!prompt.trim().startsWith('elepha:')) return;
            const root = await sessionRoot(message.info.sessionID);
            const stdout = runHook(withSessionRoot({
                hook_event_name: 'UserPromptSubmit',
                session_id: message.info.sessionID,
                cwd: directory,
                prompt,
            }, root));
            if (!stdout.trim()) return;
            const context = JSON.parse(stdout)?.hookSpecificOutput?.additionalContext;
            if (typeof context !== 'string' || !context) return;
            // Keep the full model-facing instructions; recordHookOutput has already
            // recorded this body for the per-session ingestion quote-back check.
            const body = context
                .split('\\n')
                .filter((line) => !line.startsWith(briefOpen) && line.trim() !== briefClose)
                .join('\\n').trim();
            if (!body) return;
            textPart.text = body;
            message.parts = parts.filter((part) => part.type !== 'text' || part === textPart);
        } catch {
            // Fail open without logging private prompt or context data.
        }
    },
    };
}

function rulesContext(stdout) {
    if (!stdout) return;
    const result = JSON.parse(stdout);
    if (!result || typeof result !== 'object' || Array.isArray(result) || Object.keys(result).length !== 1) return;
    const context = result.context;
    if (typeof context !== 'string' || !/^\\[\\[elepha:rules:[0-9A-HJKMNP-TV-Z]{26}]]\\n[\\s\\S]+\\n\\[\\[\\/elepha]]$/.test(context)) return;
    return context;
}

function commandBody(stdout) {
    if (!stdout.trim()) return;
    const context = JSON.parse(stdout)?.hookSpecificOutput?.additionalContext;
    if (typeof context !== 'string' || !context) return;
    const body = context
        .split('\\n')
        .filter((line) => !line.startsWith(briefOpen) && line.trim() !== briefClose)
        .join('\\n').trim();
    return body || undefined;
}

function automaticContext(stdout) {
    if (!stdout || Buffer.byteLength(stdout, 'utf8') > maxHookOutputBytes) return;
    const result = JSON.parse(stdout);
    const context = result?.hookSpecificOutput?.additionalContext;
    if (typeof context !== 'string' || !/^\\[\\[elepha:brief:[0-9A-HJKMNP-TV-Z]{26}]]\\n[\\s\\S]+\\n\\[\\[\\/elepha]]$/.test(context)) return;
    return context;
}

// Empties the request's tool record in place so the host sends the mutated view.
function clearTools(tools) {
    if (tools && typeof tools === 'object') for (const key of Object.keys(tools)) delete tools[key];
}

export default {
    id: 'elepha',
    async server({ directory, client }) {
        return v1Hooks(directory, client);
    },
    async setup(ctx) {
        async function modelRules(event, session) {
            try {
                if (!Array.isArray(event.system)) return;
                const context = rulesContext(await runRulesHook(withSessionRoot({ session_id: event.sessionID, cwd: session.cwd }, session.root)));
                if (!context) return;
                const first = event.system[0];
                if (!first) event.system.push({ type: 'text', text: context });
                else if (first.type === 'text' && typeof first.text === 'string') {
                    event.system[0] = { ...first, text: first.text ? first.text + '\\n\\n' + context : context };
                } else event.system.push({ type: 'text', text: context });
            } catch {
                // Fail open without logging private rules or project identity.
            }
        }

        // One lookup supplies both the project directory and chat parentage.
        async function sessionContext(event) {
            if (typeof event?.sessionID !== 'string' || !event.sessionID.trim()) return;
            try {
                const session = await ctx.session.get({ sessionID: event.sessionID });
                const cwd = session?.location?.directory;
                return typeof cwd === 'string' && cwd ? { cwd, root: rootSession(session, event.sessionID) } : undefined;
            } catch {
                // A removed or unavailable session has no authorized project identity.
            }
        }

        await ctx.session.hook('context', async (event) => {
            const session = await sessionContext(event);
            if (!session) return;
            await modelRules(event, session);
            try {
                if (!Array.isArray(event.messages)) return;
                const index = event.messages.length - 1;
                // The previous user prompt remains in persisted history on tool
                // continuations; only a pending user message may run a command.
                if (index < 0 || event.messages[index]?.role !== 'user') return;
                const message = event.messages[index];
                if (!Array.isArray(message?.content)) return;
                const textParts = message.content.filter((part) => part?.type === 'text' && typeof part.text === 'string');
                if (!textParts.length) return;
                const prompt = textParts.map((part) => part.text).join('\\n');
                if (!prompt.trim().startsWith('elepha:')) {
                    if (!session.root || !prompt.trim() || !Array.isArray(event.system)) return;
                    const payload = withSessionRoot({
                        hook_event_name: 'UserPromptSubmit',
                        session_id: event.sessionID,
                        cwd: session.cwd,
                        prompt,
                    }, true);
                    if (JSON.stringify(payload).length > maxHookPayloadChars) return;
                    const context = automaticContext(runHook(payload));
                    if (!context) return;
                    const first = event.system[0];
                    if (!first) event.system.push({ type: 'text', text: context });
                    else if (first.type === 'text' && typeof first.text === 'string') {
                        event.system[0] = { ...first, text: first.text ? first.text + '\\n\\n' + context : context };
                    } else event.system.push({ type: 'text', text: context });
                    return;
                }
                const body = commandBody(runHook(withSessionRoot({
                    hook_event_name: 'UserPromptSubmit',
                    session_id: event.sessionID,
                    cwd: session.cwd,
                    prompt,
                }, session.root)));
                if (!body) return;
                const firstText = textParts[0];
                const command = {
                    ...message,
                    content: message.content
                        .filter((part) => part?.type !== 'text' || part === firstText)
                        .map((part) => part === firstText ? { ...part, text: body } : part),
                };
                if (body.startsWith(displayVerbatim)) {
                    // A display-only receipt needs neither history nor tools; either
                    // invites unrelated calls such as elepha.recall instead of the
                    // receipt. This edits only the outgoing request, not the chat.
                    clearTools(event.tools);
                    event.messages.splice(0, event.messages.length, command);
                } else event.messages[index] = command;
            } catch {
                // Fail open without logging private prompt or context data.
            }
        });

        for (const kind of ['compaction', 'generate', 'title']) {
            await ctx.session.hook(kind, async (event) => {
                const session = await sessionContext(event);
                if (session) await modelRules(event, session);
            });
        }

        // The v2.0.18 public event stream is volatile. A missing event or a
        // disconnected subscriber means receipt coverage is unavailable.
        if (ctx.app?.version !== compactionReceiptHostVersion) {
            if (ctx.app?.version) console.warn('elepha V2 receipt coverage unavailable for this OpenCode version');
            return;
        }
        if (!ctx.event || typeof ctx.event.subscribe !== 'function') {
            console.warn('elepha V2 receipt stream unavailable');
            return;
        }
        const controller = new AbortController();
        const pendingTaskState = new Map();

        // The event stream may start mid-call. Only a complete, correlated
        // start/call/success trio yields an observation. Missing events stay gaps.
        function boundedReportInput(value) {
            const stack = [value];
            const seen = new Set();
            let budget = maxTaskStateInputBytes;
            while (stack.length) {
                const part = stack.pop();
                if (typeof part === 'string') {
                    if (part.length > budget) return false;
                    budget -= part.length;
                } else if (part && typeof part === 'object') {
                    if (seen.has(part)) return false;
                    seen.add(part);
                    const keys = Object.keys(part);
                    if (keys.length > 32 || seen.size > 256) return false;
                    for (const key of keys) {
                        if (key.length > budget) return false;
                        budget -= key.length;
                        stack.push(part[key]);
                    }
                }
            }
            return true;
        }

        async function taskStateEvent(event) {
            const data = event?.data;
            if (!data || typeof data !== 'object' || Array.isArray(data) ||
                typeof event.id !== 'string' || !/^evt_[A-Za-z0-9_-]+$/.test(event.id) ||
                Buffer.byteLength(event.id, 'utf8') > maxTaskStateIdBytes ||
                [data.sessionID, data.assistantMessageID, data.id].some((id) =>
                    typeof id !== 'string' || !id || Buffer.byteLength(id, 'utf8') > maxTaskStateIdBytes)) return;
            const now = Date.now();
            for (const [key, state] of pendingTaskState) {
                if (now - state.seenAt > maxTaskStatePendingAgeMs) {
                    pendingTaskState.delete(key);
                    if (!state.done && !state.invalid) console.warn('elepha task-state receipt event gap; coverage unavailable');
                }
            }
            const key = JSON.stringify([data.sessionID, data.assistantMessageID, data.id]);
            let state = pendingTaskState.get(key);
            if (!state) {
                if (pendingTaskState.size >= maxTaskStatePending) {
                    const oldest = pendingTaskState.keys().next().value;
                    const evicted = oldest === undefined ? undefined : pendingTaskState.get(oldest);
                    if (oldest !== undefined) pendingTaskState.delete(oldest);
                    if (evicted && !evicted.done && !evicted.invalid)
                        console.warn('elepha task-state receipt event bound; coverage unavailable');
                }
                state = { seenAt: now };
                pendingTaskState.set(key, state);
            }
            if (state.done || state.invalid) return;
            if (event.type === 'session.tool.input.started') {
                if (state.started && state.started !== event.id) state.invalid = true;
                else if (data.name === taskStateToolName) state.started = event.id;
                else state.invalid = true;
            } else if (event.type === 'session.tool.called') {
                if (state.called && state.called !== event.id) state.invalid = true;
                else if (!data.input || typeof data.input !== 'object' || Array.isArray(data.input) ||
                    typeof data.executed !== 'boolean' || !boundedReportInput(data.input)) state.invalid = true;
                else { state.called = event.id; state.report = data.input; }
            } else if (event.type === 'session.tool.success') {
                if (state.success && state.success !== event.id) state.invalid = true;
                else if (typeof data.executed !== 'boolean' || !Array.isArray(data.content) ||
                    data.content.length !== 1 || data.content[0]?.type !== 'text' ||
                    data.content[0]?.text !== taskStateToolAck) state.invalid = true;
                else state.success = event.id;
            }
            if (state.invalid || !state.started || !state.called || !state.success) return;
            state.done = true;
            const session = await sessionContext({ sessionID: data.sessionID });
            if (!session?.root || Buffer.byteLength(session.cwd, 'utf8') > maxCompactionCwdBytes) {
                state.report = undefined;
                console.warn('elepha task-state receipt session unavailable; coverage unavailable');
                return;
            }
            await runTaskStateReceipt({
                contract: taskStateReceiptContract,
                session_id: data.sessionID,
                cwd: session.cwd,
                session_root: true,
                assistant_message_id: data.assistantMessageID,
                call_id: data.id,
                started_event_id: state.started,
                called_event_id: state.called,
                success_event_id: state.success,
                report: state.report,
            });
            state.report = undefined;
        }
        void (async () => {
            try {
                for await (const event of ctx.event.subscribe({ signal: controller.signal })) {
                    if (event?.type === 'session.tool.input.started' || event?.type === 'session.tool.called' ||
                        event?.type === 'session.tool.success') {
                        await taskStateEvent(event);
                        continue;
                    }
                    if (event?.type !== 'session.compaction.ended') continue;
                    const data = event.data;
                    if (!data || typeof data !== 'object' || Array.isArray(data) ||
                        typeof data.sessionID !== 'string' || !data.sessionID.trim() ||
                        typeof data.text !== 'string' || !data.text.trim() ||
                        Buffer.byteLength(data.text, 'utf8') > maxCompactionTextBytes ||
                        (data.reason !== 'auto' && data.reason !== 'manual') ||
                        typeof data.recent !== 'string') continue;
                    const session = await sessionContext({ sessionID: data.sessionID });
                    if (!session?.root || Buffer.byteLength(session.cwd, 'utf8') > maxCompactionCwdBytes) continue;
                    await runCompactionReceipt({
                        contract: compactionReceiptContract,
                        session_id: data.sessionID,
                        cwd: session.cwd,
                        session_root: true,
                        text: data.text,
                        reason: data.reason,
                    });
                }
                if (!controller.signal.aborted) {
                    if ([...pendingTaskState.values()].some((state) => !state.done && !state.invalid))
                        console.warn('elepha task-state receipt event gap; coverage unavailable');
                    console.warn('elepha V2 receipt stream ended; coverage unavailable');
                }
            } catch {
                if (!controller.signal.aborted) console.warn('elepha V2 receipt stream failed; coverage unavailable');
            }
        })();
        return () => controller.abort();
    },
};
`;
}

// Missing and empty user-owned files are distinct. Never follow a plugin symlink.
export function readOpencodePlugin(file: string): string | undefined {
    const stat = lstatSync(file, { throwIfNoEntry: false });
    if (!stat) {
        return undefined;
    }
    return stat.isFile() ? readFileSync(file, 'utf8') : '';
}

export function ownsOpencodePlugin(source: string | undefined): boolean {
    return source?.startsWith(`${OPENCODE_PLUGIN_MARKER}\n`) ?? false;
}

export function transformOpencodePlugin(source: string | undefined, launcher: string): string {
    if (source !== undefined && !ownsOpencodePlugin(source)) {
        throw new Error('OpenCode elepha.js plugin is user-owned; refusing to overwrite it');
    }
    return renderOpencodePlugin(launcher);
}

export function opencodePluginStatus(source: string | undefined, launcher: string) {
    if (source === undefined) {
        return 'not installed';
    }
    if (!ownsOpencodePlugin(source)) {
        return 'conflict';
    }
    if (!source.includes(`\nconst launcher = ${JSON.stringify(launcher)};\n`)) {
        return 'stale binary';
    }
    return source === renderOpencodePlugin(launcher) ? 'installed' : 'stale plugin';
}
