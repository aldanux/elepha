# Development

## One-time setup

Use Node 24 for development. With nvm:

```sh
nvm install 24 && nvm alias default 24
nvm use default
```

Other managers:

- [fnm](https://github.com/Schniz/fnm/blob/master/docs/commands.md): `fnm install 24 && fnm default 24 && fnm use default`.
- [asdf](https://asdf-vm.com/guide/getting-started.html): install an exact 24.x release with the Node.js plugin, then `asdf set -u nodejs <installed-24.x-version>`; remove conflicting project or shell overrides.
- [Homebrew](https://formulae.brew.sh/formula/node@24): `brew install node@24`, then put `$(brew --prefix node@24)/bin` first in your shell's `PATH`. Homebrew has no default alias; its stable `opt/node@24` path selects the release.

The end-user runtime floor stays at Node 22.12.0. CI explicitly tests Node 22 and 24
and does not derive its versions from `.nvmrc`.

## Day-to-day loop

Install checkout dependencies once (and again when dependencies change):

```sh
npm install
```

After any change you want reflected in your global `elepha`, run:

```sh
npm run dev:install
```

The script checks the active Node manager. For nvm, it automatically reruns itself
through `nvm-exec` with `NODE_VERSION=default` when the shell uses a different version.
Other managers get an actionable command if their selected Node does not match their
default. The script then builds, packs, uninstalls existing elepha registrations,
installs the tarball globally as a real copy, removes the tarball, runs `elepha install`,
and finishes with `elepha doctor`. Every subprocess prints its output; a failed step
exits nonzero. asdf installations also refresh their Node.js shims.

If an old launcher or package cannot execute, the script reports that failure and
uses the freshly built checkout's uninstall command to remove registrations before
reinstalling. Uninstall leaves `~/.elepha/elepha.db*` and
`~/.elepha/encryption.json` untouched. Cleanup errors are reported together and must
be resolved before the script proceeds.

## Why linking does not work

`npm link` and `npm i -g .` create a symlink into the checkout. The package-root check
in [`src/install/binary.ts`](src/install/binary.ts) requires the binary's resolved
real path to belong to a literal `node_modules/elepha` directory with a matching
package manifest. A checkout symlink intentionally fails that check: install must
trust an npm-installed package. `npm pack` followed by a global tarball install
provides the required real copy; keep this check intact.

## Troubleshooting

### “must be run from an npm-installed elepha binary”

Fix: run `npm run dev:install` from the checkout to replace the linked or broken global package with a real tarball installation.

### “must run from the Node manager's default”

Fix for nvm: `nvm use default && npm run dev:install` (if no default exists, run the one-time setup above).

For fnm, use `fnm use default && npm run dev:install`; for asdf, select the same
installed Node 24 release in the home default and any active override; for Homebrew,
put the stable `opt/node@24/bin` directory first in `PATH` and rerun the script.
