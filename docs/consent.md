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

The wizard detects local sessions from supported AI coding tools and discovers eligible 
Git projects, and asks whether you want to approve whole workspace folders or individual
projects. Folder mode covers projects already inside the selected folder and discovers
new projects there automatically. Individual mode gives you a project-by-project
selection.

New approvals are backfilled immediately from eligible transcripts already on disk,
so elepha can remember earlier work as well as future sessions. The wizard is
interactive and makes no changes if you cancel it.

## Change consent later

For a returning user, the interactive entry point is:

```console
elepha consent
```

It opens the same discovery and selection picker used during onboarding. Selecting a
root grants it; deselecting an approved project or folder pauses consent for that
scope. Deselecting never deletes captured memory, and selecting it again does not
override the privacy veto for sessions written while it was explicitly paused.

Use the direct subcommands when you already know the root you want to change. The
following grants a path, then backfills eligible transcripts already written there:

```console
elepha consent grant /path/to/workspace
```

From inside a project, `elepha consent grant --here` grants the current directory.
Choose either a path or `--here`, never both.

Revoking a root stops new capture for that scope but keeps its existing memory
searchable:

```console
elepha consent revoke /path/to/workspace
```

`elepha consent revoke --here` applies the same change to the current directory. A
later grant resumes eligible capture; it does not make the deliberately private
sessions from the revoked period backfillable.

## Review recorded decisions

`elepha consent list` prints every approved, denied, and pending root together with
the source and decision time. `elepha consent pending` narrows the output to roots the
capture service has discovered but that you have not approved or revoked yet.

Revocation is intentionally non-destructive. To remove memory already stored for a
project, use the separate workflow in [Deleting memory](purge.md).

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
longer exist, use [`elepha purge --orphan`](purge.md#choose-one-scope).
