# Choosing what elepha may remember

Consent defines the projects and folders whose local transcripts elepha is allowed to
read into memory. It is a permission boundary, separate from whether the background
capture service happens to be running. A root can be approved, pending a decision, or
explicitly revoked.

## First-run onboarding

Run the onboarding wizard after installation:

```console
elepha init
```

The wizard detects local sessions from supported AI coding tools, lets you choose which
detected tools should be captured, discovers eligible Git projects, and asks whether you
want to approve whole workspace folders or individual projects. Every detected tool is
selected for capture by default, and at least one must remain enabled. Folder mode covers
projects already inside the selected folder and discovers new projects there
automatically. Individual mode gives you a project-by-project selection.

The wizard then asks how elepha should search memory. First setup preselects local
semantic search, which finds sessions by meaning in any language; term-only search is
the alternative. Later runs preselect the mode you already use.

Every answer is only staged. One final review lists the exact roots to approve or
pause, the capture tools and the search mode, and explains what approval means:
filtered memory rather than raw transcripts, model reasoning or fetched tool output;
the physical path shown, with separate worktrees needing their own approval; and the
fixed 5,000,000,000-byte live-memory limit. Nothing is written, installed or downloaded
before you confirm, and cancelling at any step leaves everything unchanged. Rerunning
with the same choices changes nothing.

After you confirm, a newly chosen semantic search is installed and verified before any
choice is saved; if that fails, your previous settings and consent stay in effect.
Choosing term-only turns Memory-Plus off but keeps its stored vectors and local runtime.
Consent changes and settings are then saved together. If the preview went stale while
it was open, the plan is refused and you are asked to run the wizard again. While
choices are being saved, other settings, consent and restore commands wait for it; if a
run was interrupted while saving, the next `elepha init` finishes or undoes it before
accepting new choices, and never overwrites a decision you made in between.

New approvals are backfilled from eligible transcripts already on disk, so elepha can
remember earlier work as well as future sessions. If that backfill or the capture
service fails, or some transcripts cannot be listed, read or parsed, your confirmed
choices and already imported turns are kept and the wizard names the gap and how to
retry it.

## Change consent later

For a returning user, the interactive entry point is:

```console
elepha consent
```

It opens the same discovery, selection and review steps used during onboarding, without
the search-mode choice. Selecting a
root grants it; deselecting an approved project or folder pauses consent for that
scope. Deselecting never deletes captured memory, and selecting it again does not
override the privacy veto for sessions written while it was explicitly paused.

Use the direct subcommands when you already know the root you want to change. The
following grants a path, then backfills eligible transcripts already written there:

```console
elepha consent grant /path/to/workspace
```

From inside a project, `elepha consent grant --here` grants the current directory.
Choose either a path or `--here`, never both. The command is itself the explicit grant:
it prints the same filtered-capture and live-memory contract before granting, without
asking a second time.

Revoking a root stops new capture for that scope and hides its retained memory from
search and recall while the root remains revoked. It does not delete the retained
rows, durable conversation copy, or indexed search terms:

```console
elepha consent revoke /path/to/workspace
```

`elepha consent revoke --here` applies the same change to the current directory. A
later grant makes pre-revocation memory eligible for search and recall again and
resumes capture; it does not make the deliberately private sessions from the revoked
period backfillable.

## Move or rename a project

If a repository moves or is renamed inside an approved folder, no consent change is
needed. elepha groups the old and new locations by Git identity, keeps the existing
memory, and shows the current live path after it observes the new location.

If the repository was approved individually, or its new location is outside the
approved folder, approve the new location with `elepha consent`. From inside the moved
checkout, the direct equivalent is:

```console
elepha consent grant --here
```

The grant backfills eligible transcripts at the new location and does not require a
database restore or delete the memory recorded under the former path. After verifying
the new path, `elepha consent prune` can remove a missing old consent entry without
deleting captured memory.

## Review recorded decisions

`elepha consent list` prints every approved, denied, and pending root together with
the source and decision time. `elepha consent pending` narrows the output to roots the
capture service has discovered but that you have not approved or revoked yet.

Revocation is intentionally non-destructive. To remove memory already stored for a
project, use the separate workflow in [Deleting memory](purge.md).

Purge and incognito handling are destructive to the durable copy. A confirmed purge
deletes the selected sessions' filtered turns, durable coverage rows, and full-text
search terms. When elepha observes a session under an explicit denial, its incognito
veto removes the same durable copy and search terms for that native transcript. A
later grant does not backfill that deliberately private period. Revocation alone does
none of these deletions.

## Prune stale consent roots

`elepha consent prune` finds consent-list entries whose directories no longer exist
or are now refused or temporary project roots. It checks approved, denied, and pending
entries.

The command is a dry run by default. It prints each candidate with the reason
`missing` or `refused` and does not remove anything:

```console
elepha consent prune
```

Pass `--apply` to remove the listed entries. An apply asks for confirmation; add
`--skip-confirmation` to skip that prompt:

```console
elepha consent prune --apply
elepha consent prune --apply --skip-confirmation
```

Pruning removes only the root's entry from `elepha consent list`. It does not delete
captured memory. To clear memory belonging to directories that are temporary or no
longer exist, use [`elepha purge --orphan`](purge.md#choose-one-base-scope).
