// Keep report newlines and render other terminal controls, directional formatting
// and shell substitution characters as visible Unicode escapes without dropping text.
export function escapeTerminalText(text: string): string {
    return text.replace(
        // biome-ignore lint/suspicious/noControlCharactersInRegex: these controls must be matched to render them as inert escapes
        /[\x00-\x09\x0b-\x1f\x7f-\x9f\u061c\u200e-\u200f\u2028-\u202e\u2066-\u2069$`]/g,
        (character) => `\\u${character.charCodeAt(0).toString(16).padStart(4, '0')}`,
    );
}
