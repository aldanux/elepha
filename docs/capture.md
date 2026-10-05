# Controlling capture

Capture is the runtime state of elepha's background ingestion service. Pausing that
service stops all new ingestion without changing which projects have consent or
deleting anything already remembered. When capture resumes, only approved roots are
eligible.

## Durable capture

For Claude Code and Codex, durable capture is automatic. Every new turn that elepha
captures from an approved root also persists a sanitized copy inside its encrypted
database, with no extra setting, prompt, or re-grant. The copy keeps user prompts,
assistant responses, and the names and file paths of tool calls that reference paths.
It never stores the raw JSONL, thinking, tool output, fetched content, or tool
arguments. Filtering and storage are local and need neither an AI provider nor
Memory-Plus, so conversation search and session revival can use a complete filtered
copy even after the source transcript is deleted.

Automatic copies follow the same eligibility as capture itself: the per-tool capture
settings, consent, incognito, and the approved physical checkout still decide whether
a turn is captured at all.

Capture reads each transcript incrementally from where it last stopped. A Codex
session may declare its working directory only once, at the top of its transcript;
elepha remembers which transcript records set that context, and how that session marks
the start of each prompt, and reads those records again, verifying they are
unchanged, whenever it continues, including after a restart. Continuing never rereads
the transcript from the beginning. If one of those records is rewritten, elepha stops
reading that transcript instead of guessing its working directory from what it stored
earlier. For a position stored by an earlier version, elepha first rebuilds that
context from the transcript in small background steps; the session's new turns are
captured once that finishes, and nothing is captured twice.

The `durable-capture` setting remains readable for compatibility and is off by
default. It is the opt-in for new OpenCode copies. Change it through the
supported config command, then restart the background service so it reads the new
setting:

```console
elepha config set durable-capture on
elepha restart
```

Turning the setting off stops future OpenCode copies after the next restart and
keeps copies already stored. Use [Deleting memory](purge.md) when deletion is intended.

The schema's exact coverage-state vocabulary is `complete`, `complete_truncated`,
`disabled_gap`, `parse_error`, `revoked`, `incognito`, and `evicted`. Complete coverage can serve without the source transcript;
`complete_truncated` means one or more stored turns hit the enforced content bound.
Ordinary Claude Code and Codex content requests require current whole-session coverage
and never inspect the provider transcript to fill gaps. They report the actual retained
coverage, freshness, decoding or read-budget reason. Authorized filtered-empty content
is distinct from unavailable evidence; individually current interactions and stored
summaries retain their narrower scope.
`disabled_gap` and `parse_error` describe incomplete coverage: copies are missing or
ordinary ingestion found malformed or unrecognized transcript records. `evicted`
marks a session whose copies an earlier release's per-copy size cap removed; current releases never evict a copy. `revoked` and
`incognito` are accepted schema values; current purge and incognito paths instead
delete the copy, its coverage row, and its indexed search terms.

Durable copies count toward elepha's fixed 5 GB live-memory capacity. At capacity,
live capture removes whole oldest sessions rather than individual copies. See
[Live-memory capacity](storage.md#live-memory-capacity).

A task-state manifest is published from its
still-unconsumed hook request, including after a restart: the daemon re-reads the
reporting turn from the transcript and publishes only while that turn still matches
the copy elepha retained when it was captured, checked again immediately before it
is written. Appending to the transcript is fine; rewriting or removing the reporting
record, even while the manifest is being verified, leaves the request unpublished.
Pending requests are worked through in small passes that yield to live capture, and a
long transcript is read across several passes.

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
