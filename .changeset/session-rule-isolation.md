---
"elepha": minor
---

Add explicit project and chat standing-rule commands for Claude Code and Codex,
with checkout-bound chat isolation and combined rule reporting. Preserve chat
rules in full backup and restore while excluding them from portable project
export and import with an explicit count. OpenCode chat rules remain unavailable
until its hooks can verify parent versus child session identity.
