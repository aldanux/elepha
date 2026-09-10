<p align="center">
  <picture>
    <source media="(prefers-color-scheme: dark)" srcset="docs/assets/elepha-light.svg" width="340" alt="elepha">
    <img src="docs/assets/elepha-dark.svg" width="340" alt="elepha">
  </picture>
</p>

<p align="center"><b>Local memory for Claude Code, Codex, OpenCode, and Kimi Code.</b></p>
<p align="center">Reads existing transcripts and serves context via MCP.</p>

<p align="center">
  <a href="https://www.npmjs.com/package/elepha"><img src="https://img.shields.io/node/v/elepha?color=2ab7d4" alt="Node.js version"></a>
  <a href="https://github.com/aldanux/elepha/actions/workflows/ci.yml"><img src="https://github.com/aldanux/elepha/actions/workflows/ci.yml/badge.svg" alt="CI"></a>
  <a href="LICENSE.md"><img src="https://img.shields.io/badge/license-MPL--2.0-2ab7d4" alt="License: MPL-2.0"></a>
</p>

## Overview

elepha reads eligible Claude Code, Codex, and Kimi Code session files, plus the local OpenCode session database,
indexes sessions from approved projects in one encrypted SQLite database, and exposes
past context through a read-only MCP server and `elepha:` commands in AI chat.

It does not modify source transcripts or repositories, send messages, or act on the
user's behalf. Transcript content and derived text are treated as inert data, never as
code, commands, or paths to execute. Capture, local search, and recall do not require
an AI provider key.

<!-- Demo video pending re-record. When the new clip is uploaded, uncomment and set the URL:
[Demo Video](PASTE_GITHUB_ATTACHMENT_URL_HERE)

_Video description: Recall a Codex session from Claude Code._
-->

## Get started

```console
npm install -g elepha
elepha install
elepha init
```

Codex requires manual approval of **elepha's** hooks through `/hooks` and may ask
again after a hook changes.

Full walkthrough: [getting-started guide](docs/getting-started.md).

## Supported tools and platforms

**elepha** supports:

- Claude Code CLI & desktop
- Codex CLI & desktop
- OpenCode
- Kimi Code

All supported tools use the same local memory database.

It runs on **macOS**, **Linux**, and **Windows through WSL**, on **Node.js 22.12+**. Native Windows is not supported; see the [getting-started guide](docs/getting-started.md) for exact requirements.

## How it works

1. **Capture:** A background service reads supported local session sources under approved project roots.
2. **Index:** Session metadata, summaries, and optional filtered durable copies are stored in the encrypted local database.
3. **Recall:** A read-only MCP server and `elepha:` commands surface past context in chat. Ask in plain language, or find and reopen
   sessions with `elepha:query` / `elepha:resume` / `elepha:last`.

Search uses stored titles, first prompts, rollups, and the filtered local full-text
index where durable capture is available. Session recall renders filtered content
from a complete durable copy or the source transcript. Results are bounded and
report when older turns were omitted.

## Recall in chat: ask in plain language

No keywords needed. When elepha's MCP tools are connected, ask in natural language and it
answers with the reasoning: what was decided, why, and what is still open, naming the
project and session it came from.

> do you remember why we moved the purchase button into a modal?

To find and reopen a session, the `elepha:` commands work in Claude Code, Codex, OpenCode, and Kimi Code chat. Full
guide: [docs/commands-in-ai-chat.md](docs/commands-in-ai-chat.md).

| Command                    | What it does                                                                       |
|----------------------------|------------------------------------------------------------------------------------|
| `elepha:query <text>`      | Find sessions from plain text across all approved projects.                        |
| `elepha:query:here <text>` | Same, current project only.                                                        |
| `elepha:last`              | Serve the newest turns from the most recent session.                               |
| `elepha:list[:<n>]`        | List recent sessions, numbered (up to 100).                                        |
| `elepha:resume:<n>`        | Load a session to continue it; the model presents a recap.                         |
| `elepha:info`              | Show status: sessions, capture, last session, and when a new version is available. |

## Storage

By default elepha stores derived memory only: session metadata and summaries. The full
conversation is read back from the original transcript on demand, so recall of an older
session depends on that file still being on disk.

Durable capture is opt-in and off by default. When on, elepha keeps its own filtered copy
of each turn inside the encrypted database: sanitized user prompts, assistant responses,
and path-bearing tool-call metadata. Raw JSONL, thinking, tool output, fetched content,
and raw tool arguments are excluded. That copy:

- survives the original transcript being deleted, so it can remain the only record;
- enables local full-text search of past content with no AI provider key;
- travels inside encrypted backups and project exports.

Durable capture is capped at 1 GiB in total; when full, the oldest sessions are evicted
first. Turn it on or off with:

```console
elepha config set durable-capture true
elepha config set durable-capture false
```

See [protecting and recovering memory](docs/storage.md).

## Privacy and consent

The encrypted database, search index, and recall service are local.

- Only projects and workspace folders you approve are eligible for capture.
- Original session files are never modified.
- The whole database is encrypted. Its key is stored in the OS secret store, or in a
  private key file where no usable secret store exists.
- Paranoid mode gates reads while capture continues. It protects a stolen or copied
  database and memory on a shared unlocked machine, not malware already running as
  your user.
- Revoking consent stops capture and hides retained memory for that scope without
  deleting it. Purge deletes selected memory and prevents its source transcript from
  being re-ingested.
- Memory lives at `$ELEPHA_HOME/elepha.db`, or `~/.elepha/elepha.db` by default.
  Current encrypted backups require the same installation key.

## Documentation

- [Getting started](docs/getting-started.md)
- [In-AI-chat command index](docs/commands-in-ai-chat.md)
- [CLI command index](docs/commands-cli.md)
- [Choosing what elepha may remember](docs/consent.md)
- [Controlling capture](docs/capture.md)
- [Configuration](docs/configuration.md)
- [Protecting and recovering memory](docs/storage.md)
- [Deleting memory](docs/purge.md)
- [Updating and maintenance](docs/maintenance.md)
- [Troubleshooting](docs/troubleshooting.md)

## License and links

**elepha** is open-source software licensed under the [Mozilla Public License 2.0 (MPL-2.0)](LICENSE.md).

- [Security policy](SECURITY.md)
- [Contributing guide](CONTRIBUTING.md)
