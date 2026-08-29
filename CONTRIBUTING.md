# Contributing to elepha

Thank you for helping improve elepha. Before proposing a change, read the
[README](README.md) for the product overview and browse the [user guides in `docs/`](docs) for
current behavior. For general help, search or open an issue in this repository's GitHub
Issues.

## Table of contents

- [Contribution terms](#contribution-terms)
- [Prerequisites](#prerequisites)
  - [Set up a local checkout](#set-up-a-local-checkout)
- [Reporting bugs](#reporting-bugs)
- [Feature requests](#feature-requests)
- [Pull requests](#pull-requests)
  - [Workflow](#workflow)
  - [Pull request description](#pull-request-description)
  - [Review process](#review-process)
  - [What we will not accept](#what-we-will-not-accept)
- [Commit guidelines](#commit-guidelines)
- [Formatting and linting](#formatting-and-linting)
- [Changelog](#changelog)
- [Coding conventions](#coding-conventions)

## Contribution terms

Each commit in a code contribution must include a `Signed-off-by` line matching its
author. Add it with `git commit -s` and use your real name for both; pseudonymous or
anonymous contributions are not accepted. By signing, you certify under the
[Developer Certificate of Origin](https://developercertificate.org/) that you wrote the change or have the right to
submit it, and that the contribution will be public and permanent under the project's
licence.

Documentation-only changes are exempt because GitHub's web editor cannot add a
sign-off, and typo fixes should not require a local clone. Sign-offs are checked
automatically on pull requests.

## Prerequisites

elepha is a TypeScript project and requires **Node.js 22 or newer**, as declared in
[package.json](package.json). The development dependencies include TypeScript, so no
global TypeScript installation is required.

Development and runtime are supported on macOS, Linux, and Windows through WSL. Native
Windows is not supported. You also need Git and npm to clone the repository, install
dependencies, and run the project scripts. Public work is tracked through GitHub Issues.

### Set up a local checkout

Clone the repository and install its dependencies:

```console
git clone https://github.com/elepha-app/elepha.git
cd elepha
npm install
```

## Reporting bugs

Search GitHub Issues before filing a report so you do not duplicate an existing issue.
If the problem has not been reported, open an issue and include:

- The affected elepha version or commit.
- Your operating system and version.
- The AI coding tool, version, and surface involved: Claude Code or Codex, in the CLI or desktop app.
- Your Node.js version.
- Clear steps that reproduce the problem.
- Relevant logs or error output.

Security vulnerabilities do not belong in public issues. Follow the private reporting
process in [SECURITY.md](SECURITY.md) instead.

## Feature requests

Open a GitHub issue to discuss a feature before building it. Describe the problem you
want to solve, the expected user outcome, and why the proposed change belongs in elepha.
Early discussion helps avoid work on an approach that does not fit the project.

## Pull requests

### Workflow

1. Create a branch from the latest `main`.
2. Make one focused change and add or update relevant tests.
3. Run the required checks:

   ```console
   npm run typecheck
   npm run format:check
   npm test
   ```

4. Add a changeset when the change should appear in release notes, as described in [Changelog](#changelog).
5. Open a pull request with a clear title and complete description.

All three required checks must pass before review.

### Pull request description

Give reviewers enough context to evaluate the change without reconstructing its history.

Include:

- The motivation and user-facing or technical outcome.
- A link to the related GitHub issue, when one exists.
- Testing notes, including the checks you ran and any relevant manual verification.

Keep the pull request limited to one concern. If you notice unrelated cleanup, submit it
separately.

### Review process

A maintainer will review the change and may request revisions or additional tests.
Accepted pull requests are squash-merged, so the pull request title must follow the
[commit guidelines](#commit-guidelines) and describe the final change accurately.

### What we will not accept

Pull requests will not be accepted if they:

- Break the security invariant that transcripts and their derived content are inert data, never code, commands, or paths to execute.
- Cause elepha to write files into users' repositories.
- Combine unrelated changes that cannot be reviewed independently.

## Commit guidelines

Commit messages follow [Conventional Commits](https://www.conventionalcommits.org/) and
the rules configured through `@commitlint/config-conventional`, while
[Contribution terms](#contribution-terms) governs code-contribution sign-offs. Use a
concise type, an optional scope, and an imperative description:

```text
type(scope): description
```

The complete header must be no longer than 72 characters. If a body is needed, keep
each body line to 72 characters or fewer. For example:

```text
fix(capture): preserve consent during reingest

Keep denied projects out of transcript backfills.
```

## Formatting and linting

Biome handles formatting and linting. Verify the repository without modifying files:

```console
npm run format:check
```

Apply Biome's fixes with:

```console
npm run format-lint
```

Review any resulting changes before committing them.

## Changelog

The repository uses Changesets for release notes and versioning. When your change should
be included in the release notes, create a changeset with:

```console
npm run changeset
```

Select the appropriate release impact and write a concise user-facing summary. Commit
the generated changeset with your pull request instead of editing a changelog by hand.

## Coding conventions

[AGENTS.md](AGENTS.md) is the canonical entry point for elepha's engineering conventions
and the inert-data security rules. Read it before changing code, and follow the linked
subsystem guidance relevant to your work. In particular, changes must preserve the
transcript trust boundary and elepha's rule that it never writes into users' repositories.
