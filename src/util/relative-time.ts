import { DAY_MS } from '../config/constants.js';

export function relativeTime(iso: string, now: number): string {
    const age = Math.max(0, now - Date.parse(iso));
    if (age < 60 * 60 * 1000) {
        return `${Math.floor(age / 60000)}m ago`;
    }
    if (age < DAY_MS) {
        return `${Math.floor(age / (60 * 60 * 1000))}h ago`;
    }
    return `${Math.floor(age / DAY_MS)}d ago`;
}
