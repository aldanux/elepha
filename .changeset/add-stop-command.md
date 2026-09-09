---
"elepha": patch
---

Add `elepha stop` to stop the background daemon and confirm its process exits without disabling the service. Close the daemon's database handle before signal-driven exit so the managed lifecycle lease is released for the next startup. Use `elepha resume` to start capture again.
