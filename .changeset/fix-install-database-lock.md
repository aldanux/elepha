---
"elepha": patch
---

Close install and uninstall database readers before changing the capture service. Skip exclusive encryption-migration ownership for already-encrypted databases when no migration needs recovery, allowing upgrades alongside active readers.
