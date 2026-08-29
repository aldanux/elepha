import { writeFileSync } from 'node:fs';
import { homedir } from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { isRefusedProjectRoot } from '../../src/config/paths.js';
import { withGrantableTestDir } from '../helpers/tmp.js';

afterEach(() => {
    vi.unstubAllEnvs();
});

function configFixture(contents?: string): string {
    const directory = withGrantableTestDir('elepha-user-dirs-');
    if (contents !== undefined) {
        writeFileSync(path.join(directory, 'user-dirs.dirs'), contents);
    }
    return directory;
}

describe('localized refused user directories', () => {
    it('adds localized XDG user directories alongside the English roots', () => {
        const configHome = configFixture(
            ['XDG_DESKTOP_DIR="$HOME/Escritorio"', 'XDG_DOCUMENTS_DIR="$HOME/Documentos"', 'XDG_DOWNLOAD_DIR="$HOME/Descargas"'].join('\n'),
        );
        vi.stubEnv('XDG_CONFIG_HOME', configHome);

        expect(isRefusedProjectRoot(path.join(homedir(), 'Escritorio'))).toBe(true);
        expect(isRefusedProjectRoot(path.join(homedir(), 'Documentos'))).toBe(true);
        expect(isRefusedProjectRoot(path.join(homedir(), 'Descargas'))).toBe(true);
        expect(isRefusedProjectRoot(path.join(homedir(), 'Documents'))).toBe(true);
        expect(isRefusedProjectRoot(path.join(homedir(), 'Documentos', 'project'))).toBe(false);

        writeFileSync(
            path.join(configHome, 'user-dirs.dirs'),
            [
                'XDG_DESKTOP_DIR="$HOME/Bureau"',
                'XDG_DOCUMENTS_DIR="$HOME/DocumentsNouveaux"',
                'XDG_DOWNLOAD_DIR="$HOME/Telechargements"',
            ].join('\n'),
        );
        expect(isRefusedProjectRoot(path.join(homedir(), 'DocumentsNouveaux'))).toBe(false);
        expect(isRefusedProjectRoot(path.join(homedir(), 'Documentos'))).toBe(true);
    });

    it.each([
        ['missing', undefined],
        ['malformed', 'XDG_DOCUMENTS_DIR=not-a-quoted-path'],
    ])('falls back silently to English roots when the file is %s', (_case, contents) => {
        vi.stubEnv('XDG_CONFIG_HOME', configFixture(contents));

        expect(() => isRefusedProjectRoot(path.join(homedir(), 'Documents'))).not.toThrow();
        expect(isRefusedProjectRoot(path.join(homedir(), 'Documents'))).toBe(true);
        expect(isRefusedProjectRoot(path.join(homedir(), 'Desktop'))).toBe(true);
        expect(isRefusedProjectRoot(path.join(homedir(), 'Downloads'))).toBe(true);
    });
});
