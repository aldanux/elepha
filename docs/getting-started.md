# Getting started

elepha adds a shared local memory layer across supported AI coding CLIs. It runs as
a global command-line tool plus a small background service that reads the session
files those tools already keep. Getting started means installing the package,
registering elepha with the tools you use, and choosing which projects it may remember.

## Requirements

You need Node.js 22.12.0 or newer. elepha supports macOS and Linux, including Windows
through WSL; native Windows is not supported. Linux requires glibc 2.35 or newer and
systemd. The encrypted database driver ships as a prebuilt binary, so no compiler is
needed. WSL users may need to enable systemd as described in [WSL](#wsl).

## Install the package

Install elepha globally with npm:

```console
npm install -g elepha
```

This puts the `elepha` command on your `PATH`. Register that installation with your
AI coding tools next:

```console
elepha install
```

The installer detects supported AI coding tools, configures elepha's capture and recall
integrations for each one, and sets up the background capture service. It changes only
elepha-owned blocks and keys in each tool's global configuration, leaving unrelated
settings intact. The command is safe to run again when repairing or refreshing an
installation.

At least one supported coding tool must already be installed. After registration,
continue with [Choosing what elepha may remember](consent.md) to discover projects
and grant consent. Nothing is captured until at least one root is approved.

## Approve the Codex hooks

Codex requires one manual approval before newly registered hooks may run. Open Codex,
run `/hooks`, and approve both elepha hooks. Until they are approved, Codex sessions
will not be captured and in-chat `elepha:` recall commands will not work. Codex may
ask for approval again if an update changes a hook.

Claude Code does not require this extra step; its hooks become active as soon as the
installer registers them.

OpenCode capture does not depend on a chat hook. The background service passively reads
OpenCode's local session database, with capture on by default and every project still
protected by the consent choices in `elepha init` or `elepha consent`. When OpenCode is
detected, `elepha install` registers the local elepha MCP server in its global `opencode.json`,
making recall available through MCP tools. It also installs the elepha plugin at
`~/.config/opencode/plugins/elepha.js` (or `$XDG_CONFIG_HOME/opencode/plugins/elepha.js`).
The plugin enables `elepha:list`, `elepha:resume`, `elepha:query`, `elepha:last`,
`elepha:info`, `elepha:help`, and `elepha:update` in chat, matching Claude Code and Codex.
Restart OpenCode after installation to load the plugin.

## Verify the installation

Use the quick and deep checks in [Troubleshooting](troubleshooting.md) after choosing
your projects. The deep check can restart a stopped service and will tell you when
registration or hook approval still needs attention.

## Where elepha keeps its data

By default, elepha keeps its database, configuration, logs, backups, launcher, and
service files under `~/.elepha/`. Set `ELEPHA_HOME` to use a different location.
The memory database is `$ELEPHA_HOME/elepha.db` and is encrypted in full. Its key is
kept in the operating system's secret store where available, or in a private key file
under `$ELEPHA_HOME` otherwise. Existing plaintext databases migrate automatically on
upgrade; no manual export or import is required. See
[Protecting and recovering memory](storage.md) for migration space and interrupted
recovery requirements.

Nothing is written into your project directories, and elepha never modifies the
original Claude Code or Codex transcripts or the OpenCode session database. Use the [storage tools](storage.md) to
make encrypted same-installation backups instead of treating the database as
disposable: it holds privacy and lifecycle state and, when durable capture is enabled,
may hold the only surviving sanitized copy of a deleted source transcript.

## Platform notes

### macOS

The background service runs under launchd. Installation creates and loads the user
service; the runtime controls described in [Controlling capture](capture.md) manage it
afterward.

### Linux

The background service runs as a systemd user unit, starts with the user service
manager, and restarts on failure. Remaining active after logout or starting before
login depends on systemd lingering configured outside elepha.

### WSL

elepha uses systemd inside WSL. If the installer reports that systemd is not active,
add the following to `/etc/wsl.conf`:

```ini
[boot]
systemd=true
```

From Windows, run `wsl --shutdown`, reopen the WSL terminal, and run the installer
again.

## Removing elepha

First remove elepha's hooks, MCP registrations, launcher, and background service:

```console
elepha uninstall
```

Then remove the global npm package if you no longer need the command:

```console
npm uninstall -g elepha
```

Uninstalling deliberately leaves `$ELEPHA_HOME/elepha.db` intact, so removing the
integration cannot erase captured memory by surprise. If you want to remove that
memory too, consider making a [backup](storage.md) first, then follow
[Deleting memory](purge.md) for a previewed, backed-up deletion.
