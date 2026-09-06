import type { Command } from 'commander';
import { formatLauncherProbeFailure, launcherProbe } from '../launcher-probe.js';

export function registerInternal(program: Command): void {
    const internal = program.command('internal', { hidden: true }).description('Internal elepha commands');

    internal
        .command('launcher-probe')
        .argument('<minimumVersion>')
        .description('Internal launcher package-ownership check')
        .action((minimumVersion: string) => {
            const result = launcherProbe(minimumVersion);
            if (!result.passes) {
                console.error(formatLauncherProbeFailure(result.failure));
                process.exitCode = 66;
            }
        });
}
