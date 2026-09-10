import { existsSync, statSync } from 'node:fs';
import path from 'node:path';

export interface ToolConfigPaths {
    claudeSettings: string;
    claudeMcp: string;
    codexConfig: string;
    opencodeConfig: string;
    kimiMcp: string;
    opencodeStore?: string;
}

export interface PresentTools {
    claude: boolean;
    codex: boolean;
    opencode: boolean;
    kimi: boolean;
}

function isDirectory(file: string): boolean {
    return statSync(file, { throwIfNoEntry: false })?.isDirectory() ?? false;
}

// Presence is intentionally filesystem-only: registering a config for a tool
// that is not installed creates an orphan entry that status can never mark ready.
export function detectPresentTools(paths: ToolConfigPaths): PresentTools {
    return {
        claude: isDirectory(path.dirname(paths.claudeSettings)) || existsSync(paths.claudeMcp),
        kimi: isDirectory(path.dirname(paths.kimiMcp)),
        codex: isDirectory(path.dirname(paths.codexConfig)),
        opencode:
            isDirectory(path.dirname(paths.opencodeConfig)) || (paths.opencodeStore !== undefined && isDirectory(paths.opencodeStore)),
    };
}
