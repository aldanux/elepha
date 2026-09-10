import { CLOSE, OPEN } from '../security/sentinel.js';
import { DISPLAY_VERBATIM_INSTRUCTIONS, dataBlockClose, dataBlockOpen, SERVER_INSTRUCTIONS } from '../serving/instructions.js';
import type { UserPromptCommand } from './user-prompt-submit.js';

const briefOpen = `${OPEN}brief:`;
const dataOpen = dataBlockOpen('').slice(0, -2);
const dataClose = dataBlockClose('').slice(0, -2);

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

// Strip framing only from the direct display; recordHookOutput already recorded
// the body for later quote-backs, and model-driven messages need the full framing.
// Both structured denial at exit 0 and stderr at exit 2 select Kimi's block path.
export function kimiOutput(body: string, command: UserPromptCommand | undefined): Record<string, unknown> {
    return modelDriven(command)
        ? { message: body }
        : {
              hookSpecificOutput: {
                  permissionDecision: 'deny',
                  permissionDecisionReason: body
                      .split('\n')
                      .filter(
                          (line) =>
                              !line.startsWith(briefOpen) &&
                              line.trim() !== CLOSE &&
                              !line.startsWith(SERVER_INSTRUCTIONS) &&
                              line !== DISPLAY_VERBATIM_INSTRUCTIONS &&
                              !((line.startsWith(dataOpen) || line.startsWith(dataClose)) && line.endsWith(']]')),
                      )
                      .join('\n')
                      .trim(),
              },
          };
}
