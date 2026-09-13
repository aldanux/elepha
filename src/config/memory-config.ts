// Daemon capture configuration is deliberately narrow: malformed explicit
// config is an error, whereas an absent config keeps the capture defaults.

import { readFileSync } from 'node:fs';
import { DURABLE_CAPTURE_MAX_BYTES } from './constants.js';
import { elephaConfigPath } from './paths.js';

export interface MemoryConfig {
    captureClaudeCode?: boolean;
    captureCodex?: boolean;
    captureOpencode?: boolean;
    durableCapture?: boolean;
    durableCaptureMaxBytes?: number;
}

export const DEFAULT_MEMORY_CONFIG: Readonly<MemoryConfig> = {
    captureClaudeCode: true,
    captureCodex: true,
    captureOpencode: true,
    durableCapture: false,
    durableCaptureMaxBytes: DURABLE_CAPTURE_MAX_BYTES,
};

export function readMemoryConfig(filePath: string = elephaConfigPath()): { config: MemoryConfig } | { error: string } {
    let raw: string;
    try {
        raw = readFileSync(filePath, 'utf8');
    } catch (error) {
        if ((error as NodeJS.ErrnoException).code === 'ENOENT') {
            return { config: { ...DEFAULT_MEMORY_CONFIG } };
        }
        return { error: `cannot read memory config` };
    }
    let parsed: unknown;
    try {
        parsed = JSON.parse(raw);
    } catch {
        return { error: 'memory config is invalid JSON' };
    }
    if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
        return { error: 'memory config must be an object' };
    }
    const output: MemoryConfig = { ...DEFAULT_MEMORY_CONFIG };
    const settings = parsed as Record<string, unknown>;
    if (typeof settings['capture-claude-code'] === 'boolean') {
        output.captureClaudeCode = settings['capture-claude-code'];
    }
    if (typeof settings['capture-codex'] === 'boolean') {
        output.captureCodex = settings['capture-codex'];
    }
    if (typeof settings['capture-opencode'] === 'boolean') {
        output.captureOpencode = settings['capture-opencode'];
    }
    if (typeof settings['durable-capture'] === 'boolean') {
        output.durableCapture = settings['durable-capture'];
    }
    const durableCaptureMaxBytes = settings['durable-capture-max-bytes'];
    if (typeof durableCaptureMaxBytes === 'number' && Number.isSafeInteger(durableCaptureMaxBytes) && durableCaptureMaxBytes > 0) {
        output.durableCaptureMaxBytes = durableCaptureMaxBytes;
    }
    return { config: output };
}
