---
"elepha": patch
---

Reuse bounded, verified SQLite source and destination opening for encrypted imports. Destination construction obtains a fresh proof after source admission and validation, while both original file authorities and post-write verification remain fixed. Transient adjacent-directory activity can obtain a fresh sealed attempt only after proven cleanup. Substitution, cleanup failures and errors after admission still abort the import; source validation and copying are never restarted.
