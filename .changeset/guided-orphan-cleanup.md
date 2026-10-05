---
"elepha": minor
---

Add bounded shared orphan classification for Claude Code and Codex native sessions and `purge --orphan --details` diagnostics. Existing temporary directories, relocation evidence, filesystem failures, incomplete inspection and mixed native sessions preserve memory.

Orphan deletion reuses the backed-up transactional purge lifecycle and freezes exact ownership, siblings, retained state and rule scope. Native tombstones prevent resurrection without suppressing protected siblings. Noninteractive standalone orphan apply requires explicit `--skip-confirmation`.

Orphan chat-rule deletion is limited to confirmed host/native identities across all their verified rule associations. Other chats, including rule-only chats, retain their rules, owner projects and required project standing rules; association changes invalidate the frozen plan. Explicit whole-project purge keeps its existing rule scope.

Display preserved legacy tool identifiers safely in orphan reports, with bounded quoted attribution. Unrecognized tools remain protected from orphan deletion.
