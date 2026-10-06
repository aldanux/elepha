# Troubleshooting

Start with the quick health line, move to the deep check when something is unhealthy,
and inspect one project's recent memory when the service looks healthy but captured
content is not what you expect.

## Quick health check

`elepha status` prints a concise daemon health summary: running, stuck, or not running,
the time of the most recent ingest, and the number of turns captured in the last 24
hours. It is the fastest way to distinguish an idle service from one that is not
producing a healthy heartbeat.

If capture is intentionally paused, the not-running state is expected. Use the runtime
controls in [Controlling capture](capture.md) when you want to change that state.

## Deep health check and repair

`elepha doctor` checks the daemon, Claude Code and Codex SessionStart and UserPromptSubmit
hooks, Claude Code, Codex, and OpenCode MCP
registrations, the OpenCode plugin where those tools are detected, database and migrations,
consent roots, managed launcher, and any interrupted installation state. It exits
successfully only when every required check passes.

When the managed daemon is down, doctor stops any stale service state, restarts it, and
waits for a healthy heartbeat. It does not rewrite missing or invalid installation
artifacts itself. For those repairs it gives the exact terminal handoff:

```text
→ Run (Terminal): elepha install
```

Codex hook approval is also manual; when that is the remaining problem, open Codex,
run `/hooks`, and approve both elepha hooks.

## Inspect recently captured memory

Use `elepha inspect <project>` to print recently captured memory for one project and
sanity-check the ingestion pipeline. The project argument may be a path, a path suffix,
or the display name shown by elepha. Each result includes the tool and turn index plus
stored decisions, touched files, and pending items when present.

The command shows ten recent turns by default. Use `-n <count>` or
`--limit <count>` to change that number:

```console
elepha inspect my-app --limit 25
```

If no project matches, elepha prints the known project paths so you can retry with a
more specific query. If the project is absent entirely, review its permission in
[Choosing what elepha may remember](consent.md); if it exists but ingest is stale, run
the deep health check above.

## Missing project directories and orphan cleanup

Use `elepha purge --orphan --details` to inspect associated, relocated,
chats that could not be safely classified, and chats with both missing and protected
project parts before considering deletion. A missing
provider transcript is not proof that project
memory is orphaned. Existing temporary directories are preserved.

Filesystem errors, ambiguous recorded relocation candidates and exhausted
inspection budgets preserve memory with an explicit diagnostic. Resolve the
access or ownership issue and obtain a new preview; errors never turn into
deletion authority. Mixed sessions remain intact until segment-scoped cleanup
can prevent resurrection without blocking valid siblings.

