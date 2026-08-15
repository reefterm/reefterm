# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## What this is

Reef Terminal: an Electron + React + xterm.js terminal client (SSH, SFTP, Telnet, serial, RDP/VNC), with an
optional AI agent panel that drives a local Claude Code / Codex / OpenCode CLI against the session on screen.
A community fork of CloudTerm, licensed under a fair-code license (see LICENSE) — not MIT, don't assume it.

## Commands

Use **pnpm**, not npm.

```sh
pnpm install               # also builds preload.js (postinstall) and applies patch-package
pnpm run dev                # Vite + Electron in watch mode — normal way to run the app locally
pnpm run lint                # ESLint over the whole repo; must pass before merge
pnpm run lint:fix
pnpm test                   # full suite: node:test (main process) + Vitest (renderer)
pnpm run test:renderer        # Vitest only
pnpm run test:renderer:watch
pnpm run build:preload       # rebuild src/main/preload.js after editing src/main/preload/**
pnpm run build               # full production build → dist/ (electron-builder, Windows target)
```

Single test file:
- Main process (`node:test`): `node --test test/vault.test.js`
- Renderer (Vitest): `pnpm exec vitest run test-renderer/components/Foo.test.jsx`

There is no dedicated formatter. Match the file you're in: 4-space indent, semicolons, single quotes.

## Architecture

### Two runners, split by where the code executes

- `src/main/**` — Electron main process, CommonJS, tested with Node's built-in `node:test` under `test/`.
  Each test stubs `require('electron')` so it runs outside Electron entirely.
- `src/renderer/**` — React UI, ESM/JSX, tested with Vitest + jsdom + React Testing Library under
  `test-renderer/` (a *sibling* of `test/`, not a subfolder — `node:test`'s default discovery treats every
  `.js` under any directory literally named `test` as a test to run, which would otherwise catch
  `test-renderer/setup.js`).

Look at a neighboring test file before adding a new one; the two styles are not interchangeable.

### Main process layout (`src/main/`)

One file per feature at the top level (`ssh.js`, `sftp.js`, `vault.js`, `tunnels.js`, `rdp.js`, `vnc.js`,
`bmc.js`, `transfers.js`, `backup.js`, ...), plus subdirectories that mirror that same one-feature-per-file
split for a specific layer:

- `ipc/` — one file per feature registering its `ipcMain.handle` channels. All of them go through
  `ipc/index.js`, which wires every feature against a shared `ctx` (`handle`, `getWindow`, `notify`,
  `requestTrust`, `requestKeyboardInteractive`). `handle()` is the single choke point that refuses every
  channel except `app-lock-status`/`app-lock-unlock` while the vault is locked — enforced in the main
  process because a renderer-side check can be stepped around by anything with a handle on the page.
- `preload/` — one file per feature exposed on `window.api` via `contextBridge`. **Cannot be
  `require()`'d directly by Electron**: `main.js` sets `sandbox: true`, and a sandboxed preload's loader
  only resolves Node builtins and `electron`, not local project files. `scripts/build-preload.js` (esbuild)
  bundles `preload/index.js` into the single committed-gitignored `src/main/preload.js` that
  `webPreferences.preload` actually points at. That bundle is **not tracked in git** — it's rebuilt by
  `postinstall`, and again by `start`/`dev:electron`/`build`, so it can never go stale silently. After
  editing anything under `src/main/preload/`, just re-run whichever of those commands you're using, or
  `pnpm run build:preload` directly.
- `store/` — persisted app data (hosts, keys, snippets, folders, proxies, backup import/export), aggregated
  through `store/index.js`.
- `ai/` — the agent integration: `providers/` (claude-code.js, codex.js, opencode.js — each drives the
  matching CLI as a subprocess under the user's own account/credentials, nothing pasted or re-hosted),
  `tools.js` (what the agent is allowed to do), `mcp-host.js`, `exec.js`, `prompt.js`.
- `plugins/` — the plugin system, two trust tiers:
  - `builtins.js` / `registry.js` are for first-party code (e.g. the AI providers) that's `require()`'d
    directly and has the same access to `store`/`ssh` as any other main-process file.
  - `host.js` + `host-runtime.js` are the sandbox for actual third-party plugin code: each plugin runs in
    its own `child_process.fork()`, and the only thing it can reach is a `call(name, ...args)` function
    gated by capabilities the host explicitly registered *and* that specific plugin was granted at
    `start()` time. `host.js`'s own header explains the boundary in detail — read it before touching this
    layer, since it's the one place in the app deliberately designed to distrust code it's running.

### Renderer layout (`src/renderer/`)

- `components/` — by feature (also has feature subfolders: `terminal/`, `sftp/`, `settings/`, `assistant/`,
  `hosts/`, `panes/`, `tunnels/`, `desktop/`, `bmc/`, `proxies/`, `snippets/`, `ui/`).
- `hooks/` — state, one hook per concern (`useSshConnection`, `useTabs`, `usePlugins`, `useAssistant`, ...).
- `lib/` — pure functions, no React.
- Everything talks to the main process through `window.api.*`, the surface `preload/index.js` assembles.

### IPC contract

`test/ipc-contract.test.js` runs both `preload/` and `ipc/` for real (under a stubbed `electron`) and checks
every channel `window.api` calls has a matching `ipcMain.handle` registration, and vice versa. With
registrations spread across ~19 files on each side, this is what catches a channel-name typo — grepping for
channel strings misses multi-line calls. If you add or rename an IPC channel, this test will fail fast if
the two sides drift.

## Conventions

- Comments explain *why*, not *what* — the codebase leans on this heavily (see the file headers in
  `ipc/index.js`, `plugins/host.js`, `build-preload.js` for the tone/depth expected). Match it.
- This is a strict low-comment environment: default to no comment. Add one only when it's absolutely
  necessary to explain flow — a hidden constraint, a non-obvious ordering, a reason something is *not* done
  the obvious way. When one is warranted, write it as a load-bearing sentence (a complete, information-dense
  sentence, not a fragment or a full book) so it earns its line instead of adding bloat.
- Security-sensitive files get extra scrutiny: `src/main/vault.js`, `src/main/backup.js`, the sync/E2EE
  code, and anything handling credentials. Be conservative with changes there.
- `no-unused-vars` is a warning, prefix with `_` to intentionally ignore (`argsIgnorePattern`/
  `varsIgnorePattern: '^_'`).
- For anything beyond a small fix, the project's own contributing guidance (`.github/CONTRIBUTING.md`)
  says to raise the approach as an issue first — worth surfacing to the user if a task looks large.
