import { FIRST_PROMPT_SEARCH_CAP } from '../config/constants.js';
import { stripShellSyntax } from '../security/sanitize.js';

// Stores a bounded inert search document while preserving the prompt's leading ask.
export function firstPromptSearch(userMessage: string): string {
    return stripShellSyntax(userMessage).slice(0, FIRST_PROMPT_SEARCH_CAP);
}

// The durable projection has already passed through escapeShellSyntax while
// its search document came from the raw prompt through stripShellSyntax.
// Reverse one known escape layer only in this identity-only copy, immediately
// strip it, and return a boolean. Never use this copy as served content.
export function matchesFirstPromptSearch(userMessage: string, searchDocument: string, durableEscaped: boolean): boolean {
    if (!searchDocument.trim()) {
        return false;
    }
    if (firstPromptSearch(userMessage) === searchDocument) {
        return true;
    }
    if (!durableEscaped) {
        return false;
    }
    const comparisonOnly = userMessage
        .replace(/(\\+)`/g, (match, slashes: string) => (slashes.length % 2 === 1 ? `${slashes.slice(1)}\u0060` : match))
        .replace(/\$\\([({])|([<>])\\\(/g, (_match, dollarOpen: string | undefined, processOpen: string | undefined) =>
            dollarOpen === undefined ? `${processOpen}(` : `$${dollarOpen}`,
        )
        .replace(/<\\</g, '<<')
        .replace(
            /^([ \t]*)((?:\\*[|;&])+)/gm,
            (_match, indentation: string, chain: string) =>
                indentation +
                chain.replace(/(\\+)([|;&])/g, (operator, slashes: string, character: string) =>
                    slashes.length % 2 === 1 ? slashes.slice(1) + character : operator,
                ),
        );
    return firstPromptSearch(comparisonOnly) === searchDocument;
}
