// Anthropic prompt caching is prefix-based. Keep the cache breakpoint on the
// static system block so per-turn/session content remains a variable suffix.

export function cacheableSystemPrompt(text: string) {
    return [{ type: 'text' as const, text, cache_control: { type: 'ephemeral' as const } }];
}
