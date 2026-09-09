---
"elepha": patch
---

Fix OpenCode in-chat `elepha:` commands, which did nothing before. The plugin now rewrites the user message with elepha's response instead of injecting into the system prompt (OpenCode's smaller models ignore late system entries), and `elepha install` registers the plugin in `opencode.json`'s `plugin` array so OpenCode actually loads it. Verified end to end against a running OpenCode: `elepha:info`/`elepha:list` render verbatim and `elepha:resume` recaps.
