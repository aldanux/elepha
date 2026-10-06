import { describe, expect, it } from 'vitest';
import { storedToolDisplayName } from '../../src/cli/stored-tool-display.js';
import { STORED_TOOL_IDENTIFIER_MAX_CHARS } from '../../src/config/tool-display.js';
import { detectShellSyntax } from '../../src/security/sanitize.js';
import { SUPPORTED_TOOLS, TOOL_METADATA } from '../../src/types/index.js';

describe('legacy tool reporting', () => {
    it('keeps known names and losslessly quotes terminal and shell controls in legacy identifiers', () => {
        for (const tool of SUPPORTED_TOOLS) expect(storedToolDisplayName(tool)).toBe(TOOL_METADATA[tool].displayName);
        for (const tool of ['constructor', '__proto__', '', 'old"tool\\name', '\u001b[31m\r\n\t\u009b\u202e$(date)`id`']) {
            const display = storedToolDisplayName(tool);
            expect(display).toMatch(/^Unrecognized legacy tool "/);
            expect(JSON.parse(display.slice(display.indexOf('"')))).toBe(tool);
            expect(display).not.toContain('\u001b');
            expect(display).not.toContain('\u009b');
            expect(display).not.toContain('\u202e');
            expect(display).not.toContain('\n');
            expect(display).not.toContain('\r');
            expect(display).not.toContain('\t');
            expect(detectShellSyntax(display)).toBe(false);
        }
    });

    it('bounds oversized identifiers and explicitly attributes truncation', () => {
        const identifier = 'x'.repeat(STORED_TOOL_IDENTIFIER_MAX_CHARS + 20);
        const display = storedToolDisplayName(identifier);
        expect(display).toContain(JSON.stringify(identifier.slice(0, STORED_TOOL_IDENTIFIER_MAX_CHARS)));
        expect(display).toMatch(/20 trailing characters omitted/);
        expect(display).not.toContain(identifier);
        const escaped = storedToolDisplayName('\u001b'.repeat(STORED_TOOL_IDENTIFIER_MAX_CHARS * 100));
        expect(escaped.length).toBeLessThan(STORED_TOOL_IDENTIFIER_MAX_CHARS * 6 + 100);
        expect(escaped).not.toContain('\u001b');
    });
});
