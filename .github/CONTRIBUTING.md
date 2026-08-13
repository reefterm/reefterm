# Contributing to Reef Terminal

Reef Terminal is a community-run fork. Contributions of all sizes are welcome — bug fixes, new protocol support, translations, documentation, and design work.

## Before you start

- For anything beyond a small fix, open an issue first to discuss the approach. It saves rework on both sides.
- Check open issues and PRs so you're not duplicating in-flight work.
- By contributing, you agree your changes are licensed under the project's [LICENSE](LICENSE).

## Development setup

```sh
pnpm install
pnpm run dev        # Vite + Electron in watch mode
```

Useful scripts:

```sh
pnpm run lint        # ESLint
pnpm test            # the full test suite (plain Node scripts, no framework)
pnpm run build:renderer   # build the renderer bundle
pnpm run build            # full production build (Windows)
```

## Code style

- No dedicated formatter is enforced yet; match the style already in the file you're editing (4-space indent, semicolons, single quotes).
- `pnpm run lint` must pass before a PR is merged — CI runs it on every push.
- Comments should explain *why*, not *what* — the existing codebase leans heavily on this and it's worth keeping consistent.

## Tests

- Tests live in `test/` as plain Node scripts (no Jest/Mocha) — each stubs `require('electron')` so main-process modules can run outside Electron. Look at an existing test file for the pattern before adding a new one.
- Add or update a test alongside any behavioral change in `src/main/`.

## Commit messages and PRs

- Keep commits focused; a PR that does one thing is easier to review and easier to revert if it turns out to be wrong.
- Describe *why* the change is needed in the PR description, not just what changed — the diff already shows that.
- Fill in the PR template's test plan; "I tested it locally" without specifics isn't enough for anything touching credentials, sync, or the crypto paths.

## Security-sensitive changes

Anything touching `src/main/vault.js`, `src/main/backup.js`, the sync/E2EE code, or credential storage gets extra scrutiny. See [SECURITY.md](SECURITY.md) for how to report a vulnerability privately rather than in a public issue or PR.

## License

Reef Terminal is a fork of [CloudTerm](https://github.com/BradPerbs/cloudterm) by CloudBlast, distributed under the terms of the CloudTerm License — see [LICENSE](LICENSE). By submitting a contribution, you agree it can be distributed under those same terms.
