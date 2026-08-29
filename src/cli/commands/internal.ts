import type { Command } from 'commander';
import { formatLauncherProbeFailure, launcherProbe } from '../launcher-probe.js';

export function registerInternal(program: Command): void {
    const internal = program.command('internal', { hidden: true }).description('Internal elepha commands');

    internal
        .command('launcher-probe')
        .argument('<minimumMajor>')
        .description('Internal launcher package-ownership check')
        .action((minimumMajor: string) => {
            const result = launcherProbe(Number(minimumMajor));
            if (!result.passes) {
                console.error(formatLauncherProbeFailure(result.failure));
                process.exitCode = 66;
            }
        });
}
