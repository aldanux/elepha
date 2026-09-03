<p align="center">
  <picture>
    <source media="(prefers-color-scheme: dark)" srcset="docs/assets/elepha-light.svg" width="340" alt="elepha">
    <img src="docs/assets/elepha-dark.svg" width="340" alt="elepha">
  </picture>
</p>

<p align="center"><b>Your tools can read the diff. They cannot read why.</b></p>
<p align="center">elepha is a local memory layer over the session transcripts Claude Code and Codex already write to disk. It keeps the reasoning and gives it back inside the chat you are already in.</p>

<p align="center">
  <a href="#supported-tools-and-platforms"><img src="https://img.shields.io/badge/supported%20tools-Claude%20Code%20(CLI%20%C2%B7%20Desktop)%20%C2%B7%20Codex%20(CLI%20%C2%B7%20Desktop)-2ab7d4" alt="supported tools: Claude Code (CLI, Desktop), Codex (CLI, Desktop)"></a>
  <br>
  <a href="https://www.npmjs.com/package/elepha"><img src="https://img.shields.io/npm/v/elepha?color=2ab7d4" alt="npm version"></a>
  <a href="https://github.com/aldanux/elepha/actions/workflows/ci.yml"><img src="https://github.com/aldanux/elepha/actions/workflows/ci.yml/badge.svg" alt="CI"></a>
  <a href="#supported-tools-and-platforms"><img src="https://img.shields.io/badge/platform-macOS%20%C2%B7%20Linux%20%C2%B7%20WSL-2ab7d4" alt="platform"></a>
  <a href="LICENSE.md"><img src="https://img.shields.io/badge/license-MPL--2.0-2ab7d4" alt="License: MPL-2.0"></a>
</p>

[elepha demo](https://github.com/user-attachments/assets/478a14aa-acb8-4a51-99d6-e809d0473280)

_The elepha demo video shows Codex stopping mid-task, then Claude Code resuming that same session and explaining why an earlier approach was rejected, from a conversation it never had._

## What elepha does

- **The part git does not keep** — Commits and diffs record what changed. The transcript
  holds why: the approach you rejected, the constraint that forced it, the thing you left
  unfinished.
- **Nothing to write** — No notes, no vault, no file to keep current. The transcripts
  already exist; **elepha** reads them.
- **Not a wrapper** — Keep using your tool directly; **elepha** never sits in front of it.
- **Repository-clean** — Adds nothing to your repositories, and never modifies the
  original transcripts.

## Get started

```console
npm install -g elepha
elepha install
elepha init
```

Codex needs a one-time approval of **elepha's** hooks through `/hooks`. Then open a
supported tool and type `elepha:last`.

Full walkthrough: [getting-started guide](docs/getting-started.md).

## Supported tools and platforms

**elepha** supports **Claude Code** and **Codex**, each in both the desktop app and the CLI, with memory shared across all of them. Support
for more transcript-writing AI coding tools is planned.

It runs on **macOS**, **Linux**, and **Windows through WSL**, with **Node.js 22 or newer**. Native Windows is not supported.

The original transcripts are never modified, so memory can always be rebuilt. That matters while **elepha** is still pre-1.0: its storage
schema and command surface can change between releases.

## Documentation

- [Getting started](docs/getting-started.md)
- [In-AI-chat command index](docs/commands-in-ai-chat.md)
- [CLI command index](docs/commands-cli.md)
- [Choosing what elepha may remember](docs/consent.md)
- [Controlling capture](docs/capture.md)
- [Configuration](docs/configuration.md)
- [Protecting and moving memory](docs/storage.md)
- [Deleting memory](docs/purge.md)
- [Updating and maintenance](docs/maintenance.md)
- [Troubleshooting](docs/troubleshooting.md)

## How it works

1. **Reads local transcripts in the background.** It watches the session files that supported tools already write, limited to projects and folders you approve.
2. **Builds one searchable local memory.** It organizes eligible sessions in one local database.
3. **Recalls inside your current chat.** Find a session with `elepha:query`, open it with `elepha:select:<n>`, or go straight to the latest with `elepha:last`. Search looks at session titles and how you opened each session; at what a session concluded where it has a rollup; and, for sessions recorded with durable capture, at the stored filtered conversation. It never reads raw transcripts, thinking, tool output, or fetched external content, and it searches the local index, not the provider's files at query time. Opening a session brings the whole conversation back.

<!-- In-chat demo placeholder: show elepha:list and elepha:last recalling a real session. -->

Full list: [docs/commands-in-ai-chat.md](docs/commands-in-ai-chat.md).

## In-AI-chat commands

| Command                            | What it does                                                   |
|------------------------------------|----------------------------------------------------------------|
| `elepha:last`                      | Inject the most recent session and continue where you stopped. |
| `elepha:list`                      | List the five most recent sessions, numbered.                  |
| `elepha:list:<n>`                  | List the last `n`, up to 100.                                  |
| `elepha:query <search terms>`      | Search every approved project.                                 |
| `elepha:query:here <search terms>` | Search the current project only.                               |
| `elepha:select:<n>`                | Inject session `n` from the last list or query.                |

## When it earns its place

**Someone asks why it is built this way.** Six months on, the commit says what changed and
the diff says how. Neither says that the obvious approach was tried first and abandoned for
a reason that still applies. That conversation happened, and it is still on your disk.

**You have solved this before, in another project.** You remember deciding it. You do not
remember where, or when, or under which repository. It is one session among hundreds, and
the tool you are sitting in has never seen a single one of them.

## Privacy and consent

**elepha** runs entirely on your machine: capture, storage, search, and recall are local, with no hosted memory service. The one exception
is explicit; if you configure an external synthesis provider, the turns sent for synthesis are handled under that provider's data policy.

- **Consent-gated** — you choose which projects or workspace folders **elepha** may capture.
- **Transcript-safe** — the original session files are never modified.
- **It can forget** — purge a transcript and it stays purged, revoke a folder, or work with capture off.
- **One local database** — memory lives at `~/.elepha/elepha.db` and can be rebuilt from retained transcripts; back it up to keep consent
  and deletion history.

## License and links

**elepha** is open-source software licensed under the [Mozilla Public License 2.0 (MPL-2.0)](LICENSE.md).

- [Security policy](SECURITY.md)
- [Contributing guide](CONTRIBUTING.md)
