---
"elepha": minor
---

Provide bounded historical evidence for direct answers through automatic
recall and optional query-based `get_session` expansion, with provenance
and explicit coverage limits. Preserve provider-declared Codex final
answers and withhold paired final-answer evidence when the complete set
is unavailable or exceeds the evidence budget; a miss is inconclusive.

Recognize Codex guardian reviews, reconcile previously classified
sessions, and exclude guardian activity from user-facing memory.

Keep the daemon-start spinner responsive and reduce repetitive embedding
indexing messages for ineligible or empty sessions.
