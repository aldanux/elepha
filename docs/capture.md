# Controlling capture

Capture is the runtime state of elepha's background ingestion service. Pausing that
service stops all new ingestion without changing which projects have consent or
deleting anything already remembered. When capture resumes, only approved roots are
eligible.

## Kimi Code

Kimi capture watches `~/.kimi-code/sessions` (or `$KIMI_CODE_HOME/sessions`). The
literal `state.json.cwd`, with the session index as fallback, binds each session to
its consented project. Only `agents/main/wire.jsonl` is captured. Completed answer
text is reduced across steps; reasoning, failed empty turns, injection-origin
messages, and inherited fork history are excluded.

Normal appends resume from an identity-checked byte cursor. Undo, repair, and atomic
resume rewrites trigger reconciliation: unchanged turns keep their stored identities;
changed or removed turns and their derived rollups and durable copies are invalidated
transactionally. New summaries then fill the changed suffix. An interrupted rebuild
can temporarily leave less memory; the next scan resumes without duplicating turns.
Model aliases and protocol version are captured per turn. The unrecorded CLI build
version stays `unknown`.

Disable this provider with `elepha config set capture-kimi off`, then restart the
capture service. See [Kimi capture verification](kimi-capture-verification.md).

## Durable capture

Durable capture is opt-in and off by default. Enable it through the supported config
command, then restart the background service so it reads the new setting:

```console
elepha config set durable-capture on
elepha restart
```

When enabled, elepha persists a sanitized copy of each eligible turn inside its
encrypted database. The copy keeps user prompts, assistant responses, and the names
and file paths of tool calls that reference paths. It never stores the raw JSONL,
thinking, tool output, fetched content, or tool arguments. Filtering and storage are
local and do not require an AI provider, so conversation search and session revival
can use a complete filtered copy even after the source transcript is deleted.

After the service restarts, elepha also backfills eligible sessions already in the
database when their source transcripts remain readable. Disabling durable capture
stops future copies after the next restart; it does not delete copies already stored.
Use [Deleting memory](purge.md) when deletion is intended.

The schema's exact coverage-state vocabulary is `complete`, `complete_truncated`,
`disabled_gap`, `backfilling`, `source_unavailable`, `parse_error`, `revoked`,
`incognito`, and `evicted`. Complete coverage can serve without the source transcript;
`complete_truncated` means one or more stored turns hit the enforced content bound.
`disabled_gap`, `backfilling`, `source_unavailable`, and `parse_error` describe an
incomplete backfill. `evicted` means the size cap removed the copy. `revoked` and
`incognito` are accepted schema values; current purge and incognito paths instead
delete the copy, its coverage row, and its indexed search terms.

The durable store defaults to a 1 GiB cap. When it binds, elepha evicts the oldest
recoverable session copies first; the active session is not exempt if further space
is required. An evicted native session remains evicted across later turns and
re-segmentation instead of silently refilling the durable store. Recall can still use
its source transcript while that file remains readable. See
[Protecting and recovering memory](storage.md#durable-conversation-copies) and
[Configuration](configuration.md#durable-store-size).

## See what has been captured

Run `elepha projects` to list projects with captured memory or effective approval.
Captured projects include their stored session count; approved repositories without
memory are marked `no sessions yet`. When a repository has moved, the command prefers
its current live path over a missing stored path. The default view leaves out temporary
projects and paths that no longer exist. Use `elepha projects --all` when diagnosing old
records and you also need those missing or temporary paths, clearly marked in the
output.

This command is read-only; it does not grant or revoke permission. Manage that
separately in [Choosing what elepha may remember](consent.md).

## Pause and resume the capture service

`elepha pause` disables and stops the installed background service. It is useful when
you want a global capture break or before a storage operation that requires exclusive
access to the database. Running it again while already paused is harmless.

`elepha resume` enables and starts the service again. Consent decisions and existing
memory remain unchanged across both operations, so resuming does not widen the set of
projects elepha may read.

Use `elepha restart` for a one-shot restart. It is an alias that runs the same pause
operation followed by the same resume operation; it adds no new state or permission
behavior.

These controls are available on macOS and Linux after installation. To check whether
the service is healthy rather than changing its state, see the
[quick health check](troubleshooting.md#quick-health-check).
