import { appendFileSync, mkdirSync, readFileSync, statSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { HOOK_LOG_LINE_MAX_CHARS, HOOK_LOG_MAX_BYTES, PRIVATE_FILE_MODE } from '../config/constants.js';
import { hookLogPath } from '../config/paths.js';

interface HookLogDependencies {
    replaceFile(file: string, content: Buffer): void;
}

const DEFAULT_DEPENDENCIES: HookLogDependencies = {
    replaceFile: (file, content) => writeFileSync(file, content, { mode: PRIVATE_FILE_MODE }),
};

function trimHookLog(file: string, dependencies: HookLogDependencies): void {
    if (statSync(file).size <= HOOK_LOG_MAX_BYTES) {
        return;
    }

    const content = readFileSync(file);
    const start = content.length - HOOK_LOG_MAX_BYTES;
    let retained = content.subarray(start);
    if (content[start - 1] !== 0x0a) {
        const firstCompleteLine = retained.indexOf(0x0a);
        if (firstCompleteLine >= 0 && firstCompleteLine < retained.length - 1) {
            retained = retained.subarray(firstCompleteLine + 1);
        }
    }
    dependencies.replaceFile(file, retained);
}

// Best-effort hook diagnostics must never affect hook delivery.
export function appendHookLog(message: string, dependencyOverrides: Partial<HookLogDependencies> = {}): void {
    try {
        const dependencies = { ...DEFAULT_DEPENDENCIES, ...dependencyOverrides };
        const file = hookLogPath();
        mkdirSync(path.dirname(file), { recursive: true });
        appendFileSync(file, `${new Date().toISOString()} ${message.replace(/[\r\n]+/g, ' ').slice(0, HOOK_LOG_LINE_MAX_CHARS)}\n`, {
            mode: PRIVATE_FILE_MODE,
        });
        trimHookLog(file, dependencies);
    } catch {
        // A memory aid never turns a tool startup into a failed session.
    }
}
