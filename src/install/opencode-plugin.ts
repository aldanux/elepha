import { lstatSync, readFileSync } from 'node:fs';
import { OPENCODE_PLUGIN_MAX_PENDING_SESSIONS } from '../config/constants.js';
import { renderOpencodeHookClient } from '../security/subprocess-allowlist.js';
import { OPENCODE_PLUGIN_DROPPED_CONTEXT, OPENCODE_PLUGIN_MARKER } from './markers.js';

// OpenCode 1.18.29 loads plugins/*.js; PluginInput.directory is the working
// directory. Keep this standalone so OpenCode needs no elepha package imports.
export function renderOpencodePlugin(launcher: string): string {
    return `${OPENCODE_PLUGIN_MARKER}
${renderOpencodeHookClient(launcher)}
const pending = new Map();
export const ElephaPlugin = async ({ directory }) => ({
    'chat.message': async (input, output) => {
        try {
            // A subsequent message must never receive an abandoned command's context.
            pending.delete(input.sessionID);
            const prompt = output.parts.filter((part) => part.type === 'text').map((part) => part.text).join('\\n');
            if (!prompt.trim().startsWith('elepha:')) return;
            const stdout = runHook({
                hook_event_name: 'UserPromptSubmit',
                session_id: input.sessionID,
                cwd: directory,
                prompt,
            });
            if (!stdout.trim()) return;
            const context = JSON.parse(stdout)?.hookSpecificOutput?.additionalContext;
            if (typeof context !== 'string' || !context) return;
            // Cancelled turns may never reach system.transform. Bound their retention.
            let dropped = false;
            if (pending.size >= ${OPENCODE_PLUGIN_MAX_PENDING_SESSIONS}) {
                pending.delete(pending.keys().next().value);
                dropped = true;
            }
            pending.set(input.sessionID, dropped ? ${JSON.stringify(OPENCODE_PLUGIN_DROPPED_CONTEXT)} + '\\n' + context : context);
        } catch {
            // Fail open without logging private prompt or context data.
        }
    },
    'experimental.chat.system.transform': async (input, output) => {
        const context = pending.get(input.sessionID);
        if (context === undefined) return;
        pending.delete(input.sessionID);
        output.system.push(context);
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
