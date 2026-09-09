---
"elepha": patch
---

Render OpenCode command output once in the assistant response, preserving the typed command in the user bubble by injecting only into the model message view.

Use valid assistant completion times for OpenCode turn ends so Rule 4 quote-back suppression drops command echoes injected during generation, while preserving creation-based turn openings and resume cursors.

Refresh already-installed, elepha-owned MCP configurations and provider plugins from the new build during self-update, reporting conflicts without installing missing integrations and restoring refreshed files if the update rolls back.
