import { styleText } from 'node:util';
import { CLI_PROGRESS_FRAME_DELAY_MS } from '../config/constants.js';

export interface CliProgress {
    done(message?: string): void;
    fail(message?: string): void;
}

const PROGRESS_FRAMES = ['◒', '◐', '◓', '◑'] as const;

function startDotlessCliProgress(message: string): CliProgress {
    let frame = 0;
    let running = true;
    const render = (text: string): void => {
        process.stdout.write(`\r\u001B[2K${text}`);
    };
    const tick = (): void => {
        const currentFrame = PROGRESS_FRAMES[frame] ?? PROGRESS_FRAMES[0];
        render(`${styleText('magenta', currentFrame, { stream: process.stdout })}  ${message}`);
        frame = (frame + 1) % PROGRESS_FRAMES.length;
    };
    const finish = (symbol: string, color: 'green' | 'red', finalMessage: string): void => {
        if (!running) {
            return;
        }
        clearInterval(timer);
        render(`${styleText(color, symbol, { stream: process.stdout })}  ${finalMessage}\n`);
        running = false;
    };

    tick();
    const timer = setInterval(tick, CLI_PROGRESS_FRAME_DELAY_MS);
    timer.unref();

    return {
        done(finalMessage = message) {
            finish('◇', 'green', `${finalMessage} ✔`);
        },
        fail(finalMessage = message) {
            finish('▲', 'red', `${finalMessage} ✖`);
        },
    };
}

export function startCliProgress(message: string): CliProgress {
    if (!process.stdout.isTTY) {
        return { done: () => undefined, fail: () => undefined };
    }
    return startDotlessCliProgress(message);
}
