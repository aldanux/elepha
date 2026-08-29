# Controlling capture

Capture is the runtime state of elepha's background ingestion service. Pausing that
service stops all new ingestion without changing which projects have consent or
deleting anything already remembered. When capture resumes, only approved roots are
eligible.

## See what has been captured

Run `elepha projects` to list projects with captured memory and their session counts.
The default view leaves out temporary projects and paths that no longer exist. Use
`elepha projects --all` when diagnosing old records and you also need those missing or
temporary paths, clearly marked in the output.

This command reports stored projects; it does not grant or revoke permission. Manage
that separately in [Choosing what elepha may remember](consent.md).

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
