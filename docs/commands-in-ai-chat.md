# Commands in AI chat

Type these commands directly in Claude Code, Codex, or OpenCode chat. For terminal commands, see [docs/commands-cli.md](commands-cli.md).

Recall commands are read-only: elepha injects the result into the same turn. Actions return a terminal handoff instead of running privileged work in chat.

## Recall and navigation

This page is the full guide for in-chat recall commands.

| Command                                            | Description                                                                                                                               |
|----------------------------------------------------|-------------------------------------------------------------------------------------------------------------------------------------------|
| `elepha:last`                                      | Inject the newest available turns from the most recent session.                                                                           |
| `elepha:query <q>`                                 | Search all consented projects and return a numbered list of matching sessions. `<q>` is free text: plain phrases work, not just keywords. |
| `elepha:query:here <q>`                            | Same as `elepha:query`, but only the current project.                                                                                     |
| `elepha:list`                                      | List the five most recent session titles, numbered for selection.                                                                         |
| `elepha:list:<n>`                                  | List the last `n` session titles, where `n` is from 1 to 100.                                                                             |
| `elepha:list:<tool>`                               | Filter recent sessions by tool: `codex`, `claude`, or `opencode`.                                                                         |
| `elepha:list:<n>:<tool>`                           | Apply both a 1–100 count and a tool filter, with the count before the tool.                                                               |
| `elepha:resume:<n>`                                | Load the nth session to continue it; the model presents a recap.                                                                          |
| `elepha:info`                                      | Show elepha status: sessions here and total, capture state, the last session with its project, and any capture or new-version alert.      |
| `elepha:help`                                      | Show the in-chat command list.                                                                                                            |

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

## Maintenance

Full guide: [docs/maintenance.md](maintenance.md).

| Command         | Description                                                                                                                                     |
|-----------------|-------------------------------------------------------------------------------------------------------------------------------------------------|
| `elepha:update` | Return `→ Run (Terminal): elepha self-update`; it does not update in chat. More details in [docs/maintenance.md](maintenance.md#update-elepha). |
