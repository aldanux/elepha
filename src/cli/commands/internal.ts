import type { Command } from 'commander';
import { runLauncherProbe } from '../launcher-probe.js';

export function registerInternal(program: Command): void {
    const internal = program.command('internal', { hidden: true }).description('Internal elepha commands');

    internal
        .command('launcher-probe')
        .argument('<minimumVersion>')
        .description('Internal launcher package-ownership check')
        .action((minimumVersion: string) => {
            const status = runLauncherProbe(minimumVersion);
            if (status !== 0) {
                process.exitCode = status;
            }
        });
}
