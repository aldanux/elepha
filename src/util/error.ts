/** Returns a display-safe message from an unknown thrown value. */
export function errorMessage(error: unknown): string {
    return error instanceof Error ? error.message : String(error);
}
