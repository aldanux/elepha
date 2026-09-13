import { chmodSync, existsSync, mkdirSync, readdirSync, readFileSync, rmSync, statSync, symlinkSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { sweepTestScratch } from './global-setup.js';
import { withTempDir } from './helpers/tmp.js';

vi.mock('node:fs', async (importOriginal) => {
    const fs = await importOriginal<typeof import('node:fs')>();
    return { ...fs, rmSync: vi.fn(fs.rmSync), readdirSync: vi.fn(fs.readdirSync) };
});

afterEach(() => {
    vi.restoreAllMocks();
    vi.mocked(rmSync).mockReset();
    vi.mocked(readdirSync).mockReset();
});

describe('sweepTestScratch', () => {
    it('removes writable leftovers and leaves an empty root on repeated sweeps', () => {
        const root = withTempDir('scratch-sweep-');
        mkdirSync(path.join(root, 'leftover'));
        writeFileSync(path.join(root, 'leftover', 'data'), 'fixture');

        expect(sweepTestScratch(root)).toEqual({ removed: ['leftover'], remaining: [] });
        expect(readdirSync(root)).toEqual([]);
        expect(sweepTestScratch(root)).toEqual({ removed: [], remaining: [] });
        expect(readdirSync(root)).toEqual([]);
    });

    it('normalizes restricted directories and read-only nested files before removal', () => {
        const root = withTempDir('scratch-sweep-');
        const directory = path.join(root, 'restricted');
        mkdirSync(path.join(directory, 'nested'), { recursive: true });
        writeFileSync(path.join(directory, 'nested', 'data'), 'fixture');
        chmodSync(path.join(directory, 'nested', 'data'), 0o444);
        chmodSync(path.join(directory, 'nested'), 0o000);
        chmodSync(directory, 0o444);

        try {
            expect(sweepTestScratch(root)).toEqual({ removed: ['restricted'], remaining: [] });
            expect(readdirSync(root)).toEqual([]);
        } finally {
            if (existsSync(directory)) {
                chmodSync(directory, 0o700);
                chmodSync(path.join(directory, 'nested'), 0o700);
            }
        }
    });

    it('creates a missing root', () => {
        const root = path.join(withTempDir('scratch-sweep-'), 'missing');

        expect(sweepTestScratch(root)).toEqual({ removed: [], remaining: [] });
        expect(readdirSync(root)).toEqual([]);
    });

    it('reports a failed removal and continues removing later siblings', async () => {
        const root = withTempDir('scratch-sweep-');
        for (const name of ['a-removed', 'b-stuck', 'c-removed']) mkdirSync(path.join(root, name));
        const fs = await vi.importActual<typeof import('node:fs')>('node:fs');
        vi.mocked(rmSync).mockImplementation((target, options) => {
            if (target === path.join(root, 'b-stuck')) throw new Error('removal denied');
            return fs.rmSync(target, options);
        });
        const output = vi.spyOn(console, 'log').mockImplementation(() => {});

        expect(sweepTestScratch(root)).toEqual({ removed: ['a-removed', 'c-removed'], remaining: ['b-stuck'] });
        expect(readdirSync(root)).toEqual(['b-stuck']);
        expect(output).toHaveBeenCalledTimes(1);
        expect(output.mock.calls[0]?.[0]).toMatch(/removed 2.*remaining 1.*b-stuck/);
    });

    it('reports a directory listing failure without failing cleanup', () => {
        const root = withTempDir('scratch-sweep-');
        vi.mocked(readdirSync).mockImplementationOnce(() => {
            throw Object.assign(new Error('listing denied'), { code: 'EACCES' });
        });
        const output = vi.spyOn(console, 'log').mockImplementation(() => {});

        expect(() => sweepTestScratch(root)).not.toThrow();
        expect(existsSync(root)).toBe(true);
        expect(output).toHaveBeenCalledTimes(1);
        expect(output.mock.calls[0]?.[0]).toContain('listing denied');
    });

    it('removes symlinks without changing their targets outside the swept root', () => {
        const container = withTempDir('scratch-sweep-');
        const root = path.join(container, 'scratch');
        const target = path.join(container, 'target');
        mkdirSync(root);
        mkdirSync(target);
        const file = path.join(target, 'data');
        writeFileSync(file, 'keep', { mode: 0o444 });
        const mode = statSync(file).mode;
        symlinkSync(target, path.join(root, 'directory-link'));
        symlinkSync(file, path.join(root, 'file-link'));
        symlinkSync(path.join(container, 'missing'), path.join(root, 'broken-link'));

        expect(sweepTestScratch(root).remaining).toEqual([]);
        expect(readdirSync(root)).toEqual([]);
        expect(readFileSync(file, 'utf8')).toBe('keep');
        expect(statSync(file).mode).toBe(mode);
    });
});
