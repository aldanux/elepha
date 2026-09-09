import { DISPLAY_VERBATIM_INSTRUCTIONS } from '../serving/instructions.js';
import type { UserPromptCommand } from './user-prompt-submit.js';

// Kimi passes ContentPart[] on stdin. Non-text parts cannot form a command;
// a malformed text part refuses the payload instead of dispatching partial text.
export function normalizeKimiPrompt(prompt: unknown): string | undefined {
    if (!Array.isArray(prompt)) {
        return undefined;
    }
    const parts: string[] = [];
    for (const part of prompt) {
        if (!part || typeof part !== 'object' || typeof part.type !== 'string') {
            return undefined;
        }
        if (part.type === 'text') {
            if (typeof part.text !== 'string') {
                return undefined;
            }
            parts.push(part.text);
        }
    }
    return parts.join('\n');
}

function modelDriven(command: UserPromptCommand | undefined): boolean {
    return command?.kind === 'resume' || command?.kind === 'last';
}

// Recall currently displays hits and a resume selector; it has no model answer phase.
// Remove only the display directive before recording the body actually served.
export function kimiCommandBody(body: string, command: UserPromptCommand | undefined): string {
    const directive = `${DISPLAY_VERBATIM_INSTRUCTIONS}\n`;
    return !modelDriven(command) && body.startsWith(directive) ? body.slice(directive.length) : body;
}

// Kimi consumes message, not Claude's additionalContext. Denial renders that
// message as a hook result and skips submission, while allow appends context.
export function kimiOutput(body: string, command: UserPromptCommand | undefined): Record<string, unknown> {
    return modelDriven(command)
        ? { message: body }
        : { hookSpecificOutput: { permissionDecision: 'deny', permissionDecisionReason: body } };
}
