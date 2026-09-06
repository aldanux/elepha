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
| `durable-capture`     | `true`, `false`, `1`, `0`, `on`, `off` | `false`  | Stores sanitized conversation copies for provider-independent content search and session revival. Restart the capture service after changing it.                                                                    |
| `query-matching`      | `strict`, `lax`                        | `strict` | Controls how closely recall results must match a multi-term query. A query that returns nothing under `strict` may return relevant partial matches under `lax`; the normal ranking and quality filters still apply. |

## Optional synthesis

Capture, storage, search, and recall do not require an AI provider. Synthesis currently
supports Anthropic only. When `ANTHROPIC_API_KEY` is configured, elepha sends eligible
turn text to Anthropic for synthesis under that provider's data policy.

Set the key in the process environment or in `$ELEPHA_HOME/.env`, then restart the
capture service. A value already present in the process environment takes precedence
over the file.

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

## Durable store size

`durable-capture-max-bytes` caps the total stored user prompts, assistant responses,
and path-bearing tool-call references kept by durable capture. It defaults to
1,073,741,824 bytes (1 GiB) and accepts a positive safe integer number of bytes.

This key is read from `$ELEPHA_HOME/config.json` by the capture service but is not a
CLI-managed setting: it does not appear in `elepha config list`, and `elepha config
get/set/unset` do not accept it. Add it to the top-level JSON object directly, keeping
any existing keys:

```json
{
    "durable-capture": true,
    "durable-capture-max-bytes": 1073741824
}
```

Restart the service after editing the value:

```console
elepha restart
```

When stored content exceeds the cap, elepha evicts the oldest sessions' copies,
starting with sessions whose original transcript can be opened and rebuilt. The
active session is not exempt if further space is required. Once a native session is
evicted, later turns and re-segmentation do not refill its durable copy; recall may
still use the source transcript while it remains readable. Invalid or absent values
leave the 1 GiB default in effect.
