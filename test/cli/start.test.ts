import { Command } from 'commander';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { registerStart } from '../../src/cli/commands/start.js';
import { IngestionDaemon } from '../../src/daemon/index.js';
import { withTempDir } from '../helpers/tmp.js';

describe('elepha start', () => {
    let previousElephaHome: string | undefined;
    let previousExitCode: number | string | null | undefined;

    beforeEach(() => {
        previousElephaHome = process.env.ELEPHA_HOME;
        previousExitCode = process.exitCode;
        process.env.ELEPHA_HOME = withTempDir('elepha-start-');
        process.exitCode = undefined;
    });

    afterEach(() => {
        if (previousElephaHome === undefined) {
            delete process.env.ELEPHA_HOME;
        } else {
            process.env.ELEPHA_HOME = previousElephaHome;
        }
        process.exitCode = previousExitCode;
        vi.restoreAllMocks();
    });

    it('exits cleanly on stdout without starting the daemon when consent is awaiting approval', async () => {
        const log = vi.spyOn(console, 'log').mockImplementation(() => undefined);
        const error = vi.spyOn(console, 'error').mockImplementation(() => undefined);
        const start = vi.spyOn(IngestionDaemon.prototype, 'start');
        const program = new Command();
        registerStart(program);

        await program.parseAsync(['node', 'elepha', 'start']);

        expect(process.exitCode).toBeUndefined();
        expect(log).toHaveBeenCalledWith(expect.stringContaining('capture is awaiting consent'));
        expect(log).toHaveBeenCalledWith(expect.stringContaining('elepha init'));
        expect(error).not.toHaveBeenCalled();
        expect(start).not.toHaveBeenCalled();
    });
});
