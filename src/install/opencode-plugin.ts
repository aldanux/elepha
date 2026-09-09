import { lstatSync, readFileSync } from 'node:fs';
import { renderOpencodeHookClient } from '../security/subprocess-allowlist.js';
import { OPENCODE_PLUGIN_MARKER } from './markers.js';

// OpenCode loads plugins listed in opencode.json's `plugin` array (the installer
// registers this file there). PluginInput.directory is the working directory.
// Keep this standalone so OpenCode needs no elepha package imports.
//
// The plugin runs elepha's hook and rewrites the user's message with the result.
// Rewriting the user text part is the only channel OpenCode's model reliably
// renders: system-prompt injection (experimental.chat.system.transform) is
// ignored by smaller models, which is why the earlier version did nothing.
// Verified against opencode 1.18.x with the default model.
export function renderOpencodePlugin(launcher: string): string {
    return `${OPENCODE_PLUGIN_MARKER}
${renderOpencodeHookClient(launcher)}
export const ElephaPlugin = async ({ directory }) => ({
    'chat.message': async (input, output) => {
        try {
            const parts = (output && output.parts) || [];
            const textPart = parts.find((part) => part.type === 'text');
            if (!textPart) return;
            const prompt = parts.filter((part) => part.type === 'text').map((part) => part.text).join('\\n');
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
            // Strip elepha's brief sentinel wrapper (open/close lines) so a weak
            // model does not treat the whole block as inert background context; the
            // inner per-command instructions (verbatim display for list/info, recap
            // for resume) drive the reply. Rule 4 still holds: elepha recorded this
            // injection and its ingestion quote-back drops the echoed content per
            // session, so the rewritten turn does not re-enter memory.
            const body = context
                .split('\\n')
                .filter((line) => !line.startsWith('[[elepha:brief:') && line.trim() !== '[[/elepha]]')
                .join('\\n')
                .trim();
            if (body) textPart.text = body;
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
