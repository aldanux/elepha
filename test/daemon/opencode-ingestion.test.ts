import { mkdirSync } from 'node:fs';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { opencodeStoreRoot } from '../../src/config/paths.js';
import { watchRoots } from '../../src/daemon/index.js';
import { withGrantableTestDir } from '../helpers/tmp.js';

afterEach(() => {
    vi.unstubAllEnvs();
});

describe('OpenCode watch roots', () => {
    it('watches the OpenCode root only when the store exists', () => {
        const sourceRoot = withGrantableTestDir('elepha-opencode-watch-root-');
        vi.stubEnv('XDG_DATA_HOME', sourceRoot);

        expect(watchRoots()).not.toContain(opencodeStoreRoot());
        mkdirSync(opencodeStoreRoot(), { recursive: true });
        expect(watchRoots()).toContain(opencodeStoreRoot());
    });
});
