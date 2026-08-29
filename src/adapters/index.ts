import type { SessionAdapter, ToolName } from '../types/index.js';
import { ClaudeCodeAdapter } from './claude-code.js';
import { CodexAdapter } from './codex.js';

export function defaultAdapters(): Record<ToolName, SessionAdapter> {
    return { 'claude-code': new ClaudeCodeAdapter(), codex: new CodexAdapter() };
}
