---
"elepha": patch
---

Add a one-command tarball-based development install and standardize contributor Node setup on 24 without changing the supported runtime floor.

Make uninstall independent of database access and installed-package validity, attempt all independent cleanup steps, and report failures after cleanup. Broken service teardown no longer prevents hook/config/launcher removal or restores a partially removed installation on the next run. Memory databases and encryption metadata remain untouched.
