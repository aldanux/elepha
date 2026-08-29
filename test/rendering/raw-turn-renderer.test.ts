import { describe, expect, it } from 'vitest';
import { RAW_TURN_SEPARATOR, renderedChars, renderRawTurn, renderRawTurns } from '../../src/rendering/raw-turn-renderer.js';
import { detectShellSyntax } from '../../src/security/sanitize.js';
import type { ParsedTurn } from '../../src/types/index.js';

function turn(overrides: Partial<ParsedTurn> = {}): ParsedTurn {
    return {
        tool: 'codex',
        sessionId: 'native',
        sourcePath: '/tmp/native.jsonl',
        projectPath: '/tmp/project',
        turnIndex: 7,
        startedAt: '2026-08-16T00:00:00.000Z',
        endedAt: '2026-08-16T00:01:00.000Z',
        userMessage: 'inspect `src/a.ts`',
        assistantText: 'I will use $(pwd) and keep `code` intact.',
        toolCalls: [
            { name: 'exec', filePaths: ['/repo/src/a.ts'] },
            { name: 'read_file', filePaths: [] },
            { name: 'apply_patch', filePaths: [] },
        ],
        cursor: '0|1',
        hasExternalContent: false,
        resumeMarkerBefore: false,
        ...overrides,
    };
}

describe('raw-turn renderer', () => {
    it('uses the golden Markdown shape, strips memory citations, preserves file-bearing calls, collapses the rest, and escapes served text', () => {
        const rendered = renderRawTurn(
            turn({
                userMessage: 'before\n<oai-mem-citation>ignore `this`</oai-mem-citation>\nafter',
                assistantText: 'keep `code` and $(date)',
            }),
        );

        expect(rendered).toBe(
            '## Turn 7\n\n' +
                '**User prompt**\n\n' +
                'before\n\nafter\n\n' +
                '**Assistant response**\n\n' +
                'keep \\`code\\` and $\\(date)\n\n' +
                '**Tool calls**\n\n' +
                '- `exec`\n' +
                '  - `/repo/src/a.ts`\n' +
                '- 2 tool calls without file paths omitted',
        );
    });

    it('drops an explicit do-nothing acknowledgement with no tool calls regardless of its length', () => {
        expect(
            renderRawTurn(
                turn({
                    userMessage: 'ah vale... okkk no hagas nada de momento',
                    assistantText: 'Perfecto, no cambio nada. Lo resolveremos cuando retomemos este flujo.',
                    toolCalls: [],
                }),
            ),
        ).toBeNull();
    });

    it('keeps a substantive no-tool-call turn and accounts for separators exactly once', () => {
        const first = turn({ turnIndex: 1, toolCalls: [] });
        const second = turn({ turnIndex: 2, toolCalls: [], userMessage: 'second', assistantText: 'done' });
        const rendered = renderRawTurns([first, second]);

        expect(rendered).toContain('## Turn 1');
        expect(rendered).toContain('## Turn 2');
        expect(rendered).toContain(RAW_TURN_SEPARATOR);
        expect(renderedChars([first, second])).toBe(rendered.length);
    });

    it('neutralizes shell syntax in transcript-derived tool names and file paths', () => {
        const rendered = renderRawTurn(
            turn({
                toolCalls: [{ name: 'read`$([31m\x1b\x07', filePaths: ['/repo/$(evil)`\x1b[31m\x07file.ts'] }],
            }),
        );

        expect(rendered).toContain('- `read\\`$\\([31m`');
        expect(rendered).toContain('`/repo/$\\(evil)\\`file.ts`');
        expect(rendered).not.toContain('\x1b');
        expect(detectShellSyntax('read\\`$\\([31m')).toBe(false);
        expect(detectShellSyntax('/repo/$\\(evil)\\`file.ts')).toBe(false);
    });
});
