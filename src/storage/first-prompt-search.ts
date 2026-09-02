import { FIRST_PROMPT_SEARCH_CAP } from '../config/constants.js';
import { stripShellSyntax } from '../security/sanitize.js';

// Stores a bounded inert search document while preserving the prompt's leading ask.
export function firstPromptSearch(userMessage: string): string {
    return stripShellSyntax(userMessage).slice(0, FIRST_PROMPT_SEARCH_CAP);
}
