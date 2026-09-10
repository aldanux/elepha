# Kimi capture verification

Phase 3 was implemented on `feat/kimi-recall-mcp`, starting at
`2c8793c0b290a9c9f73be276474bea744bac2d9a`. Changes remain uncommitted. One minor
changeset completes the accumulated Kimi work for 0.7.0; package versioning and
publication have not been run.

## Capture and reconciliation

The adapter reads main-agent JSONL through the existing provider-file boundary.
Metadata is read from the opened session's `state.json`, with the top-level index
as fallback. Literal and canonical project paths are checked; metadata identity,
source identity, consent, and capture tombstones are checked again at mutation.

The cursor stores the completed-turn ordinal, prompt identity, byte offset,
device/inode identity, content-window fingerprints, protocol, and current model.
An unchanged append tails from that checkpoint. Replacement, shrink, changed
metadata binding, or fingerprint mismatch triggers a streaming comparison against
stored logical-turn digests. No full transcript or session-wide array of turn bodies
is retained. Per-record byte limits and per-turn newest-text retention bound memory.

Reconciliation removes the changed suffix, its durable copies, search postings,
and affected rollups in one transaction. Unchanged turn rows keep their identities.
Normal ingestion then fills the missing suffix. A crash between those stages leaves
less memory until retry. Source generations prevent a rollup prepared before
retraction from restoring old content. The checkpoint and reconciliation helpers
are reusable for a future Pi active-branch projection.

Fork metadata with no `forked` boundary refuses capture. With the boundary, the
inherited prefix is suppressed and only subsequent local turns are captured.
Complete malformed records are counted and reported; a malformed full reduction
cannot authorize retraction. Partial trailing JSON and unfinished prompts remain
pending.

Model aliases come from `profile.bind`, `config.update`, and `llm.request`.
Protocol version is captured per turn; the unrecorded producer build stays
`unknown`. Prompt completion supplies `endedAt`, including the interval needed to
catch a brief injected during a turn. Sentinels are inspected before origin/text
filtering; quote-back uses the existing per-session injection store.

## Automated evidence

All gates passed: build, source typecheck, test typecheck, Biome, `git diff --check`,
and the full unsandboxed suite: **175 files, 1,641 tests passed, one skipped**.
The sandboxed suite encountered `tsx` IPC and npm-cache permission failures.

The 20 focused tests in `test/adapters/kimi-code.test.ts`,
`test/daemon/kimi-ingestion.test.ts`, and `test/storage/kimi-migration.test.ts`
cover completed/failed turns, text concatenation, reasoning and injection exclusion,
model changes, subagents including canonical aliases, fallback metadata and deletion
records, undo, atomic resume replacement, repair-to-empty, forks, rollback, consent
changes during summary work, source replacement during summary work, and stale
rollup rejection. A real phase-2 resume hook output is fed back into the fixture wire;
both its sentinel-bearing form and stripped assistant echo are excluded.

Migration fixtures retain the literal pre-capture sessions CHECK constraint and
existing OpenCode session/memory rows. Fresh creation, prior-schema migration, and
idempotent reopening preserve rows and pass foreign-key checks. Existing tests that
asserted only three capture providers or phase-2's absence of capture were updated
to the new four-provider contract. The last-enabled-provider refusal remains tested.

## Live evidence — 2026-09-10, Asia/Bangkok

The shell's Node 22 installation links to the checkout. The managed daemon launcher
actually resolves Node 24.19.0 and a separate installed package. The tested `dist`
was deployed to that package while preserving its native dependencies. Its original
build was backed up at `/private/tmp/elepha-kimi-runtime-before-0s8y67mr/dist`.

The live wire exposed a detail not represented in the initial ticket examples:
loop-event turn IDs are strings (`"0"`), while `turn.ended` IDs are numbers (`0`).
The reducer normalizes these identities; fixtures now exercise that exact mixture.
The first live attempt refused those records before persistence. After normalization,
the daemon's startup sweep captured exactly two completed turns:

| Cache session | Native session | Stored turn | Project | State title |
|---|---|---|---|---|
| 1028 | `session_3bd44561-9f5d-46c4-b0b8-a663f97ea1ab` | 0 | `/Users/dani/Sites/aldanux/docs` | How many folders and files do we have here in this project? |
| 1029 | `session_4ce0b706-7fd5-47bd-9a1d-d5a3c85a47df` | 2 | `/Users/dani/Sites/aldanux/docs` | can you explain me what is git? |

The two preceding quota-failed prompts in session 1029 produced no memory rows.
Both captured rows have protocol `1.5`, producer `unknown`, and model alias
`moonshot-ai/kimi-k3`. Synthesis is not configured on this machine; the daemon ran
capture-only and made no model requests for this smoke.

The existing `elepha:list:100` handler displayed both entries as **Kimi Code CLI |
docs**, with the titles above. `elepha:query:here git` returned the Git session.
These handlers ran against the live cache with a separate smoke-session identity;
their normal injection/selector bookkeeping did not create a Kimi source session.
The unified `SessionReader` returned one stored turn per session, with answer lengths
391 and 1,700 characters respectively, and no sentinel-bearing content.

Doctor confirmed the daemon, database migrations, three consent roots, and managed
launcher healthy. Its overall exit was **1** because the detected Kimi installation
has neither the user MCP registration nor the UserPromptSubmit hook installed. This
capture smoke did not install those registrations. Live Kimi TUI hook display and
mid-turn echo behavior therefore remain unverified; hook-to-capture integration is
covered by fixtures. Undo, fork, and resume/repair rewrites were also fixture-only:
no live Kimi history was modified and no new Kimi turns were generated.

SHA-256 hashes of all **eight** live Kimi session files matched before and after the
smoke. No transcript contents or absolute-path/system-prompt dumps were copied into
test fixtures.

The final deployed package matched all 348 build files byte-for-byte. After its
restart (daemon PID 49715), sessions 1028 and 1029 still each had exactly one
memory row. Final doctor output retained only the registration findings above.
