import { mkdirSync, realpathSync } from 'node:fs';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import { consentedProject } from '../../src/hooks/common.js';
import { ProjectResolver } from '../../src/storage/project-resolver.js';
import { createTestDb, seedConsentRoot, seedProject } from '../helpers/db.js';

describe('consentedProject', () => {
    function ambiguousProjects() {
        const fixture = createTestDb('elepha-hook-common-');
        const cwd = realpathSync(fixture.directory);
        const firstPath = path.join(cwd, 'app-api');
        const secondPath = path.join(cwd, 'app-web');
        mkdirSync(firstPath);
        mkdirSync(secondPath);
        const first = seedProject(fixture, { path: firstPath });
        const second = seedProject(fixture, { path: secondPath });
        return { fixture, first, second, cwd };
    }

    it('selects the sole consented raw-ambiguous project (D52)', () => {
        const { fixture, first, second, cwd } = ambiguousProjects();
        seedConsentRoot(fixture, { path: cwd });
        seedConsentRoot(fixture, { path: second.path, state: 'denied' });

        expect(new ProjectResolver(fixture.db).resolve(cwd)).toMatchObject({ ambiguous: true });
        expect(consentedProject(fixture.db, cwd)?.projectIds).toEqual([first.id]);
    });

    it('refuses raw ambiguity between multiple consented projects (D52)', () => {
        const { fixture, cwd } = ambiguousProjects();
        seedConsentRoot(fixture, { path: cwd });

        expect(consentedProject(fixture.db, cwd)).toBeUndefined();
    });

    it('refuses raw ambiguity when none of its projects is consented (D52)', () => {
        const { fixture, cwd } = ambiguousProjects();

        expect(consentedProject(fixture.db, cwd)).toBeUndefined();
    });
});
