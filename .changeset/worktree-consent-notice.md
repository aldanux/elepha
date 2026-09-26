---
"elepha": minor
---

Show a one-time Claude Code and Codex session notice when a chat starts in a validated Codex worktree whose capture is still off, naming its root and how to grant it from there. Capture stays off until that exact worktree is explicitly granted, so an approved parent does not suppress the notice; denied or already-granted worktrees are never nudged. `elepha consent prune` keeps valid pending worktrees listed; missing, invalid, and explicitly denied worktrees still prune as before.
