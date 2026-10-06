import { describe, expect, it } from 'vitest';
import { titleForTurn, UNTITLED_EPISODE } from '../../src/storage/session-title.js';

describe('session titles', () => {
    it('truncates long first prompts to 72 characters and preserves short prompts and ai-titles', () => {
        const longPrompt = 'Implement the session title fallback so ticket-driven Codex sessions remain legible in the session list.';
        const title = titleForTurn(null, { userMessage: longPrompt }, false);

        expect(title).toHaveLength(72);
        expect(title.endsWith('…')).toBe(true);
        expect(title).toBe('Implement the session title fallback so ticket-driven Codex sessions re…');
        expect(titleForTurn(null, { userMessage: 'Fix session title fallback' }, false)).toBe('Fix session title fallback');
        expect(titleForTurn(null, { userMessage: 'Fallback prompt', aiTitle: 'Generated title' }, true)).toBe('Generated title');
    });

    it('uses AI titles 1:1 apart from whitespace collapse and the safety cap', () => {
        expect(titleForTurn(null, { userMessage: 'Fallback prompt', aiTitle: '  Keep $(this)\n title  ' }, true)).toBe(
            'Keep $(this) title',
        );
        expect(titleForTurn(null, { userMessage: 'Fallback prompt', aiTitle: 'x'.repeat(80) }, true)).toBe(`${'x'.repeat(71)}…`);
    });

    it('uses the first non-empty line of a multi-line prompt', () => {
        const prompt = 'Sesión de construcción sobre market-scout.\n\n0 (comprobación previa, luego implementación).';

        expect(titleForTurn(null, { userMessage: prompt }, false)).toBe('Sesión de construcción sobre market-scout.');
    });

    it('collapses the whole prompt when the cleaned first line is shorter than 20 characters', () => {
        const prompt = 'Quick question\nPlease diagnose the session title fallback.';

        expect(titleForTurn(null, { userMessage: prompt }, false)).toBe('Quick question Please diagnose the session title fallback.');
    });

    it('uses the next non-empty line after a short markdown heading', () => {
        const prompt = '# Plan\n\nImplement the session-title fallback from the next substantive line.';

        expect(titleForTurn(null, { userMessage: prompt }, false)).toBe(
            'Implement the session-title fallback from the next substantive line.',
        );
    });

    it('walks past consecutive short markdown headings', () => {
        const prompt = '# Plan\n## Storage\nImplement the session-title fallback from the third line.';

        expect(titleForTurn(null, { userMessage: prompt }, false)).toBe('Implement the session-title fallback from the third line.');
    });

    it('collapses the whole prompt when a short heading has no long line after it', () => {
        const prompt = '# Plan\n## Scope\nKeep it small';

        expect(titleForTurn(null, { userMessage: prompt }, false)).toBe('# Plan ## Scope Keep it small');
    });

    it('titles the verbatim Objective prompt from its second line', () => {
        const prompt =
            '## Objective\nFold the four duplicated readline [y/N] confirmation helpers into a single confirmYesNo in src/cli/shared.ts, with every prompt string preserved byte-for-byte.';

        expect(titleForTurn(null, { userMessage: prompt }, false)).toBe(
            'Fold the four duplicated readline [y/N] confirmation helpers into a sin…',
        );
    });

    it('strips one leading markdown heading run from the chosen first line', () => {
        expect(
            titleForTurn(
                null,
                { userMessage: '# Refine the raw-turn rendering filters\n\nRead-only measurement, then implementation.' },
                false,
            ),
        ).toBe('Refine the raw-turn rendering filters');
        expect(titleForTurn(null, { userMessage: '## Improve the session-title fallback\n\nKeep the scope narrow.' }, false)).toBe(
            'Improve the session-title fallback',
        );
    });

    it('skips every Codex history-review preamble only when it starts the trimmed prompt', () => {
        const preambles = [
            'The Following Is The Codex Agent History Added Since Your Last Approval',
            'The Following Is The Codex Agent History Whose Request Action You Are Assessing',
            'The Following Is The Codex Agent History Whose Request Action You Are Approving',
        ];

        for (const preamble of preambles) {
            expect(titleForTurn(null, { userMessage: `  ${preamble}: review it.` }, false)).toBe(UNTITLED_EPISODE);
            expect(titleForTurn(null, { userMessage: `${preamble}: review it.` }, false)).toBe(UNTITLED_EPISODE);
        }

        const prompt = `Review the session title fallback\n\nThis body contains ${preambles[0].toLowerCase()} later.`;
        expect(titleForTurn(null, { userMessage: prompt }, false)).toBe('Review the session title fallback');
    });

    it('uses the first non-command prompt after elepha control turns', () => {
        const turns = [
            { userMessage: ' elepha:list ' },
            { userMessage: 'ELEPHA:resume:2' },
            { userMessage: 'Implement filtered recent sessions' },
        ];

        const title = turns.reduce((currentTitle, turn) => titleForTurn(currentTitle, turn, false), null as string | null);

        expect(title).toBe('Implement filtered recent sessions');
        expect(turns.slice(0, 2).reduce((currentTitle, turn) => titleForTurn(currentTitle, turn, false), null as string | null)).toBe(
            UNTITLED_EPISODE,
        );
    });

    it('uses an absolute-path prompt as a substantive title', () => {
        const prompt = '/Users/dani/Sites/elepha is failing after the update; diagnose it';

        expect(titleForTurn(null, { userMessage: prompt }, false)).toBe(prompt);
    });

    it('does not infer a slash-command session from prose or embedded command markup', () => {
        const objective =
            'Objective Slash-command sessions must stay untitled: extend title coverage.\n\nExample: <command-message>clear</command-message>';
        const fork = '<fork-boilerplate> You are a worker fork reviewing command sessions.\n\n<command-name>/clear</command-name>';

        expect(titleForTurn(null, { userMessage: objective }, false)).toBe(
            'Objective Slash-command sessions must stay untitled: extend title cover…',
        );
        expect(titleForTurn(null, { userMessage: fork }, false)).toBe(
            '<fork-boilerplate> You are a worker fork reviewing command sessions.',
        );
    });

    it('preserves every pre-existing non-substantive prompt rule', () => {
        const prompts = [
            '',
            'elepha:list',
            'compact',
            'This session is being continued from a previous conversation that ran out of context. Continue the work.',
        ];

        for (const prompt of prompts) {
            expect(titleForTurn(null, { userMessage: prompt }, false)).toBe(UNTITLED_EPISODE);
        }
    });

    it('ignores ai-titles when every user turn is a command', () => {
        const turns = [
            { userMessage: 'elepha:list', aiTitle: 'Elepha list' },
            {
                userMessage: '<command-name>/compact</command-name>\n<command-message>compact</command-message>',
                aiTitle: 'Compact conversation',
            },
            { userMessage: 'compact', aiTitle: 'Compaction' },
            { userMessage: '', aiTitle: 'Empty prompt' },
        ];

        const title = turns.reduce((currentTitle, turn) => titleForTurn(currentTitle, turn, true), null as string | null);

        expect(title).toBe(UNTITLED_EPISODE);
    });

    it('keeps slash-command wrapper turns untitled', () => {
        const wrapper =
            '<command-name>/clear</command-name>\n            <command-message>clear</command-message>\n            <command-args></command-args>';

        expect(titleForTurn(null, { userMessage: wrapper }, false)).toBe(UNTITLED_EPISODE);
    });

    it('walks past filesystem paths, code, comments, and diff fragments to prose', () => {
        const prompts = [
            [
                '# Objetivo',
                '/Users/dani/Sites/vrd/cms-template-inertia/resources/views/cms/_shared/navigation.blade.php, /Users/dani/Sites/vrd/goldenrace/resources/views/cms/_shared/navigation.blade.php',
                'Corrige la navegación compartida sin cambiar el contrato público.',
            ],
            ['# Objective', '//noinspection JSUnusedGlobalSymbols', 'Explain why the exported fixture remains intentionally unused.'],
            [
                '# Objective',
                'if (destinationInfo.isSymbolicLink()) {',
                'Keep symbolic-link destinations inside the validated provider root.',
            ],
            [
                'export function copyPrivateFile(source: string): void {',
                'ensurePrivateDir(path.dirname(destination));',
                '}',
                'Unused function copyPrivateFile: decide whether to keep or remove it.',
            ],
            ['# Objective', '@@ -18,7 +18,8 @@', 'Preserve the prose request after the pasted diff fragment.'],
        ];

        expect(prompts.map((lines) => titleForTurn(null, { userMessage: lines.join('\n') }, false))).toEqual([
            'Corrige la navegación compartida sin cambiar el contrato público.',
            'Explain why the exported fixture remains intentionally unused.',
            'Keep symbolic-link destinations inside the validated provider root.',
            'Unused function copyPrivateFile: decide whether to keep or remove it.',
            'Preserve the prose request after the pasted diff fragment.',
        ]);
    });

    it('strips leading markdown emphasis and colon noise from prose candidates', () => {
        expect(titleForTurn(null, { userMessage: '**Objective:** Read-only — determine exactly what elepha install does.' }, false)).toBe(
            'Objective: Read-only — determine exactly what elepha install does.',
        );
        expect(titleForTurn(null, { userMessage: '__Objective:__ Preserve the title contract.' }, false)).toBe(
            'Objective: Preserve the title contract.',
        );
        expect(titleForTurn(null, { userMessage: ': Unused function copyPrivateFile : en src/util/fs.ts' }, false)).toBe(
            'Unused function copyPrivateFile : en src/util/fs.ts',
        );
    });

    it('does not derive a title when a prompt contains no prose candidate', () => {
        expect(titleForTurn(null, { userMessage: '/Users/dani/Sites/elepha/src/storage/session-title.ts' }, false)).toBe(UNTITLED_EPISODE);
        expect(titleForTurn(null, { userMessage: 'if (destinationInfo.isSymbolicLink()) {' }, false)).toBe(UNTITLED_EPISODE);
        expect(
            [
                {
                    userMessage:
                        'if (destinationInfo.isSymbolicLink()) {\n    throw new Error("refusing");\n} : en src/cli/commands/backup.ts',
                },
                { userMessage: 'arreglalo' },
            ].reduce((currentTitle, turn) => titleForTurn(currentTitle, turn, false), null as string | null),
        ).toBe('arreglalo');
        expect(titleForTurn(null, { userMessage: 'Ruta\n/Users/dani/Sites/elepha/src/storage/session-title.ts' }, false)).toBe(
            'Ruta /Users/dani/Sites/elepha/src/storage/session-title.ts',
        );
    });

    it('adopts ai-titles once a segment has a substantive prompt', () => {
        const turns = [
            { userMessage: 'elepha:list' },
            { userMessage: 'Implement filtered recent sessions', aiTitle: 'Filtered recent sessions' },
            {
                userMessage: '<command-name>/compact</command-name>\n<command-message>compact</command-message>',
                aiTitle: 'Updated real-session title',
            },
        ];

        const title = turns.reduce((currentTitle, turn) => titleForTurn(currentTitle, turn, true), null as string | null);

        expect(title).toBe('Updated real-session title');
        expect(titleForTurn(null, { userMessage: 'Substantive request', aiTitle: 'Generated title' }, true)).toBe('Generated title');
    });
});
