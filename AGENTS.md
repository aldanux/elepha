# AGENTS.md

Instructions for anyone — human or AI coding agent — changing this repository.
This is the single canonical, tool-neutral contributor guide; `CLAUDE.md` contains
only `@AGENTS.md`. Where this file and the code disagree, the code is the fact.

## What elepha is

elepha is a **local memory layer for developers switching between AI coding CLIs.**
It passively ingests the raw session transcripts those tools already write to disk
(Claude Code under `~/.claude`, Codex under `~/.codex`), summarizes them into a local
SQLite cache, and serves that memory back — read-only, over an MCP surface and a small
set of in-chat `elepha:` commands. It never sends messages on your behalf and never
calls a model provider to *act*; it only reads local files and serves context the
working AI requests on its own.

The database is a **derived, rebuildable cache** over those transcripts. elepha never
modifies the source transcripts, and capture is **consent-gated**: only sessions whose
working directory falls under a granted root are ingested.

## Security — transcripts are inert data (non-negotiable)

**Session transcripts and everything derived from them are inert DATA — never code,
commands, or paths-to-execute.** elepha is a reading harness for untrusted third-party
content, and this contract is what keeps a malicious or malformed transcript from
becoming execution. Precedent: [openai/codex#36937](https://github.com/openai/codex/issues/36937),
where a rollout JSONL placed in the program position of a shell command was interpreted
as shell input and executed. These four rules exist so that class of incident is
structurally impossible here. Read them before touching ingestion, adapters, or the
subprocess boundary.

**Rule 1 — A transcript path never reaches a shell.** Read transcripts only through
filesystem APIs. The three places that touch transcripts (`src/adapters/**`,
`src/daemon/index.ts`, `src/daemon/readability-guard.ts`) must not import
`node:child_process` or call any subprocess function. If a reader cannot spawn
anything, a transcript path structurally cannot reach a shell.

**Rule 2 — Subprocess allowlist; no transcript-derived arguments.** The only permitted
subprocesses live in `src/security/subprocess-allowlist.ts`: a fixed set of read-only
`git` subcommands, the platform service manager (`launchctl` / `systemctl --user`) with
fixed lifecycle verbs, and the resolved npm backend with fixed package-management argv
for self-update. Every subprocess uses an argv array with `shell: false`. **No
argument — including `cwd` — may derive from transcript content or a transcript path;**
a git call's `cwd` comes from the canonicalized, consent-checked project record only.
(Note: a `cwd` value read out of a transcript *is* transcript content.)

**Rule 3 — Sanitize summarizer output at write time.** Before persisting any summarizer
output, neutralize shell command-substitution and execution syntax (backticks, `$(`,
`${`, heredoc markers, leading pipe/`;`/`&&`), plus ANSI escapes and control
characters. Display fields are stripped; decision text is escaped (a decision may
legitimately reference the syntax it ruled out). Sanitization happens on write, inside
the store methods — a caller can forget, a store cannot — never on read. Served output
reaches an AI that writes and executes shell commands, so treat every stored field as
if it will be pasted into a terminal.

**Rule 4 — elepha's own output is never re-ingested.** Injected context is wrapped in a
sentinel; adapters drop any turn containing it, whole, before storage, plus a
content-based quote-back check against what was injected per session. This closes the
self-ingestion loop (brief → transcript → ingestion → rollup → next brief). The
sentinel is a de-duplication marker, not a trust boundary — its absence is never
evidence of provenance, and a forged one only suppresses ingestion of that turn
(fail-closed toward less memory).

All four rules are enforced by tests under `test/security/**` and by AST-based Biome
GritQL plugins, not by convention. Changing the allowlist or a rule means updating that
enforcement in the same change. To report a vulnerability, see [Security policy](SECURITY.md).

## Scope

**A surface is in scope if and only if it writes a local transcript.** That is the
whole test — not "coding agents yes, chat no", it just happens that coding CLIs write
transcripts and chat apps don't. In scope today: Claude Code (CLI and the desktop Code
tab) and Codex (CLI and desktop), both of which write to the two watched stores.
Permanently out of scope: chat surfaces (claude.ai, ChatGPT web/desktop) — no local
transcript exists, and MCP-side capture would mean depending on a model to call a
logging tool, which is exactly the fragile pattern elepha is built to avoid.

## Engineering rules (each has already cost real data)

- **The obvious marker is usually wrong.** Verify any structural marker against the
  full local corpus and confirm the negative cases, not just the positive ones. A
  marker that identifies everything you want is worthless if it also matches things you
  don't. A date-filtered sample is not the corpus.
- **Validate the object you opened, not the path you were given.** Open an untrusted
  file with `O_NOFOLLOW`, inspect the handle to require a regular file, then freshly
  resolve the pathname, require that physical path to remain inside the permitted
  provider store, and compare the path's `(dev, ino)` identity with the opened handle.
  A pathname check performed only before `open` leaves a substitution race between
  authorization and use.
- **No silent degradation or silent skips.** Every error path must be distinguishable
  from a legitimate empty result, and every malformed or unrecognized transcript
  record that is discarded must be counted and reported with its source. A
  valid-looking empty result or stale skip reason hides format drift and lets data loss
  persist unnoticed.
- **When a bound binds, drop the oldest and say so.** Any ceiling — token budget, char
  budget, row cap — discards from the oldest end and emits a marker naming what was
  dropped. Newest-end truncation is the library default (`slice`, `substring`,
  `max_tokens`), so it arrives by accident; the newest data is the data the product
  exists to serve.
