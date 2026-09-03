# elepha

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
