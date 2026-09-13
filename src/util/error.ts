export function errorMessage(error: unknown): string {
    return error instanceof Error ? error.message : String(error);
}

// Cleanup steps are independent; retain diagnostics while attempting the rest.
export function attemptCleanup<T>(failures: string[], label: string, action: () => T): T | undefined {
    try {
        return action();
    } catch (error) {
        failures.push(`${label}: ${errorMessage(error)}`);
        return undefined;
    }
}
