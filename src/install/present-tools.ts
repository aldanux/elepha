import { existsSync, statSync } from 'node:fs';
import path from 'node:path';

export interface ToolConfigPaths {
    claudeSettings: string;
    claudeMcp: string;
    codexConfig: string;
}

export interface PresentTools {
    claude: boolean;
    codex: boolean;
}

function isDirectory(file: string): boolean {
    return statSync(file, { throwIfNoEntry: false })?.isDirectory() ?? false;
}

/**
 * Presence is intentionally filesystem-only: registering a config for a tool
 * that is not installed creates an orphan entry that status can never mark ready.
 */
export function detectPresentTools(paths: ToolConfigPaths): PresentTools {
    return {
        claude: isDirectory(path.dirname(paths.claudeSettings)) || existsSync(paths.claudeMcp),
        codex: isDirectory(path.dirname(paths.codexConfig)),
    };
}
