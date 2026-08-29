// Security Rule 3. The store must never hold executable syntax; these are the
// cases that define "executable" and the idempotency guarantees the backfill
// and the choke points depend on.

import { describe, expect, it } from 'vitest';
import { assertNoShellSyntax, detectShellSyntax, escapeShellSyntax, stripShellSyntax } from '../../src/security/sanitize.js';

const ESC = '\x1b';

describe('detectShellSyntax', () => {
    const active: Array<[string, string]> = [
        ['backtick', 'run `date` first'],
        ['command substitution', 'template used $(date)'],
        ['parameter expansion', 'reads ${HOME}/config'],
        ['process substitution out', 'diff >(sort)'],
        ['process substitution in', 'diff <(sort)'],
        ['heredoc', 'cat <<EOF'],
        ['here-string', 'cat <<< "x"'],
        ['line-leading pipe', 'first line\n| grep foo'],
        ['line-leading semicolon', 'first line\n  ; rm -rf /'],
        ['line-leading and', 'first line\n&& make'],
        ['line-leading or', 'first line\n|| true'],
        ['line-leading background', '& disown'],
        ['ANSI CSI', `plain${ESC}[31mred`],
        ['ANSI OSC', `title${ESC}]0;pwned\x07`],
        ['C0 control', 'a\x00b'],
        ['carriage return', 'visible\rhidden'],
    ];
    for (const [name, text] of active) {
        it(`flags ${name}`, () => {
            expect(detectShellSyntax(text)).toBe(true);
        });
    }

    const inert: Array<[string, string]> = [
        ['plain prose', 'Chose SQLite over Postgres for local storage'],
        ['mid-sentence semicolon', 'first; then second'],
        ['mid-sentence ampersand', 'Tom & Jerry'],
        ['single dollar', 'costs $5 per month'],
        ['single angle bracket', 'a < b and b > c'],
        ['already-escaped backtick', 'run \\`date\\` first'],
        ['already-escaped substitution', 'rejected $\\(date) in the template'],
        ['newline and tab', 'line one\n\tindented'],
        ['empty', ''],
    ];
    for (const [name, text] of inert) {
        it(`does not flag ${name}`, () => {
            expect(detectShellSyntax(text)).toBe(false);
        });
    }
});

describe('stripShellSyntax', () => {
    const cases: Array<[string, string, string]> = [
        ['backticks', 'run `date` first', 'run date first'],
        ['command substitution', 'template used $(date)', 'template used date'],
        ['parameter expansion', 'reads ${HOME}/config', 'reads HOME/config'],
        ['nested substitution', 'value $($(date))', 'value date'],
        ['unbalanced opener', 'dangling $( here', 'dangling  here'],
        ['heredoc marker', 'cat <<EOF', 'cat EOF'],
        ['line-leading chain', 'build\n&& deploy', 'build\n deploy'],
        ['indented line-leading chain', 'build\n  | tee log', 'build\n   tee log'],
        ['ANSI', `plain${ESC}[31mred`, 'plainred'],
        ['keeps ordinary punctuation', 'first; then second', 'first; then second'],
    ];
    for (const [name, input, expected] of cases) {
        it(`strips ${name}`, () => {
            expect(stripShellSyntax(input)).toBe(expected);
        });
    }

    it('leaves nothing the detector still flags', () => {
        for (const [, input] of Object.entries({ a: 'run `$(date)` <<EOF', b: '| $(x) `y` ${z}' })) {
            expect(detectShellSyntax(stripShellSyntax(input))).toBe(false);
        }
    });

    it('is idempotent', () => {
        const inputs = ['run `date`', '$(a $(b))', 'x\n&& y', `${ESC}[0m$(z)`, 'cat <<<EOF'];
        for (const input of inputs) {
            const once = stripShellSyntax(input);
            expect(stripShellSyntax(once)).toBe(once);
        }
    });
});

describe('escapeShellSyntax', () => {
    const cases: Array<[string, string, string]> = [
        ['backtick', 'run `date`', 'run \\`date\\`'],
        ['command substitution', 'rejected $(date) in the template', 'rejected $\\(date) in the template'],
        ['parameter expansion', 'uses ${HOME}', 'uses $\\{HOME}'],
        ['heredoc', 'cat <<EOF', 'cat <\\<EOF'],
        ['here-string', 'cat <<<x', 'cat <\\<<x'],
        ['line-leading chain prefixes, never infixes', 'build\n&& deploy', 'build\n\\&& deploy'],
        ['indented line-leading chain', 'build\n  ; deploy', 'build\n  \\; deploy'],
        ['ANSI is stripped, not escaped', `plain${ESC}[31mred`, 'plainred'],
    ];
    for (const [name, input, expected] of cases) {
        it(`escapes ${name}`, () => {
            expect(escapeShellSyntax(input)).toBe(expected);
        });
    }

    it('preserves the information Rule 3 says escaping exists to preserve', () => {
        const decision = 'rejected `$(date)` in the template because it re-evaluates on every render';
        const escaped = escapeShellSyntax(decision);
        expect(detectShellSyntax(escaped)).toBe(false);
        // Every word survives; only the metacharacters are broken.
        for (const word of ['rejected', 'date', 'template', 're-evaluates', 'render']) {
            expect(escaped).toContain(word);
        }
    });

    it('is idempotent - a backslash never accumulates', () => {
        const inputs = ['run `date`', 'uses ${HOME}', 'cat <<EOF', 'x\n&& y', 'a $(b) `c`', '| lead'];
        for (const input of inputs) {
            const once = escapeShellSyntax(input);
            expect(escapeShellSyntax(once)).toBe(once);
            expect(escapeShellSyntax(escapeShellSyntax(once))).toBe(once);
            expect(detectShellSyntax(once)).toBe(false);
        }
    });

    it('does not re-escape text a previous run already escaped', () => {
        expect(escapeShellSyntax('run \\`date\\`')).toBe('run \\`date\\`');
    });
});

describe('assertNoShellSyntax', () => {
    it('passes clean text through untouched and silently', () => {
        const logged: string[] = [];
        const result = assertNoShellSyntax('Chose SQLite over Postgres', 'brief:head', (m) => logged.push(m));
        expect(result).toEqual({ text: 'Chose SQLite over Postgres', repaired: false });
        expect(logged).toEqual([]);
    });

    it('logs loudly and repairs when a write path was missed', () => {
        const logged: string[] = [];
        const result = assertNoShellSyntax('run `date`', 'brief:head', (m) => logged.push(m));
        expect(result.repaired).toBe(true);
        expect(detectShellSyntax(result.text)).toBe(false);
        expect(logged).toHaveLength(1);
        expect(logged[0]).toContain('brief:head');
        // No silent degradation: the message must name the failure, not just note it.
        expect(logged[0]).toContain('write-time sanitizer was missed');
    });
});
