import { existsSync } from 'node:fs';
import * as readline from 'node:readline';
import { CAPTURE_PAUSE_DEADLINE_MS, CAPTURE_PAUSE_POLL_MS } from '../config/constants.js';
import { daemonHealth } from '../install/health-checks.js';
import type { installElepha } from '../install/installer.js';
import { backupDatabaseAndReport } from '../storage/backup.js';
import { defaultDbPath, type openDb } from '../storage/db.js';
import type { PurgePlan } from '../storage/memory-store.js';
import { errorMessage } from '../util/error.js';
import { pauseCaptureService, resolveCaptureService, resumeCaptureService } from './capture-service.js';

export async function confirmYesNo(question: string): Promise<boolean> {
    const prompt = readline.createInterface({ input: process.stdin, output: process.stdout });
    const answer = await new Promise<string>((resolve) => prompt.question(question, resolve));
    prompt.close();
    return /^(y|yes)$/i.test(answer.trim());
}

export function printInstallation(result: ReturnType<typeof installElepha>, action: 'install' | 'uninstall'): void {
    console.log(`install binary: ${result.bin}`);
    if (result.launcher) {
        console.log(`managed launcher: ${result.launcher}`);
    }
    console.log(`Claude hook: ${result.status.claudeHook}`);
    console.log(`Claude UserPromptSubmit hook: ${result.status.claudeUserPromptSubmitHook}`);
    console.log(`Claude MCP: ${result.status.claudeMcp}`);
    console.log(`Codex hook: ${result.status.codexHook}`);
    console.log(`Codex UserPromptSubmit hook: ${result.status.codexUserPromptSubmitHook}`);
    console.log(`Codex MCP: ${result.status.codexMcp}`);
    if (
        action === 'install' &&
        (result.status.codexHook !== 'not present' || result.status.codexUserPromptSubmitHook !== 'not present') &&
        (result.status.codexHook !== 'active' || result.status.codexUserPromptSubmitHook !== 'active')
    ) {
        console.log('Codex hooks await approval. Open Codex, run `/hooks`, and approve each elepha hook once.');
    }
    if (result.service) {
        console.log(`daemon service: ${result.service}`);
    }
    if (action === 'install') {
        console.log('\nRun `elepha init` to choose which projects you want elepha to remember');
    }
}

// Refuses an operation only while the daemon has a fresh, healthy heartbeat.
export function refuseIfDaemonRunning(operation: string): boolean {
    const { state, healthy } = daemonHealth();
    if (healthy) {
        console.error(`Refusing ${operation} while the daemon is running (${state}). Stop it and retry.`);
        process.exitCode = 1;
        return true;
    }
    if (state.startsWith('STUCK')) {
        console.error(`Daemon appears stuck (${state}); proceeding — it is not writing.`);
    }
    return false;
}

export function prepareDestructiveApply(db: ReturnType<typeof openDb>, operation: string): boolean {
    if (refuseIfDaemonRunning(operation)) {
        return false;
    }
    const dbPath = defaultDbPath();
    if (existsSync(dbPath)) {
        backupDatabaseAndReport(db, dbPath);
    }
    return true;
}

function sleep(ms: number): Promise<void> {
    return new Promise((resolve) => setTimeout(resolve, ms));
}

async function waitForCaptureToStop(): Promise<boolean> {
    const deadline = Date.now() + CAPTURE_PAUSE_DEADLINE_MS;
    while (daemonHealth().healthy) {
        const remaining = deadline - Date.now();
        if (remaining <= 0) {
            return false;
        }
        await sleep(Math.min(CAPTURE_PAUSE_POLL_MS, remaining));
    }
    return true;
}

// Runs a destructive operation only after confirming that the capture writer is stopped.
export async function withCapturePaused(operation: string, fn: () => Promise<void>): Promise<boolean> {
    const health = daemonHealth();
    if (!health.healthy) {
        if (health.state.startsWith('STUCK')) {
            console.error(`Daemon appears stuck (${health.state}); proceeding — it is not writing.`);
        }
        await fn();
        return true;
    }

    const service = resolveCaptureService();
    if (!service) {
        console.error(`Refusing ${operation}: a running daemon could not be paused automatically. Stop it and retry.`);
        process.exitCode = 1;
        return false;
    }

    let pausedByUs = false;
    try {
        pauseCaptureService(service);
        pausedByUs = await waitForCaptureToStop();
    } catch (error) {
        console.error(errorMessage(error));
    }

    if (!pausedByUs) {
        console.error(`Refusing ${operation}: a running daemon could not be paused automatically. Stop it and retry.`);
        process.exitCode = 1;
        return false;
    }

    console.log('Paused capture…');
    try {
        await fn();
        return true;
    } finally {
        resumeCaptureService(service);
        console.log('Capture resumed.');
    }
}

export function printPurgePlan(plan: PurgePlan): void {
    if (plan.sessions.length === 0) {
        console.log('Nothing matches this scope. Nothing to purge.');
        return;
    }
    const totalTurns = plan.sessions.reduce((sum, s) => sum + s.turnCount, 0);
    const emptiedProjectPaths = new Set(plan.emptiedProjects.map((project) => project.path));
    const projectPaths = [...new Set(plan.sessions.map((session) => session.projectPath))].sort((a, b) => a.localeCompare(b));

    console.log(`In total: ${plan.sessions.length} session(s), ${totalTurns} turn(s).`);
    console.log('\nelepha memory in these projects:');
    for (const projectPath of projectPaths) {
        console.log(
            `  ${projectPath}${emptiedProjectPaths.has(projectPath) ? '  (project entry will be removed — no sessions left)' : ''}`,
        );
    }
}
