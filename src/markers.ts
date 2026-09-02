// Operator hand-off format shared by CLI, hooks, and their contract tests.
export function terminalHandoff(command: string): string {
    return `→ Run (Terminal): elepha ${command}`;
}
