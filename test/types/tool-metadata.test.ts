import { describe, expect, it } from 'vitest';
import { isToolName, SESSION_ADAPTER_TOOLS, SUPPORTED_TOOLS, TOOL_METADATA } from '../../src/types/index.js';

describe('tool metadata', () => {
    it('derives the supported tool ids and display names from one registry', () => {
        expect(SUPPORTED_TOOLS).toEqual(['claude-code', 'codex', 'opencode', 'kimi', 'deepseek']);
        expect(SESSION_ADAPTER_TOOLS).toEqual(['claude-code', 'codex', 'kimi', 'deepseek']);
        expect(SUPPORTED_TOOLS.map((tool) => TOOL_METADATA[tool].displayName)).toEqual([
            'Claude Code',
            'Codex',
            'OpenCode',
            'Kimi Code',
            'DeepSeek Harness',
        ]);
    });

    it('recognizes supported tool ids and rejects an unknown value', () => {
        expect(isToolName('claude-code')).toBe(true);
        expect(isToolName('codex')).toBe(true);
        expect(isToolName('opencode')).toBe(true);
        expect(isToolName('kimi')).toBe(true);
        expect(isToolName('deepseek')).toBe(true);
        expect(isToolName('future-tool')).toBe(false);
    });
});
