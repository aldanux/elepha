---
"elepha": patch
---

Fix Claude task-state authentication when transcripts contain `api-request` or
`api-request-blob` metadata, keeping their copied messages and tool events inert.