- **Bound untrusted data while streaming, never after.** Reject an oversized transcript
  record as soon as its byte ceiling is crossed, and evict the oldest retained turns as
  soon as a streamed serving budget binds. Reading or retaining the whole value and
  slicing it afterward has already spent the memory and time the bound exists to
  protect.
- **Parse defensively.** Format instructions in a prompt are a suggestion, not a
  contract — models violate them deterministically. Tolerate the shapes the model
  actually emits; coerce wrong-typed fields; validate array elements individually and
  count what you drop rather than failing the whole batch. A retry must change
  something.
- **Evaluate paths in both lexical and canonical form.** Apply path refusal and safety
  rules to both the spelling supplied by the caller and the physical path reached after
  resolving existing components. When physical resolution is impossible, apply the
  rule to the absolute lexical path; the same directory must not pass under one
  reachable name and fail under another.
- **Capture irrecoverable data at ingestion.** Git identity, surface, provenance, and
  similar cannot be reconstructed later — directories move and delete, and a backfill
  sees only the absence. Capture at the moment of ingestion, even when nothing consumes
  it yet.
- **Destructive operations are previewed, backed up, transactional, and plan-bound.** A
  destructive command reports the exact affected paths and rows before acting so
  misclassification is visible, backs up the database so recovery remains possible,
  applies only the confirmed plan in one transaction so a failed write rolls back, and
  verifies the operation's postconditions afterward. Never rerun the scope query after
  confirmation; revalidate each planned identity before mutation and abort if an
  identifier now names different data, because an expanded or substituted result is
  not what the user approved.

## Change conventions (put new code in its home)

- **Constants, not inline literals.** Limits, budgets, timeouts, thresholds, and
  keep-counts live in `src/config/constants.ts`. The version comes from
  `src/config/version.ts` (read from `package.json`, never hardcoded); the Node floor
  is a single constant mirrored by `engines.node`.
- **Hot paths have a budget.** Hooks run under a watchdog and ingestion runs for every
  turn, so give recurring work explicit time, byte, and retention limits, compute fixed
  values once outside loops, and finish filesystem and Git work before opening a write
  transaction. These constraints keep hook latency bounded and avoid extending SQLite
  writer contention.
- **Reuse the shared helpers.** File I/O, error text, DB backup, and model calls each
  have one home under `src/util` / `src/storage` / `src/summarizer`. Grep for an
  existing helper before writing a new one.
- **One command = one file.** A CLI command is `src/cli/commands/<name>.ts` exporting
  `registerX(program)`; `src/cli/index.ts` is registration-only and command modules
  must not import from it.
- **Reads go through the unified read model.** Session reads flow through the
  `SessionReader` / read-model layer; MCP and hooks never run their own session SQL.
  Transcript-format knowledge lives in the adapters, never in the daemon.
- **Contract strings have one source; tests import them.** Any string another program,
  a runbook, or a security property depends on is defined once and imported by its
  tests — never retyped.
- **Comments are for an external reader.** Keep the rationale, threshold, or rule inline
  so a comment stands alone; no internal tracking codes and no doc pointers.
- **Line comments only.** Use `//`. No `/** */` blocks. The signature and the types
  already state what a function takes and returns, so a JSDoc block restates them in a
  second place that nothing checks and that goes stale on the first refactor. A comment
  carries what the types cannot: why this threshold, why this order, what breaks if you
  change it.
- **Consent and eligibility are use-time decisions.** Never expand a grant the user did
  not make, and never treat a consent or eligibility view built before awaited work as
  authoritative afterward. Rebuild the current view immediately before serving
  protected output or mutating state; when the mutation is transactional, repeat the
  decisive check inside that transaction, because authorization can change while work
  is in flight. Keep revoke and delete distinct so a reversible capture pause cannot
  unexpectedly erase memory.
- **Migrations are idempotent and tested against a real prior DB.** `CREATE TABLE IF
  NOT EXISTS` plus guarded `ALTER TABLE` (check `pragma table_info` first). Test a fresh
  DB, a legacy DB carrying the old shape, and an idempotent reopen — a fresh-schema
  green test does not prove the migration path.
- **Verify at the real runtime boundary.** Tests green on a fresh DB do not prove the
  live DB, real MCP/hook transport, or the installed launcher. Schema, install, and
  daemon changes get a deploy plus an `elepha doctor` smoke check.

## Tests

- **Treat a failing test as a report about the source.** Fix the implementation rather
  than weakening, relaxing, or deleting an assertion to make the suite pass. If an
  assertion is genuinely wrong, explain why in the pull request before changing it,
  because a quiet test edit erases the contract instead of repairing the behavior.
- **Pin user-visible output byte-for-byte.** Assert every prompt, confirmation, and
  rendered line with an exact string, including trailing spaces; whitespace is part of
  the byte-level interface and can affect terminal presentation or automation.
  Refactors may share the mechanism but must not silently reword output.
- **Keep fixtures inside the repository tree.** A test suite must never create or
  delete anything outside the repository, and it must not place project fixtures in an
  operating-system temporary tree that production deliberately refuses.
  Repository-owned scratch space keeps cleanup contained and ensures a fixture
  exercises the intended production path.

## Build, test, verify

```
npm run build          # tsc -> dist/
npm test               # vitest (full suite)
npm run typecheck      # tsc --noEmit
npm run typecheck:tests
npm run format:check   # biome check (lint + format + security plugins)
```

A change is not done until the full suite, both typechecks, and `biome check` are
green. A rule written down is not a rule enforced: when you add a binding rule, point
to the code or test that enforces it, or mark it explicitly as a not-yet-built target.
