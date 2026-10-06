import { STORED_TOOL_IDENTIFIER_MAX_CHARS } from '../config/tool-display.js';
import { isToolName, TOOL_METADATA } from '../types/index.js';
import { escapeTerminalText } from './terminal-text.js';

export function storedToolDisplayName(tool: string): string {
    if (isToolName(tool)) {
        return TOOL_METADATA[tool].displayName;
    }
    // JSON preserves attribution while escaping terminal controls. Escape C1,
    // directional formatting and shell substitution characters as literal Unicode
    // escapes too, so a legacy identifier cannot alter the displayed report.
    const quoted = escapeTerminalText(JSON.stringify(tool.slice(0, STORED_TOOL_IDENTIFIER_MAX_CHARS)));
    const omitted = tool.length - STORED_TOOL_IDENTIFIER_MAX_CHARS;
    return `Unrecognized legacy tool ${quoted}${omitted > 0 ? ` (${omitted} trailing characters omitted)` : ''}`;
}
