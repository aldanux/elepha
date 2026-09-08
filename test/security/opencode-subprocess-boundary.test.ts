import { readFileSync } from 'node:fs';
import path from 'node:path';
import { describe, expect, it } from 'vitest';

describe('OpenCode adapter subprocess boundary', () => {
    it('cannot import the child-process module', () => {
        const source = readFileSync(path.resolve(import.meta.dirname, '..', '..', 'src', 'adapters', 'opencode.ts'), 'utf8');
        expect(source).not.toMatch(/node:child_process/);
    });

    it('keeps the daemon free of the child-process module', () => {
        const source = readFileSync(path.resolve(import.meta.dirname, '..', '..', 'src', 'daemon', 'index.ts'), 'utf8');
        expect(source).not.toMatch(/node:child_process/);
    });
});
