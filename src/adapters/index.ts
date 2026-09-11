import type { SessionAdapter, SessionAdapterMap, ToolName } from '../types/index.js';
import { ClaudeCodeAdapter } from './claude-code.js';
import { CodexAdapter } from './codex.js';
import { DeepSeekHarnessAdapter } from './deepseek-harness.js';
import { KimiCodeAdapter } from './kimi-code.js';

export function defaultAdapters(): SessionAdapterMap {
    return {
        'claude-code': new ClaudeCodeAdapter(),
        codex: new CodexAdapter(),
        kimi: new KimiCodeAdapter(),
        deepseek: new DeepSeekHarnessAdapter(),
    };
}

export function sessionAdapterFor(adapters: SessionAdapterMap, tool: ToolName): SessionAdapter | undefined {
    if (tool === 'claude-code' || tool === 'codex' || tool === 'kimi' || tool === 'deepseek') {
        return adapters[tool];
    }
    if (tool === 'opencode') {
        return undefined;
    }
    throw new Error(`Unsupported JSONL session adapter: ${String(tool)}`);
}
