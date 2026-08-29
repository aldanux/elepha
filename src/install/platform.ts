import { readFileSync } from 'node:fs';

export function isSupportedPlatform(platform: NodeJS.Platform = process.platform): boolean {
    return platform === 'darwin' || platform === 'linux';
}

export function isWsl(env: NodeJS.ProcessEnv = process.env, procVersion?: string): boolean {
    if (env.WSL_DISTRO_NAME !== undefined || env.WSL_INTEROP !== undefined) {
        return true;
    }
    let version = procVersion;
    if (version === undefined) {
        try {
            version = readFileSync('/proc/version', 'utf8');
        } catch {
            version = '';
        }
    }
    return /microsoft/i.test(version);
}

export function linuxServiceManagerError(input: { hasSystemd: boolean; isWsl: boolean }): string | undefined {
    if (input.hasSystemd) {
        return undefined;
    }
    if (input.isWsl) {
        return 'elepha install requires systemd. Add [boot] and systemd=true to /etc/wsl.conf, run wsl --shutdown, reopen the distro, then re-run elepha install.';
    }
    return "elepha's capture service requires systemd (systemctl) as the init, but this system is not running it.";
}
