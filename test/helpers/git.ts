export function fixtureGitEnv(): NodeJS.ProcessEnv {
    // A linked-worktree hook exports GIT_DIR pointing into the shared repository.
    // Even git init <fixture> honors it and can rewrite the shared core.bare.
    return {
        ...Object.fromEntries(Object.entries(process.env).filter(([key]) => !key.startsWith('GIT_'))),
        GIT_CONFIG_NOSYSTEM: '1',
        GIT_CONFIG_GLOBAL: '/dev/null',
    };
}
