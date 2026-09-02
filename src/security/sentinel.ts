import { newUlid } from '../storage/ulid.js';

export type InjectionKind = 'brief' | 'notify';

export const OPEN = '[[elepha:';
export const CLOSE = '[[/elepha]]';

export function open(kind: InjectionKind, ulid: string): string {
    return `${OPEN}${kind}:${ulid}]]`;
}

// Wraps an injected body in line-isolated, transcript-stable markers.
export function wrap(kind: InjectionKind, ulid: string, body: string): string {
    return `${open(kind, ulid)}\n${body}\n${CLOSE}`;
}

// The same canonical ULID format used by elepha's other durable records.
export function buildInjectionId(): string {
    return newUlid();
}

// Deliberately a literal prefix match: malformed markers fail closed.
export function containsSentinel(text: string): boolean {
    return text.includes(OPEN);
}
