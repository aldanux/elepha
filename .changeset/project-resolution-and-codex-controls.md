---
"elepha": minor
---

Reuse invocation-local normalized paths and ordering keys when grouping stored
projects, reducing SessionStart work for large rootless project inventories.
Ancestor groups, siblings, platform case handling and member ordering stay the
same; current authorization and delivery checks still rebuild their own views.

Recognize native Codex `thread_goal_updated` control snapshots without adding conversation or turn boundaries.
