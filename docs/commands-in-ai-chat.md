# Commands in AI chat

Type these commands directly in Claude Code or Codex chat. For terminal commands, see [docs/commands-cli.md](commands-cli.md).

Recall commands are read-only: elepha injects the result into the same turn. Actions return a terminal handoff instead of running privileged work in chat.

## Recall and navigation

This page is the full guide for in-chat recall commands.

| Command                                            | Description                                                                      |
|----------------------------------------------------|----------------------------------------------------------------------------------|
| `elepha:last`                                      | Inject the most recent session's turns so you can continue where you stopped.    |
| `elepha:query <q>`                                 | Search all consented projects and return a numbered list of matching sessions.   |
| `elepha:query:here <q>`                            | Search only the current project and return a numbered list of matching sessions. |
| `elepha:list`                                      | List the five most recent session titles, numbered for selection.                |
| `elepha:list:<n>`                                  | List the last `n` session titles, where `n` is from 1 to 100.                    |
| `elepha:list:codex` / `elepha:list:claude`         | List recent sessions from only Codex or Claude Code.                             |
| `elepha:list:<n>:codex` / `elepha:list:<n>:claude` | Apply both a 1–100 count and a tool filter, with the count before the tool.      |
| `elepha:select:<n>`                                | Inject session `n` from the most recently shown query or list results.           |
| `elepha:help`                                      | Show the in-chat command list.                                                   |

**What a search looks at.** Search looks at session titles and how you opened each session; at what a session concluded
where it has a rollup; and, for sessions recorded with durable capture, at the stored filtered
conversation. It never reads raw transcripts, thinking, tool output, or fetched external
content, and it searches the local index, not the provider's files at query time. Opening a
session brings the whole conversation back.

## Maintenance

Full guide: [docs/maintenance.md](maintenance.md).

| Command         | Description                                                                                                                                     |
|-----------------|-------------------------------------------------------------------------------------------------------------------------------------------------|
| `elepha:update` | Return `→ Run (Terminal): elepha self-update`; it does not update in chat. More details in [docs/maintenance.md](maintenance.md#update-elepha). |
