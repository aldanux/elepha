---
"elepha": patch
---

Fix `rekey-projects` so a transferred or renamed repository (changed git remote) consolidates: group project rows by their live-resolved git root before the mutable git remote, keeping fork-safety.
