import { fileURLToPath } from 'node:url';

if (
    process.env.npm_config_global === 'true' &&
    process.env.npm_lifecycle_event === 'postinstall' &&
    process.env.npm_package_name === 'elepha' &&
    (process.platform === 'darwin' || process.platform === 'linux')
) {
    try {
        const { runNpmPostinstall } = await import('../dist/install/npm-postinstall.js');
        await runNpmPostinstall(fileURLToPath(new URL('..', import.meta.url)));
    } catch (error) {
        console.error(error instanceof Error ? error.message : String(error));
    }
}
