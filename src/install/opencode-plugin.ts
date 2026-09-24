import { lstatSync, readFileSync } from 'node:fs';
import { CLOSE, OPEN } from '../security/sentinel.js';
import { renderOpencodeHookClient, renderOpencodeRulesClient } from '../security/subprocess-allowlist.js';
import { OPENCODE_PLUGIN_MARKER } from './markers.js';

// OpenCode loads plugins listed in opencode.json's `plugin` array (the installer
// registers this file there). PluginInput.directory is the working directory.
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
const briefOpen = ${JSON.stringify(`${OPEN}brief:`)};
const briefClose = ${JSON.stringify(CLOSE)};
export const ElephaPlugin = async ({ directory }) => ({
    // OpenCode also uses this transform for auxiliary title/compaction calls.
    // There is no request-kind discriminator, so the same authorized rules apply.
    'experimental.chat.system.transform': async (input, output) => {
        try {
            if (typeof input?.sessionID !== 'string' || !input.sessionID.trim()) return;
            if (!Array.isArray(output?.system) || (output.system.length && typeof output.system[0] !== 'string')) return;
            const stdout = await runRulesHook({ session_id: input.sessionID, cwd: directory });
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
            const stdout = runHook({
                hook_event_name: 'UserPromptSubmit',
                session_id: message.info.sessionID,
                cwd: directory,
                prompt,
            });
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
});
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
