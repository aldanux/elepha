# CLI commands

Run these commands in a terminal. For commands typed inside Claude Code or Codex chat, see [docs/commands-in-ai-chat.md](commands-in-ai-chat.md).

Run `elepha <command> -h` for every flag. Purge and one-off maintenance or migration commands are dry-run by default; pass `--apply` to write.

## Install & remove

Full guide: [docs/getting-started.md](getting-started.md).

| Command            | Description                                                                                                                                         |
|--------------------|-----------------------------------------------------------------------------------------------------------------------------------------------------|
| `elepha install`   | Register hooks, MCP, the launcher, and background capture. More details in [docs/getting-started.md](getting-started.md#install-the-package).       |
| `elepha uninstall` | Remove elepha's integrations and service while keeping its database. More details in [docs/getting-started.md](getting-started.md#removing-elepha). |

## Consent

Full guide: [docs/consent.md](consent.md).

| Command                                                | Description                                                                                                                                                      |
|--------------------------------------------------------|------------------------------------------------------------------------------------------------------------------------------------------------------------------|
| `elepha init`                                          | Run first-time project discovery and consent onboarding. More details in [docs/consent.md](consent.md#first-run-onboarding).                                     |
| `elepha consent`                                       | Reopen the interactive project and folder consent picker. More details in [docs/consent.md](consent.md#change-consent-later).                                    |
| `elepha consent grant [path] [--here]`                 | Approve one root and backfill eligible existing transcripts. More details in [docs/consent.md](consent.md#change-consent-later).                                 |
| `elepha consent revoke [path] [--here]`                | Pause consent for one root without deleting memory. More details in [docs/consent.md](consent.md#change-consent-later).                                          |
| `elepha consent list`                                  | List every approved, denied, and pending root. More details in [docs/consent.md](consent.md#review-recorded-decisions).                                          |
| `elepha consent pending`                               | List roots awaiting a consent decision. More details in [docs/consent.md](consent.md#review-recorded-decisions).                                                 |
| `elepha consent prune [--apply] [--skip-confirmation]` | Preview or remove missing and now-refused consent-list entries without deleting memory. More details in [docs/consent.md](consent.md#prune-stale-consent-roots). |

## Capture

Full guide: [docs/capture.md](capture.md).

| Command                   | Description                                                                                                                                                 |
|---------------------------|-------------------------------------------------------------------------------------------------------------------------------------------------------------|
| `elepha projects [--all]` | List projects with captured memory; `--all` includes missing and temporary paths. More details in [docs/capture.md](capture.md#see-what-has-been-captured). |
| `elepha pause`            | Stop and disable background capture without changing consent or memory. More details in [docs/capture.md](capture.md#pause-and-resume-the-capture-service). |
| `elepha resume`           | Enable and start background capture for approved roots. More details in [docs/capture.md](capture.md#pause-and-resume-the-capture-service).                 |
| `elepha restart`          | Run the pause operation followed by the resume operation. More details in [docs/capture.md](capture.md#pause-and-resume-the-capture-service).               |

## Configuration

Full guide: [docs/configuration.md](configuration.md).

| Command                           | Description                                                                                                                                    |
|-----------------------------------|------------------------------------------------------------------------------------------------------------------------------------------------|
| `elepha config`                   | Open the interactive settings wizard. More details in [docs/configuration.md](configuration.md#interactive-settings).                          |
| `elepha config list`              | Print every effective setting and its source. More details in [docs/configuration.md](configuration.md#interactive-settings).                  |
| `elepha config get <key>`         | Print one effective setting value. More details in [docs/configuration.md](configuration.md#read-and-change-one-setting).                      |
| `elepha config set <key> <value>` | Store one setting override. More details in [docs/configuration.md](configuration.md#read-and-change-one-setting).                             |
| `elepha config unset <key>`       | Remove an override and return to the effective default. More details in [docs/configuration.md](configuration.md#read-and-change-one-setting). |

## Storage & backups

Full guide: [docs/storage.md](storage.md). Deletion guide: [docs/purge.md](purge.md).

| Command                                                                    | Description                                                                                                                                                                                                                                             |
|----------------------------------------------------------------------------|---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------|
| `elepha backup [--all \| --project <pathOrName>] [--out <path>] [--force]` | Export all memory or one project to a portable SQLite file. More details in [docs/storage.md](storage.md#create-a-backup).                                                                                                                              |
| `elepha restore [file] [--skip-confirmation]`                              | Replace the active database from a validated complete backup. More details in [docs/storage.md](storage.md#restore-the-complete-database).                                                                                                              |
| `elepha import [file] [--overwrite] [--skip-confirmation]`                 | Merge eligible backup sessions, optionally replacing matches. More details in [docs/storage.md](storage.md#merge-a-backup).                                                                                                                             |
| `elepha purge [scope] [--apply] [--skip-confirmation]`                     | Preview or delete memory using `--project <pathOrName>`, `--newer-than <durationOrDate>`, `--older-than <durationOrDate>`, `--external-agent-imports`, `--orphan`, `--revoked`, or `--all`. More details in [docs/purge.md](purge.md#choose-one-scope). |

## Maintenance

Full guide: [docs/maintenance.md](maintenance.md).

`[operator]` commands are hidden from the default `elepha -h`; run `elepha <command> -h` for their flags.

| Command                          | Description                                                                                                                                                    |
|----------------------------------|----------------------------------------------------------------------------------------------------------------------------------------------------------------|
| `elepha self-update`             | Update the global build, restart capture, migrate, verify, and roll back once on failure. More details in [docs/maintenance.md](maintenance.md#update-elepha). |
| `elepha reingest`                | **[operator]** Reprocess stored turns through current adapters and summarization. More details in [docs/maintenance.md](maintenance.md#reingest).              |
| `elepha rollup [--rebuild]`      | **[operator]** Compute current rollups or preview a stale-version rebuild. More details in [docs/maintenance.md](maintenance.md#rollup).                       |
| `elepha rekey-projects`          | **[operator]** Consolidate duplicate repository project rows. More details in [docs/maintenance.md](maintenance.md#rekey-projects).                            |
| `elepha sanitize`                | **[operator]** Neutralize shell-active syntax in legacy stored fields. More details in [docs/maintenance.md](maintenance.md#sanitize).                         |
| `elepha segment`                 | **[operator]** Preview re-segmentation, manual splits, or adjacent merges. More details in [docs/maintenance.md](maintenance.md#segment).                      |
| `elepha stats`                   | **[operator]** Report read-only ingestion and summarizer instrumentation. More details in [docs/maintenance.md](maintenance.md#stats).                         |
| `elepha backfill-rendered-chars` | **[operator]** Derive rendered character and turn counts from raw turns. More details in [docs/maintenance.md](maintenance.md#backfill-commands).              |
| `elepha backfill-session-titles` | **[operator]** Derive stored segment titles from transcript metadata or prompts. More details in [docs/maintenance.md](maintenance.md#backfill-commands).      |
| `elepha backfill-custom-titles`  | **[operator]** Capture Claude Code custom-title events. More details in [docs/maintenance.md](maintenance.md#backfill-commands).                               |
| `elepha backfill-session-fields` | **[operator]** Re-derive legacy session metadata from local transcripts. More details in [docs/maintenance.md](maintenance.md#backfill-commands).              |
| `elepha backfill-root-commits`   | **[operator]** Populate stable root-commit identity for legacy projects. More details in [docs/maintenance.md](maintenance.md#backfill-commands).              |

## Status & troubleshooting

Full guide: [docs/troubleshooting.md](troubleshooting.md).

| Command                    | Description                                                                                                                                                 |
|----------------------------|-------------------------------------------------------------------------------------------------------------------------------------------------------------|
| `elepha status`            | Print the quick daemon health and recent-ingestion summary. More details in [docs/troubleshooting.md](troubleshooting.md#quick-health-check).               |
| `elepha doctor`            | Run deep checks and repair a down managed daemon when possible. More details in [docs/troubleshooting.md](troubleshooting.md#deep-health-check-and-repair). |
| `elepha inspect <project>` | Print recent stored memory for one project. More details in [docs/troubleshooting.md](troubleshooting.md#inspect-recently-captured-memory).                 |
