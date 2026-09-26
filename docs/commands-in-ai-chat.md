# Commands in AI chat

Type these commands directly in Claude Code, Codex, or OpenCode chat. For terminal commands, see [docs/commands-cli.md](commands-cli.md).

Recall commands are read-only: elepha serves the result in the same turn. Actions return a terminal handoff instead of running privileged work in chat.

## Recall and navigation

This page is the full guide for in-chat recall commands.

| Command                  | Description                                                                                                                               |
|--------------------------|-------------------------------------------------------------------------------------------------------------------------------------------|
| `elepha:last`            | Serve the newest available turns from the most recent session.                                                                            |
| `elepha:query <q>`       | Search all consented projects and return a numbered list of matching sessions. `<q>` is free text: plain phrases work, not just keywords. |
| `elepha:query:here <q>`  | Same as `elepha:query`, but only the current project.                                                                                     |
| `elepha:list`            | List the five most recent session titles, numbered for selection.                                                                         |
| `elepha:list:<n>`        | List the last `n` session titles, where `n` is from 1 to 100.                                                                             |
| `elepha:list:<tool>`     | Filter recent sessions by tool: `codex`, `claude`, or `opencode`.                                                                         |
| `elepha:list:<n>:<tool>` | Apply both a 1–100 count and a tool filter, with the count before the tool.                                                               |
| `elepha:resume:<n>`      | Load the nth session to continue it; the model presents a recap.                                                                          |
| `elepha:info`            | Show elepha status: sessions here and total, capture state, the last session with its project, and any capture or new-version alert.      |
| `elepha:help`            | Show the in-chat command list.                                                                                                            |

**What a search looks at.** Search looks at session titles and how you opened each session; at what a session concluded
where it has a rollup; and, for sessions recorded with durable capture, at the stored filtered
conversation. It never reads raw transcripts, thinking, tool output, or fetched external
content, and it searches the local index, not the provider's files at query time. Opening a
session renders the newest available filtered turns from a complete durable copy or the
source transcript. Recall is bounded and reports when older turns were omitted.

**Free text, not just keywords.** `elepha:query` accepts plain phrases such as "the codex
token fix" or "when we changed the purchase button". Filler words are ignored and the
meaningful terms are matched. Match strictness is configurable with the `query-matching`
setting: under `strict` (the default) a query that returns nothing broadens to partial
matches and labels them, while `lax` broadens from the start. Set it with
`elepha config set query-matching lax`. See [docs/configuration.md](configuration.md).

**Find a session vs. answer a question.** `elepha:query` and `elepha:list` *find and list*
sessions for you to open with `elepha:resume`. To *answer* a natural-language question about
past work, the model calls elepha's `recall` MCP tool, which returns the relevant material
(decisions, the reasoning, and open items) with its provenance (project, tool, session,
date) so the model can answer in place. `recall` needs elepha's MCP tools connected; it is
not typed as an `elepha:` command. `elepha install` connects those MCP tools automatically
for detected Claude Code, Codex, and OpenCode installations. The `elepha:` commands on this
page work in all three.

## Guided continuity over MCP

For a continuity request, clients first find candidates with `list_sessions` or
`recall`, then inspect `get_session({ id, view: "capsule" })`. A capsule reads stored
metadata only: historical summary, newest recorded decisions, historical pending
items, recently recorded files, and coverage notices. It does not open transcripts
or load the episode's conversation. It excludes standing instructions and fits
within 8,000 characters, including framing and omission notices.

The capsule reports when its rollup does not cover newer stored turns. Without a
summary it may show the indexed opening document, which can already be truncated
and does not establish an outcome. Durable coverage is metadata, not a guarantee
that content can currently be read. Historical pending items are not a current agenda.

After deciding what the current task needs, the client can request either:

- `get_session({ id, query: "the decision to investigate" })`: selected evidence,
  limited to 4,000 characters. Selection prefers stored rollup material, then the
  indexed first interaction, then lexical excerpts; it is not arbitrary turn
  targeting, and a miss is inconclusive.
- `get_session({ id, last_n: 2 })`: a small newest-turn tail, bounded by the existing
  80,000-character body limit, with older-turn omissions reported.

Clients must not automatically retry with a whole episode when evidence is missing.
`view: "capsule"` cannot be combined with `query` or `last_n`; that returns
`invalid_selection`. Omitted `view` and `view: "content"` preserve existing retrieval.
Explicit `elepha:resume:<n>` and all other in-chat commands are unchanged.

## Maintenance

Full guide: [docs/maintenance.md](maintenance.md).

| Command         | Description                                                                                                                                     |
|-----------------|-------------------------------------------------------------------------------------------------------------------------------------------------|
| `elepha:update` | Return `→ Run (Terminal): elepha self-update`; it does not update in chat. More details in [docs/maintenance.md](maintenance.md#update-elepha). |
