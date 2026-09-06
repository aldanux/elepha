import * as clack from '@clack/prompts';

export interface CliProgress {
    done(message?: string): void;
    fail(message?: string): void;
}

export function startCliProgress(message: string): CliProgress {
    const active = process.stdout.isTTY ? clack.spinner({ output: process.stdout }) : undefined;
    let running = active !== undefined;
    active?.start(`${message}…`);

    return {
        done(finalMessage = message) {
            if (!running) {
                return;
            }
            active?.stop(`${finalMessage} ✔`);
            running = false;
        },
        fail(finalMessage = message) {
            if (!running) {
                return;
            }
            active?.error(`${finalMessage} ✖`);
            running = false;
        },
    };
}
