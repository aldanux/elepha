---
"elepha": patch
---

Automatically retire verified stale MCP readers from npm-replaced Elepha packages during global upgrades and blocked install migrations. This lets 0.4.5 self-update complete and makes the one-time 0.3.x npm install path work without closing coding clients, while preserving database locking and leaving unrelated processes untouched.
