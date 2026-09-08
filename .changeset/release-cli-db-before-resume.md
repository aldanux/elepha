---
"elepha": patch
---

Fix a spurious "Capture daemon did not become healthy within 60s" error after capture-paused operations (backfill, purge, backup, rekey, self-update): release the CLI's database and await the daemon resume so the restarted daemon can migrate, open, and heartbeat without a competing connection.
