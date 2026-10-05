#!/usr/bin/env node
process.setSourceMapsEnabled(true);
// The managed service launcher runs this probe before every daemon start,
// under the service manager's throttled background priority. Loading the whole
// CLI for it read hundreds of modules and native addons cold, ahead of the
// daemon's own load, and consumed most of the first-heartbeat window. The probe
// answers from its own module; every other invocation loads the CLI.
const [command, subcommand, minimumVersion, ...extra] = process.argv.slice(2);
if (command === 'internal' && subcommand === 'launcher-probe' && minimumVersion !== undefined && extra.length === 0) {
    const { runLauncherProbe } = await import('../dist/cli/launcher-probe.js');
    process.exitCode = runLauncherProbe(minimumVersion);
} else {
    await import('../dist/cli/index.js');
}
