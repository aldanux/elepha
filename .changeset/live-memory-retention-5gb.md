---
"elepha": minor
---

Replace the 1 GiB durable-copy eviction with one fixed 5 GB live-memory capacity. Chat openings warn from 4 GB (weekly) and 4.75 GB (every new chat). At capacity, elepha removes whole oldest native sessions down to 4.75 GB after writing a verified encrypted backup, never a single turn or copy and never an active, staged, unsettled, or still-referenced chat; projects, consent, and standing rules are kept, and removed sessions are never re-captured. When cleanup cannot safely reach the target, nothing is removed and the capture is deferred with a named gap. `elepha status` lists removed sessions and deferred chats. The `durable-capture-max-bytes` setting is retired and ignored.
