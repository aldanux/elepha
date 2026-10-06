---
"elepha": minor
---

Claude Code and Codex now keep a filtered copy of every newly captured turn automatically, with no setting, prompt or re-grant, and without Memory-Plus or an AI provider. Live capture, staged failed turns and `elepha reingest` all follow this rule, so reingest replaces a current copy instead of withdrawing it. Capture settings, consent, incognito and physical checkout boundaries still decide what is captured. The `durable-capture` setting stays readable and off by default: it still enables new OpenCode copies, and it no longer turns off Claude Code or Codex copies.
