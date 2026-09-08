# elepha

## 0.5.0

### Highlights

- **Ask your past work in plain language.** The new `recall` MCP tool answers a natural-language question like "do you remember why we moved the purchase button" with the decisions, the reasoning, and open items, each tagged with its project and session, and it works with no AI key of your own.
- **Cross-tool resume with `elepha:resume`.** `elepha:select` becomes `elepha:resume:<n>` and loads the whole session so you can continue it in another tool, with the model presenting a recap instead of pasting the turns back.
- **Nothing is injected unless you ask.** The automatic session-start brief is gone; type `elepha:info` for status on demand (sessions here and total, capture state, last session, and update notices).
- **Steadier memory.** A transferred or renamed repository consolidates instead of splitting in two, capture-paused operations no longer throw a spurious 60s error, and session counts now match across `elepha projects`, `elepha:info`, `elepha:list`, and `elepha:query`.

### Changes

- Add the consent-scoped MCP `recall` tool for provenance-backed historical memory material by [@aldanux](https://github.com/aldanux) in [#73](https://github.com/aldanux/elepha/pull/73)
- Rename `elepha:select:<n>` to `elepha:resume:<n>` (no alias) and serve the whole filtered session for cross-tool resume, with a recap instruction so the model presents where the work left off, the decisions and why, and open items, instead of pasting turns by [@aldanux](https://github.com/aldanux) in [#76](https://github.com/aldanux/elepha/pull/76)
- Remove the SessionStart auto-brief and its startup-mode config; add `elepha:info` for on-demand status (sessions here/total, capture state, last session with its project). Operational daemon-health and update notices still surface at session start by [@aldanux](https://github.com/aldanux) in [#77](https://github.com/aldanux/elepha/pull/77)

- Show the project in `elepha:list` and `elepha:query` result-row tags by [@aldanux](https://github.com/aldanux) in [#75](https://github.com/aldanux/elepha/pull/75)
- Refine the `elepha:info` status line for readability: labelled `capture:` and `sessions:` segments, a constant `X here / Y total` count, and `last session in project: <name> - <age> ago in <tool surface>` by [@aldanux](https://github.com/aldanux) in [#79](https://github.com/aldanux/elepha/pull/79)
- Fix `rekey-projects` so a transferred or renamed repository (changed git remote) consolidates: group project rows by their live-resolved git root before the mutable git remote, keeping fork-safety by [@aldanux](https://github.com/aldanux) in [#78](https://github.com/aldanux/elepha/pull/78)
- Recognize Codex token usage records without emitting unknown-type warnings by [@aldanux](https://github.com/aldanux) in [#74](https://github.com/aldanux/elepha/pull/74)
- Use Codex's AI-generated thread names for stored session titles by [@aldanux](https://github.com/aldanux) in [#72](https://github.com/aldanux/elepha/pull/72)
- Docs: lead the README with natural-language recall, document that `elepha:query` takes free text with configurable strict/lax matching, distinguish finding sessions from the `recall` MCP tool that answers questions, document `elepha:info`, and comment out the demo video pending a re-record by [@aldanux](https://github.com/aldanux) in [#81](https://github.com/aldanux/elepha/pull/81)
- Fix a spurious "Capture daemon did not become healthy within 60s" error after capture-paused operations (backfill, purge, backup, rekey, self-update): release the CLI's database and await the daemon resume so the restarted daemon can migrate, open, and heartbeat without a competing connection by [@aldanux](https://github.com/aldanux) in [#82](https://github.com/aldanux/elepha/pull/82)
- Count sessions consistently: `elepha projects` now reports the same substantive (searchable and listable) session count as `elepha:info`, `elepha:list`, and `elepha:query`, instead of a raw row count by [@aldanux](https://github.com/aldanux) in [#83](https://github.com/aldanux/elepha/pull/83)

## 0.4.6

- Automatically retire verified stale MCP readers from npm-replaced Elepha packages during global upgrades and blocked install migrations. This lets 0.4.5 self-update complete and makes the one-time 0.3.x npm install path work without closing coding clients, while preserving database locking and leaving unrelated processes untouched by [@aldanux](https://github.com/aldanux) in [#68](https://github.com/aldanux/elepha/pull/68)

## 0.4.5

### Updating from 0.3.x

The 0.4.5 instructions below did not handle an MCP process left running from the
previous package. This is corrected in 0.4.6. Once 0.4.6 or later is available,
perform the one-time upgrade from any terminal; Claude Code and Codex may remain open:

```console
npm install -g elepha@latest
elepha install
elepha doctor
```

Existing memory and consent remain unchanged. Future updates can use `elepha self-update`.

- Close the temporary consent reader during self-update and present concise rollback diagnostics by [@aldanux](https://github.com/aldanux) in [#63](https://github.com/aldanux/elepha/pull/63)
- Stop the managed daemon when the global package is removed, and restart it when the installed version changes by [@aldanux](https://github.com/aldanux) in [#66](https://github.com/aldanux/elepha/pull/66)

## 0.4.4

- Prevent encrypted database migration from rejecting historical managed backups when read-only verification is required by [@aldanux](https://github.com/aldanux) in [#58](https://github.com/aldanux/elepha/pull/58)
- Release SQLite after each MCP tool call so connected coding clients do not block database migration or self-update, and explain how to retire readers left by an older installation by [@aldanux](https://github.com/aldanux) in [#60](https://github.com/aldanux/elepha/pull/60)

## 0.4.3

- Allow database encryption migration to wait briefly for a retiring pre-update WAL reader before changing journal mode by [@aldanux](https://github.com/aldanux) in [#57](https://github.com/aldanux/elepha/pull/57)

## 0.4.2

- Show the supported Node.js version in the README badge by [@aldanux](https://github.com/aldanux) in [#54](https://github.com/aldanux/elepha/pull/54)

## 0.4.1

- Keep self-update compatible with 0.3.x launchers and show terminal progress while update and daemon health commands run by [@aldanux](https://github.com/aldanux) in [#52](https://github.com/aldanux/elepha/pull/52)

## 0.4.0

Elepha 0.4.0 introduces opt-in durable capture and encrypted local storage. Approved sessions can retain a bounded, searchable filtered copy after the original transcript disappears. This release also adds encrypted backup and restore, purge and incognito deletion, optional paranoid locking, automatic migration of existing plaintext databases, and moved-project recovery. Node.js 22.12.0 or newer is required.

### Changes

- Purge and incognito remove the stored conversation copy, including its search index by [@aldanux](https://github.com/aldanux) in [#50](https://github.com/aldanux/elepha/pull/50)
- Add opt-in durable capture: persist the filtered turns of a session locally by [@aldanux](https://github.com/aldanux) in [#50](https://github.com/aldanux/elepha/pull/50)
- Backfill durable-capture copies for sessions ingested before it was enabled by [@aldanux](https://github.com/aldanux) in [#50](https://github.com/aldanux/elepha/pull/50)
- Serve a captured session from its local copy, so it revives after the source transcript is gone by [@aldanux](https://github.com/aldanux) in [#50](https://github.com/aldanux/elepha/pull/50)
- Encrypt same-machine backups and project exports under the installation key, restore them keyed, and refuse portable encrypted import for now by [@aldanux](https://github.com/aldanux) in [#50](https://github.com/aldanux/elepha/pull/50)
- Search the stored conversation of durably captured sessions, with no AI provider by [@aldanux](https://github.com/aldanux) in [#50](https://github.com/aldanux/elepha/pull/50)
- Bound the durable-capture store to a configurable total size (default 1 GiB), evicting the oldest recoverable sessions first by [@aldanux](https://github.com/aldanux) in [#50](https://github.com/aldanux/elepha/pull/50)
- Add optional paranoid mode, a terminal-only passphrase gate for memory reads that leaves capture running while locked by [@aldanux](https://github.com/aldanux) in [#50](https://github.com/aldanux/elepha/pull/50)
- Encrypt new elepha databases at rest and atomically migrate existing plaintext primaries in default mode. Raises the minimum Node.js to 22.12.0 by [@aldanux](https://github.com/aldanux) in [#50](https://github.com/aldanux/elepha/pull/50)

- Map runtime stack traces back to embedded TypeScript source locations by [@aldanux](https://github.com/aldanux) in [#50](https://github.com/aldanux/elepha/pull/50)
- Show moved projects at their current path and list approved repositories before their first captured session by [@aldanux](https://github.com/aldanux) in [#50](https://github.com/aldanux/elepha/pull/50)

## 0.3.2

- Make `elepha:query` match session summaries, recorded decisions, and pending items by [@aldanux](https://github.com/aldanux) in [#46](https://github.com/aldanux/elepha/pull/46)
- Lead with the reasoning elepha preserves and update the npm package description by [@aldanux](https://github.com/aldanux) in [#45](https://github.com/aldanux/elepha/pull/45)

## 0.3.1

- Lead each changelog entry with what changed, and put the pull request and author after it by [@aldanux](https://github.com/aldanux) in [#25](https://github.com/aldanux/elepha/pull/25)
- Point user-facing repository and documentation links at `aldanux/elepha` by [@aldanux](https://github.com/aldanux) in [#39](https://github.com/aldanux/elepha/pull/39)
- Report when `elepha self-update` is already on the latest version instead of printing an update from a version to itself by [@vsolano9](https://github.com/vsolano9) in [#36](https://github.com/aldanux/elepha/pull/36)

## 0.3.0

- [#19](https://github.com/elepha-app/elepha/pull/19) [`8d94840`](https://github.com/elepha-app/elepha/commit/8d948400c9a368f4ec825850d9bf9f05bc0a544d) Thanks [@aldanux](https://github.com/aldanux)! - Populate existing sessions' first-prompt search index automatically in the background after the daemon starts.

- [#23](https://github.com/elepha-app/elepha/pull/23) [`0574e14`](https://github.com/elepha-app/elepha/commit/0574e14fd37b0c5427a5dba00e7e299f6ad7ff88) Thanks [@aldanux](https://github.com/aldanux)! - Derive existing session titles from user-written prose while skipping command wrappers, paths, code, repeated boilerplate, and Codex history-review preambles.

- [#16](https://github.com/elepha-app/elepha/pull/16) [`0ac2ffa`](https://github.com/elepha-app/elepha/commit/0ac2ffa5c70788f632f7b53897552e9bc1f65645) Thanks [@aldanux](https://github.com/aldanux)! - Show labelled partial-term results when strict recall finds no complete match.

- [#17](https://github.com/elepha-app/elepha/pull/17) [`21f3d79`](https://github.com/elepha-app/elepha/commit/21f3d796d6c6632cf3da82215a4224eda0c43796) Thanks [@aldanux](https://github.com/aldanux)! - Align interactive wizard questions with their options and actual capture behavior.

- [#14](https://github.com/elepha-app/elepha/pull/14) [`0592d5d`](https://github.com/elepha-app/elepha/commit/0592d5d4a3e76aae21ddfea85913513d3faec21c) Thanks [@aldanux](https://github.com/aldanux)! - Project-scoped recall misses now name the searched project and show how to search every project.

- [#12](https://github.com/elepha-app/elepha/pull/12) [`edd68ca`](https://github.com/elepha-app/elepha/commit/edd68cafe8a57804b453d638064eb71976c8900d) Thanks [@aldanux](https://github.com/aldanux)! - Clarify that purge date filters use session ingestion time.

- [#20](https://github.com/elepha-app/elepha/pull/20) [`b08cf83`](https://github.com/elepha-app/elepha/commit/b08cf83e7f2dd67b2ef57717b733a5d690017647) Thanks [@aldanux](https://github.com/aldanux)! - Stop warning about Claude Code's `cost-state` transcript lines, which carry no conversation content.

- [#18](https://github.com/elepha-app/elepha/pull/18) [`7a05ada`](https://github.com/elepha-app/elepha/commit/7a05ada597753a2ee44087d40b1c40ed9b4e0742) Thanks [@aldanux](https://github.com/aldanux)! - Drop the shell prompt character from the operator hand-off line, so the text can be copied and run as-is.

- [#12](https://github.com/elepha-app/elepha/pull/12) [`edd68ca`](https://github.com/elepha-app/elepha/commit/edd68cafe8a57804b453d638064eb71976c8900d) Thanks [@aldanux](https://github.com/aldanux)! - Show approved projects in `elepha projects` before their first session is captured.

- [#22](https://github.com/elepha-app/elepha/pull/22) [`903fcab`](https://github.com/elepha-app/elepha/commit/903fcab62b069c5ea8152cd982b024868ce49f80) Thanks [@aldanux](https://github.com/aldanux)! - Say what recall search looks at, and that opening a session brings back the whole conversation.

- [#12](https://github.com/elepha-app/elepha/pull/12) [`edd68ca`](https://github.com/elepha-app/elepha/commit/edd68cafe8a57804b453d638064eb71976c8900d) Thanks [@aldanux](https://github.com/aldanux)! - Stop showing update notices after the named elepha version is installed.

<!-- Managed by @changesets/cli. Do not edit entries below by hand, run `npx changeset` per change and `npx changeset version` to release. -->

## 0.2.0

- 09ec4ac: Corrected duplicated and overly generic package keywords.

## 0.1.0

- First public release.
