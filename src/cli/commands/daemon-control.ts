import type { Command } from 'commander';
import { errorMessage } from '../../util/error.js';
import {
    type DaemonControlRuntime,
    defaultDaemonControlRuntime,
    pauseCaptureService,
    resolveCaptureService,
    resumeCaptureService,
} from '../capture-service.js';

export type { DaemonControlRuntime } from '../capture-service.js';

const SERVICE_CONTROL_GUIDANCE = 'elepha capture service control is available on macOS and Linux after `elepha install`';

export function registerDaemonControl(program: Command, runtime: DaemonControlRuntime = defaultDaemonControlRuntime): void {
    program
        .command('pause')
        .description('Pause background capture until elepha resume')
        .action(() => pauseCapture(runtime));
    program
        .command('resume')
        .description('Resume background capture')
        .action(() => resumeCapture(runtime));
    program
        .command('restart')
        .description('Restart background capture (pause then resume)')
        .action(() => restartCapture(runtime));
}

function pauseCapture(runtime: DaemonControlRuntime): void {
    const service = serviceForControl(runtime);
    if (!service) {
        return;
    }

    try {
        const result = pauseCaptureService(service);
        printState(result.changed ? 'Capture daemon paused' : 'Capture daemon already paused', result.state);
    } catch (error) {
        console.error(errorMessage(error));
        process.exitCode = 1;
    }
}

function resumeCapture(runtime: DaemonControlRuntime): void {
    const service = serviceForControl(runtime);
    if (!service) {
        return;
    }

    try {
        const result = resumeCaptureService(service, runtime);
        printHealth(result.changed ? 'Capture daemon running' : 'Capture daemon already running', result.health.state);
    } catch (error) {
        console.error(errorMessage(error));
        process.exitCode = 1;
    }
}

function restartCapture(runtime: DaemonControlRuntime): void {
    const service = serviceForControl(runtime);
    if (!service) {
        return;
    }

    try {
        pauseCaptureService(service);
        const result = resumeCaptureService(service, runtime);
        printHealth('Capture daemon restarted', result.health.state);
    } catch (error) {
        console.error(errorMessage(error));
        process.exitCode = 1;
    }
}

function serviceForControl(runtime: DaemonControlRuntime) {
    const service = resolveCaptureService(runtime);
    if (!service) {
        console.error(SERVICE_CONTROL_GUIDANCE);
        process.exitCode = 1;
    }
    return service;
}

function printState(prefix: string, state: { loaded: boolean; disabled: boolean; unknown: boolean }): void {
    const unknown = state.unknown ? ', unknown: true' : '';
    console.log(`${prefix} (loaded: ${state.loaded}, disabled: ${state.disabled}${unknown}).`);
}

function printHealth(prefix: string, state: string): void {
    console.log(`${prefix} (${state}).`);
}
