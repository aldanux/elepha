import { statSync } from 'node:fs';
import type Database from 'better-sqlite3-multiple-ciphers';
import { canonicalizeExisting, isWithin } from '../config/paths.js';
import { ConsentStore } from './consent-store.js';
import { ProjectResolver } from './project-resolver.js';

export interface TaskStateProjectScope {
    projectId: number;
    projectPath: string;
    canonicalPaths: ReadonlyMap<string, string>;
}

// This establishes the grouped owner only. The adapter must independently
// authenticate the exact native cwd; containment never authenticates a chat.
export function prepareTaskStateProjectScope(
    db: Database.Database,
    projectId: number,
    projectPath: string,
    cwd: string,
): TaskStateProjectScope | undefined {
    const consent = new ConsentStore(db);
    const resolver = new ProjectResolver(db);
    const group = resolver.storedProjectForAuthorization(projectId);
    if (!group || consent.consentState(cwd) !== 'approved' || consent.isRefusedForCapture(cwd)) {
        return undefined;
    }
    try {
        const canonicalPaths = new Map(group.paths.map((member) => [member, canonicalizeExisting(member)]));
        const owner = canonicalPaths.get(projectPath);
        if (
            owner === undefined ||
            !statSync(owner).isDirectory() ||
            !isWithin(owner, canonicalizeExisting(cwd)) ||
            consent.isRefusedForCapture(projectPath) ||
            !resolver.isStoredProjectConsented(projectId, consent, canonicalPaths)
        ) {
            return undefined;
        }
        return { projectId, projectPath, canonicalPaths };
    } catch {
        return undefined;
    }
}

// Filesystem bindings are prepared before awaited work or a write lock;
// ownership and group consent are rebuilt at the decisive database boundary.
export function taskStateProjectScopeCurrent(db: Database.Database, scope: TaskStateProjectScope): boolean {
    const owner = db.prepare('SELECT path FROM projects WHERE id = ?').pluck().get(scope.projectId);
    return (
        owner === scope.projectPath &&
        new ProjectResolver(db).isStoredProjectConsented(scope.projectId, new ConsentStore(db), scope.canonicalPaths)
    );
}
