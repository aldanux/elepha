import type { Command } from 'commander';
import { DAEMON_BOOTOUT_DEADLINE_MS, DAEMON_HEALTH_CHECK_POLL_MS } from '../../config/constants.js';
import { isPidAlive } from '../../daemon/heartbeat.js';
import { errorMessage } from '../../util/error.js';
import { type DaemonControlRuntime, defaultDaemonControlRuntime, resolveCaptureService } from '../capture-service.js';

export interface StopCommandRuntime extends DaemonControlRuntime {
    isPidAlive(pid: number): boolean;
}

const defaultStopCommandRuntime: StopCommandRuntime = { ...defaultDaemonControlRuntime, isPidAlive };

export function registerStop(program: Command, runtime: StopCommandRuntime = defaultStopCommandRuntime): void {
    program
        .command('stop')
        .description('Stop the background capture daemon without disabling the service')
        .action(async () => {
            try {
                const service = resolveCaptureService(runtime);
                if (!service) {
                    throw new Error('elepha stop is available on macOS and Linux after `elepha install`.');
                }
                // Backends clear the heartbeat on stop. Retain its PID so a
                // missing heartbeat cannot conceal a process still releasing its DB.
                const previousPid = runtime.daemonHealth().heartbeat?.pid;
                service.stop();
                const deadline = runtime.now() + DAEMON_BOOTOUT_DEADLINE_MS;
                while (true) {
                    const currentPid = runtime.daemonHealth().heartbeat?.pid;
                    const livePid = [previousPid, currentPid].find((pid) => pid !== undefined && runtime.isPidAlive(pid));
                    if (livePid === undefined) {
                        break;
                    }
                    const remaining = deadline - runtime.now();
                    if (remaining <= 0) {
                        throw new Error(`Capture daemon pid ${livePid} is still running after stop.`);
                    }
                    await runtime.sleep(Math.min(DAEMON_HEALTH_CHECK_POLL_MS, remaining));
                }
                console.log('Capture daemon stopped. Run `elepha resume` to start it again.');
            } catch (error) {
                console.error(errorMessage(error));
                process.exitCode = 1;
            }
        });
}
