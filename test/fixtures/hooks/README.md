# SessionStart contract probes

Frozen against Claude Code `2.1.233` and Codex CLI `0.147.0` on 2026-08-17.
The fixtures replace personal IDs and paths. They cover the common validated
fields; tests vary `source` across `startup`, `clear`, `resume`, and `compact`.

To refresh without an API/model call, point `CLAUDE_CONFIG_DIR` or `CODEX_HOME`
at a temporary root containing a command hook that copies stdin to a temporary
file. Open the installed CLI in a PTY, trigger the lifecycle action, and exit
before submitting a prompt. Do not copy authentication files into the temporary
root. Compare the captured object with the fixture after removing personal paths
and native IDs. A fresh unauthenticated root reaches tool onboarding before
SessionStart; in that case repeat the no-prompt probe in an authenticated local
profile after backing up and restoring only its hook configuration.
