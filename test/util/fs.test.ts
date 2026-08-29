import { lstatSync, mkdirSync, mkdtempSync, readFileSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import { atomicWrite } from '../../src/util/fs.js';

describe('atomicWrite', () => {
    it('writes through a symlink without replacing it', () => {
        const root = mkdtempSync(path.join(tmpdir(), 'elepha-util-fs-'));
        const target = path.join(root, 'dotfiles', 'settings.json');
        const link = path.join(root, 'config', 'settings.json');
        mkdirSync(path.dirname(target), { recursive: true });
        mkdirSync(path.dirname(link), { recursive: true });
        writeFileSync(target, '{"before":true}\n');
        symlinkSync(target, link);

        atomicWrite(link, '{"after":true}\n', 0o600);

        expect(lstatSync(link).isSymbolicLink()).toBe(true);
        expect(readFileSync(target, 'utf8')).toBe('{"after":true}\n');
    });
});
