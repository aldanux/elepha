# Configuration

elepha stores persistent user settings in `$ELEPHA_HOME/config.json`. If
`ELEPHA_HOME` is not set, that file is `~/.elepha/config.json`. Configuration changes
affect future command and service behavior; they do not rewrite captured memory.

## Interactive settings

Run `elepha config` without a subcommand to open a small interactive wizard. It shows
the available settings and their effective values, then lets you change a preference
without editing JSON by hand.

For a non-interactive overview, `elepha config list` prints every setting, its current
effective value, and whether that value comes from configuration, the environment, or
the built-in default.

## Settings reference

| Key                   | Accepted values                        | Default  | What it does                                                                                                                                                                                                        |
|-----------------------|----------------------------------------|----------|---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------|
| `update-check`        | `true`, `false`, `1`, `0`, `on`, `off` | `true`   | Controls the background check for a newer elepha release. `ELEPHA_NO_UPDATE_CHECK` disables the check for one invocation without changing the stored preference.                                                    |
| `capture-claude-code` | `true`, `false`, `1`, `0`, `on`, `off` | `true`   | Controls capture of Claude Code sessions. At least one capture tool must remain enabled.                                                                                                                            |
| `capture-codex`       | `true`, `false`, `1`, `0`, `on`, `off` | `true`   | Controls capture of Codex sessions. At least one capture tool must remain enabled.                                                                                                                                  |
| `query-matching`      | `strict`, `lax`                        | `strict` | Controls how closely recall results must match a multi-term query. A query that returns nothing under `strict` may return relevant partial matches under `lax`; the normal ranking and quality filters still apply. |

## Read and change one setting

`elepha config get <key>` prints the effective value of one setting. To store an
override, pass its key and value to `elepha config set <key> <value>`. Boolean settings
accept `true` or `false`, `1` or `0`, and `on` or `off`.

For example, the `update-check` setting controls the background check for a newer
elepha release and is on by default:

```console
elepha config get update-check
elepha config set update-check off
```

`elepha config unset <key>` removes the stored override and prints the effective value
that remains, normally the built-in default. To restore the default update behavior:

```console
elepha config unset update-check
```
