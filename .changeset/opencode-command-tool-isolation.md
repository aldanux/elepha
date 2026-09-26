---
"elepha": patch
---

OpenCode: display-only `elepha:` commands such as `elepha:rules:session:add` now send the model only the command result, without earlier chat history and with tools disabled, so the reply can no longer trigger unrelated tool calls like `elepha.recall`.
