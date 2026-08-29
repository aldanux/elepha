#!/usr/bin/env node
// Entrypoint for `elepha` command. Wires CLI commands (start daemon, mcp serve, etc).

import { styleText } from 'node:util';
import { Command } from 'commander';
import { DOCS_URL, PACKAGE_VERSION } from '../config/constants.js';
import { loadEnvFileWithWarnings } from '../config/env.js';
import { registerBackfills } from './commands/backfills.js';
import { registerBackup } from './commands/backup.js';
import { registerConfig } from './commands/config.js';
import { registerConsent } from './commands/consent.js';
import { registerDaemonControl } from './commands/daemon-control.js';
import { registerDoctor } from './commands/doctor.js';
import { registerHook } from './commands/hook.js';
import { registerImport } from './commands/import.js';
import { registerInit } from './commands/init.js';
import { registerInspect } from './commands/inspect.js';
import { registerInstall } from './commands/install.js';
import { registerInternal } from './commands/internal.js';
import { registerMcp } from './commands/mcp.js';
import { registerProjects } from './commands/projects.js';
import { registerPurge } from './commands/purge.js';
import { registerReingest } from './commands/reingest.js';
import { registerRekey } from './commands/rekey.js';
import { registerRestore } from './commands/restore.js';
import { registerRollup } from './commands/rollup.js';
import { registerSanitize } from './commands/sanitize.js';
import { registerSegment } from './commands/segment.js';
import { registerSelfUpdate } from './commands/self-update.js';
import { registerStart } from './commands/start.js';
import { registerStats } from './commands/stats.js';
import { registerStatus } from './commands/status.js';
import { registerUninstall } from './commands/uninstall.js';

// Before anything reads process.env. Fixed locations only, never cwd - see
// src/config/env.ts for why that distinction matters for a daemon that runs
// while the user is standing in other people's repositories.
loadEnvFileWithWarnings();

const program = new Command();

program.name('elepha').description('Local memory layer for developers switching between AI coding CLIs').version(PACKAGE_VERSION);

program.configureHelp({
    styleTitle: (text: string) => styleText(['bold', 'yellow'], text),
    styleCommandText: (text: string) => styleText('green', text),
    styleSubcommandText: (text: string) => styleText('green', text),
    styleOptionText: (text: string) => styleText('green', text),
    styleArgumentText: (text: string) => styleText('green', text),
});

program.addHelpText('after', `\nRun 'elepha <command> -h' for details on a command.\nFull documentation: ${DOCS_URL}`);

registerConfig(program);
registerHook(program);
registerInstall(program);
registerUninstall(program);
registerInit(program);
registerSelfUpdate(program);
registerStart(program);

registerInternal(program);
registerMcp(program);

registerInspect(program);
registerProjects(program);
registerConsent(program);
registerDaemonControl(program);

registerStatus(program);
registerDoctor(program);

registerStats(program);
registerReingest(program);
registerRollup(program);
registerBackfills(program);
registerRekey(program);

registerBackup(program);
registerImport(program);
registerRestore(program);
registerPurge(program);
registerSanitize(program);
registerSegment(program);

program.parse();
