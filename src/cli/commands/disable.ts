import type { Command } from 'commander';
import { getSetting, setSetting } from '../../config/settings.js';
import { errorMessage } from '../../util/error.js';

export function disableMemoryPlus(options: { configPath?: string; log?: (message: string) => void } = {}): void {
    const enabled = getSetting('memory-plus', {}, options.configPath).value;
    if (enabled) {
        setSetting('memory-plus', 'false', options.configPath);
    }
    (options.log ?? console.log)(
        `elepha's "Memory-Plus" ${enabled ? 'disabled' : 'is already off'}. Stored vectors and the local runtime are retained.`,
    );
}

export function registerDisable(program: Command): void {
    program
        .command('disable')
        .description('Turn off an optional feature without deleting its memory')
        .command('memory-plus')
        .description('Stop semantic indexing and search; retain stored vectors and the local runtime')
        .action(() => {
            try {
                disableMemoryPlus();
            } catch (error) {
                console.error(`elepha's "Memory-Plus" disable failed: ${errorMessage(error)}`);
                process.exitCode = 1;
            }
        });
}
