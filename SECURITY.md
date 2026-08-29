# Security Policy

## Reporting a vulnerability

Please report security vulnerabilities **privately** through GitHub's private
vulnerability reporting. Open this repository's **Security** tab and select
**Report a vulnerability**. GitHub creates a private advisory visible only to the
maintainers.

**Do not open a public issue for a security report.** Disclosing a vulnerability before
a fix is available puts users at risk. Public issues are for bugs and feature requests.

When reporting, please include:

- The affected version or commit.
- A description of the issue and its impact.
- Steps to reproduce, with a proof of concept if available.

## What to expect

- A best-effort acknowledgment within a few business days.
- Coordination with the maintainers on a fix and disclosure timing. Please keep the
  details private until a fix is released.
- Credit in the published advisory, if you would like it.

## Supported versions

Security fixes target the **latest released version**. Before 1.0, only the most
recently published version is supported.

## Threat model (context for reporters)

elepha reads local session transcripts produced by third-party AI coding tools and
treats them as **untrusted, inert data**—never as code, commands, or paths to execute.
A transcript containing shell syntax, control characters, or crafted paths is expected
and handled by design, so its presence alone is not a vulnerability.

Reports are most useful when they demonstrate how untrusted transcript content, or a
failure at the subprocess, consent, or path-containment boundaries, could lead to
command execution, exfiltration outside a consented scope, or ingestion of unconsented
sessions. The engineering rules that enforce these boundaries are documented in
[AGENTS.md](AGENTS.md).
