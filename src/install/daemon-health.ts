import { existsSync, readFileSync } from 'node:fs';
import {
    DAEMON_HEALTH_CHECK_DEADLINE_MS,
    DAEMON_HEALTH_CHECK_POLL_MS,
    DAEMON_OUTPUT_MAX_CHARS,
    DAEMON_STDERR_TAIL_CHARS,
} from '../config/constants.js';
import { HEARTBEAT_STALE_MS, isPidAlive, readHeartbeat } from '../daemon/heartbeat.js';

export interface DaemonHealthCheckRuntime {
    now(): number;
    sleep(milliseconds: number): void;
}

export const defaultDaemonHealthCheckRuntime: DaemonHealthCheckRuntime = {
    now: () => Date.now(),
    sleep(milliseconds) {
        Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, milliseconds);
    },
};

export function boundedDaemonOutput(output: string): string {
    const sanitized = output.replace(/\p{Cc}/gu, ' ').trim();
    if (sanitized.length <= DAEMON_OUTPUT_MAX_CHARS) {
        return sanitized;
    }
    return `[${sanitized.length - DAEMON_OUTPUT_MAX_CHARS} older characters omitted] ${sanitized.slice(-DAEMON_OUTPUT_MAX_CHARS)}`;
}

export function healthyHeartbeat(heartbeatPath: string, now: number): boolean {
    const heartbeat = readHeartbeat(heartbeatPath);
    return !!heartbeat && isPidAlive(heartbeat.pid) && now - new Date(heartbeat.updatedAt).getTime() < HEARTBEAT_STALE_MS;
}

export function waitForHealthyHeartbeat(isHealthy: () => boolean, runtime: DaemonHealthCheckRuntime): boolean {
    const deadline = runtime.now() + DAEMON_HEALTH_CHECK_DEADLINE_MS;
    while (true) {
        if (isHealthy()) {
            return true;
        }
        const remaining = deadline - runtime.now();
        if (remaining <= 0) {
            return false;
        }
        runtime.sleep(Math.min(DAEMON_HEALTH_CHECK_POLL_MS, remaining));
    }
}

export function daemonHealthFailure(stderrPath: string, details: readonly string[] = []): Error {
    let stderrTail = 'no daemon stderr log';
    if (existsSync(stderrPath)) {
        try {
            const stderr = readFileSync(stderrPath, 'utf8');
            stderrTail = boundedDaemonOutput(stderr.slice(-DAEMON_STDERR_TAIL_CHARS)) || 'empty daemon stderr log';
        } catch (error) {
            stderrTail = `unreadable daemon stderr log: ${boundedDaemonOutput(String(error)) || 'unknown error'}`;
        }
    }
    const detailText = details.length > 0 ? `${details.join('; ')}; ` : '';
    return new Error(
        `capture service did not produce a healthy heartbeat within ${DAEMON_HEALTH_CHECK_DEADLINE_MS / 1000}s; ${detailText}daemon stderr log tail: ${stderrTail}`,
    );
}
