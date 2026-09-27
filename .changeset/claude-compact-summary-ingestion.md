---
"elepha": patch
---

Claude Code: generated compact summaries (records marked
`isCompactSummary`) are no longer ingested as human turns, so they can
no longer make an otherwise empty session count as substantive.

A hidden manual command, `elepha repair-claude-compact-summaries --session
<native-id>`, previews summary-only rows already stored from a still-readable,
consented source transcript. `--apply` backs up the database and removes only
those previewed rows; continuation rows are listed but left untouched.
