import { describe, expect, it } from 'vitest';
import { isWsl, linuxServiceManagerError } from '../../src/install/platform.js';

describe('Linux service-manager preflight', () => {
    it('accepts systemd even when running in WSL', () => {
        expect(linuxServiceManagerError({ hasSystemd: true, isWsl: true })).toBeUndefined();
    });

    it('explains how to enable systemd in WSL', () => {
        const message = linuxServiceManagerError({ hasSystemd: false, isWsl: true });

        expect(message).toContain('/etc/wsl.conf');
        expect(message).toContain('systemd=true');
        expect(message).toContain('wsl --shutdown');
    });

    it('explains the systemd requirement without WSL instructions on other Linux systems', () => {
        const message = linuxServiceManagerError({ hasSystemd: false, isWsl: false });

        expect(message).toMatch(/systemd.*systemctl/i);
        expect(message).not.toContain('/etc/wsl.conf');
        expect(message).not.toContain('wsl --shutdown');
    });

    it('detects WSL from WSL_DISTRO_NAME', () => {
        expect(isWsl({ WSL_DISTRO_NAME: 'Ubuntu' }, '')).toBe(true);
    });

    it('detects WSL from a Microsoft kernel version', () => {
        expect(isWsl({}, 'Linux version 5.15.153.1-microsoft-standard-WSL2')).toBe(true);
    });

    it('rejects a non-WSL environment and kernel version', () => {
        expect(isWsl({}, 'Linux version 6.12.0-generic')).toBe(false);
    });
});
