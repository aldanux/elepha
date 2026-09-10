# Kimi hook verification and release notes

This document records phase-2 verification of the native `UserPromptSubmit` hook.
Phase 3 adds transcript capture; current capture evidence and remaining live UX
limits are recorded in [Kimi capture verification](kimi-capture-verification.md).

## Verified upstream protocol

Inspected `MoonshotAI/kimi-code` at commit
[`aad4a7df2f745cc2936ecc159df6607a74671ad0`](https://github.com/MoonshotAI/kimi-code/tree/aad4a7df2f745cc2936ecc159df6607a74671ad0).

- [Hooks documentation](https://github.com/MoonshotAI/kimi-code/blob/aad4a7df2f745cc2936ecc159df6607a74671ad0/docs/en/customization/hooks.md): `[[hooks]]` accepts only `event`, `matcher`, `command`, and `timeout`; stdin is JSON with snake_case fields.
- [Matcher and input construction](https://github.com/MoonshotAI/kimi-code/blob/aad4a7df2f745cc2936ecc159df6607a74671ad0/packages/agent-core-v2/src/features/externalHooks/internal/matchHooks.ts): text parts drive the regex matcher; the original content-part array remains in `prompt`. The adapter joins text parts with newlines and ignores non-text parts.
- [Hook runner](https://github.com/MoonshotAI/kimi-code/blob/aad4a7df2f745cc2936ecc159df6607a74671ad0/packages/agent-core-v2/src/features/externalHooks/internal/runHook.ts): commands run through a shell. Exit 2 blocks using stderr; exit 0 can block with `hookSpecificOutput.permissionDecision = "deny"` and `permissionDecisionReason`. Allowed structured output uses `message`, not Claude's `additionalContext`.
- [Prompt hook service](https://github.com/MoonshotAI/kimi-code/blob/aad4a7df2f745cc2936ecc159df6607a74671ad0/packages/agent-core-v2/src/features/externalHooks/agent/agentExternalHooksService.ts): blocking appends an assistant hook result, emits a display event, and sets `ctx.block`; allowing appends a user hook-result context message and continues submission.
- [Result selection](https://github.com/MoonshotAI/kimi-code/blob/aad4a7df2f745cc2936ecc159df6607a74671ad0/packages/agent-core-v2/src/features/externalHooks/internal/userPrompt.ts) and [UI formatting](https://github.com/MoonshotAI/kimi-code/blob/aad4a7df2f745cc2936ecc159df6607a74671ad0/apps/kimi-code/src/tui/utils/hook-result-format.ts): arbitrary nonempty result text is retained after outer whitespace trimming. The UI adds a hook heading and renders Markdown. This is deterministic display with native UI formatting, not a byte-exact plain-text terminal renderer.

## Resulting behavior

`info`, `list`, `help`, `update`, and `query` use structured denial, displaying the
payload once and skipping the model call. The display directive is removed before
sanitization and injection recording. Sentinels and historical DATA framing remain
in the result, including the body Kimi persists. The native blocked-hook heading
and sentinel markers can be visible in the UI.

`resume` and `last` use the `message` field to inject the existing context and
instructions. The existing query implementation displays recall hits plus a resume
selector; it has no separate model answer phase. No new answer flow is added.

The generated client is embedded in the TOML command with POSIX quoting. Only the
installation's Node path and fixed client source enter Kimi's shell. The client
invokes the installed launcher with fixed argv, `shell: false`, bounded input and
output, and the event JSON on stdin. Errors emit no partial result.

The shown-session-list constraint is widened to admit Kimi chat identities, with
legacy rows preserved and idempotent reopening. Capture tool registration and
session ingestion remain unchanged. Correct hook registration is a byte-for-byte
no-op; changed TOML is serialized with `smol-toml`, preserving other settings and
hooks semantically. Refresh updates only an already owned hook; phase-1 users run
`elepha install` once to add it.

## Local verification

The required build, both typechecks, Biome check, and full unsandboxed test suite
passed (172 test files; 1,621 tests passed, one skipped). The sandboxed suite was
interrupted after IPC and npm-cache permission failures.

An isolated copy of the built package exercised the generated Kimi command through
a rendered installed launcher: help/list/query returned structured denial,
ordinary prompts produced no output, a phase-1 shown-list table migrated with its
existing row intact, and Kimi injection/list accounting persisted. This smoke used
the existing test-only lifecycle-directory injection to keep coordination files
inside repository scratch space. Isolated `doctor` confirmed the database opens,
Kimi MCP is registered, and the prompt hook is active. Its overall exit was 1
because the fixture intentionally had no capture service, consent, or managed
launcher manifest; this is not a live daemon-health verification.

## Phase-2 live UX gap

Kimi was not installed during the phase-2 verification. Source inspection, generated-client
execution, unit tests, and an isolated built-launcher smoke do not establish live
Kimi UX. Before publishing, Dani must install Kimi, run `elepha install`, start a
fresh Kimi session, and verify:

- `elepha:info`, `elepha:list`, `elepha:help`, and `elepha:update` display once without a model call. Update displays the terminal handoff.
- `elepha:query <known terms>` displays hits once, and `elepha:resume:1` recaps the selected session with the model.
- Ordinary prompts continue normally. Hook errors and timeouts fail open.
- Native hook headings, Markdown, and sentinel markers are acceptable in the actual TUI; check both initial display and reopened history.
- `elepha doctor` reports the Kimi MCP and UserPromptSubmit hook healthy.

No commit or publication is part of this change.
