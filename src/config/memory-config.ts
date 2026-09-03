// Hook configuration is deliberately narrow: malformed explicit config is an
// error, whereas an absent config keeps the documented fail-open defaults.

import { readFileSync } from 'node:fs';
import { elephaConfigPath } from './paths.js';

export type StartupMode = 'notify' | 'auto' | 'off' | 'ask';

export interface MemoryConfig {
    on_startup: StartupMode;
    on_clear: StartupMode;
    on_resume: StartupMode;
    on_compact: StartupMode;
    captureClaudeCode?: boolean;
    captureCodex?: boolean;
    durableCapture?: boolean;
}

export const DEFAULT_MEMORY_CONFIG: Readonly<MemoryConfig> = {
    on_startup: 'notify',
    on_clear: 'notify',
    on_resume: 'auto',
    on_compact: 'off',
    captureClaudeCode: true,
    captureCodex: true,
    durableCapture: false,
};

const KEYS = ['on_startup', 'on_clear', 'on_resume', 'on_compact'] as const;
const MODES = new Set<StartupMode>(['notify', 'auto', 'off', 'ask']);

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
    if (typeof settings['durable-capture'] === 'boolean') {
        output.durableCapture = settings['durable-capture'];
    }
    const memory = (parsed as { memory?: unknown }).memory;
    if (memory === undefined) {
        return { config: output };
    }
    if (!memory || typeof memory !== 'object' || Array.isArray(memory)) {
        return { error: 'memory config.memory must be an object' };
    }
    for (const key of KEYS) {
        const value = (memory as Record<string, unknown>)[key];
        if (value === undefined) {
            continue;
        }
        if (typeof value !== 'string' || !MODES.has(value as StartupMode)) {
            return { error: `memory config ${key} is unsupported` };
        }
        output[key] = value as StartupMode;
    }
    return { config: output };
}
