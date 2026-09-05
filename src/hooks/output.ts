import { escapeShellSyntax } from '../security/sanitize.js';
import { buildInjectionId, type InjectionKind, wrap } from '../security/sentinel.js';
import type { MemoryStore } from '../storage/memory-store.js';
import type { HookTool } from './common.js';

export interface HookOutputInput {
    store: MemoryStore;
    tool: HookTool;
    nativeSessionId: string;
    body: string;
    kind: InjectionKind;
    injectedAt: string;
    writeInjection?: (store: MemoryStore, input: Parameters<MemoryStore['recordInjection']>[0]) => boolean;
}

// Nothing reaches a provider unless its sanitized body is durably attributable
// to the exact native chat that will receive the sentinel-wrapped response.
export function recordHookOutput(input: HookOutputInput): string | undefined {
    const body = escapeShellSyntax(input.body);
    const injectionId = buildInjectionId();
    const output = wrap(input.kind, injectionId, body);
    const recorded = (input.writeInjection ?? ((store, injection) => store.recordInjection(injection)))(input.store, {
        tool: input.tool,
        nativeSessionId: input.nativeSessionId,
        injectedAt: input.injectedAt,
        injectionId,
        body,
    });
    return recorded ? output : undefined;
}
