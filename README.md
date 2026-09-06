<p align="center">
  <picture>
    <source media="(prefers-color-scheme: dark)" srcset="docs/assets/elepha-light.svg" width="340" alt="elepha">
    <img src="docs/assets/elepha-dark.svg" width="340" alt="elepha">
  </picture>
</p>

<p align="center"><b>Local memory for Claude Code and Codex, across CLI and desktop.</b></p>
<p align="center">Reads existing transcripts and serves context via MCP.</p>

<p align="center">
  <a href="https://www.npmjs.com/package/elepha"><img src="https://img.shields.io/node/v/elepha?color=2ab7d4" alt="Node.js version"></a>
  <a href="https://github.com/aldanux/elepha/actions/workflows/ci.yml"><img src="https://github.com/aldanux/elepha/actions/workflows/ci.yml/badge.svg" alt="CI"></a>
  <a href="LICENSE.md"><img src="https://img.shields.io/badge/license-MPL--2.0-2ab7d4" alt="License: MPL-2.0"></a>
</p>

## Overview

elepha reads eligible Claude Code and Codex session files already stored on disk,
indexes sessions from approved projects in one encrypted SQLite database, and exposes
past context through a read-only MCP server and `elepha:` commands in AI chat.

It does not modify source transcripts or repositories, send messages, or act on the
user's behalf. Transcript content and derived text are treated as inert data, never as
code, commands, or paths to execute. Capture, local search, and recall do not require
an AI provider key.

[Demo Video](https://github.com/user-attachments/assets/478a14aa-acb8-4a51-99d6-e809d0473280)

_Video description: Recall a Codex session from Claude Code._

## Get started

```console
npm install -g elepha
elepha install
elepha init
```

Codex requires manual approval of **elepha's** hooks through `/hooks` and may ask
again after a hook changes. Then open a supported tool and type `elepha:last`.

Full walkthrough: [getting-started guide](docs/getting-started.md).

## Supported tools and platforms

**elepha** supports Claude Code CLI and the Claude desktop Code tab, plus Codex CLI
and Codex desktop. All four surfaces use the same local memory database.

It runs on **macOS**, **Linux**, and **Windows through WSL**, on **Node.js 22.12+**. Native Windows is not supported; see the [getting-started guide](docs/getting-started.md) for exact requirements.

Durable capture is opt-in and off by default. When enabled, it stores sanitized user
prompts, assistant responses, and path-bearing tool-call metadata in the encrypted
database. Raw JSONL, thinking, tool output, fetched content, and raw tool arguments
are excluded. See [protecting and recovering memory](docs/storage.md).

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

## How it works

1. **Capture.** A background service reads supported session files under approved project roots.
2. **Index.** Session metadata, summaries, and optional filtered durable copies are stored in the local database.
3. **Recall.** MCP exposes read-only project, session, and content lookup. `elepha:query`, `elepha:select:<n>`, and `elepha:last` provide the same context inside supported chats.

Search uses stored titles, first prompts, rollups, and the filtered local full-text
index where durable capture is available. Session recall renders filtered content
from a complete durable copy or the source transcript. Results are bounded and
report when older turns were omitted.

Full list: [docs/commands-in-ai-chat.md](docs/commands-in-ai-chat.md).

## In-AI-chat commands

| Command                            | What it does                                                            |
|------------------------------------|-------------------------------------------------------------------------|
| `elepha:last`                      | Inject the newest available turns from the most recent session.         |
| `elepha:list`                      | List the five most recent sessions, numbered.                           |
| `elepha:list:<n>`                  | List the last `n`, up to 100.                                           |
| `elepha:query <search terms>`      | Search every approved project.                                          |
| `elepha:query:here <search terms>` | Search the current project only.                                        |
| `elepha:select:<n>`                | Inject the available turns for session `n` from the last list or query. |

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

## License and links

**elepha** is open-source software licensed under the [Mozilla Public License 2.0 (MPL-2.0)](LICENSE.md).

- [Security policy](SECURITY.md)
- [Contributing guide](CONTRIBUTING.md)
