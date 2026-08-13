/**
 * Bundle the preload script.
 *
 * Electron's sandboxed preload (main.js sets `sandbox: true`, deliberately)
 * loads through a restricted module loader that only resolves Node builtins
 * and `electron` itself — it cannot `require()` a local project file at all,
 * with or without an extension. So src/main/preload/ is organised into one
 * file per feature the way src/main/ipc/ and src/main/store/ are, but has to
 * reach Electron as the single file that loader needs. This is that step:
 * bundle src/main/preload/index.js and everything it requires into
 * src/main/preload.js, which main.js already points `webPreferences.preload`
 * at, so nothing else has to know the source is split.
 *
 * The output is gitignored and rebuilt here rather than committed: a stale
 * bundle would silently expose a different IPC surface than the source
 * describes, which is a worse failure than the thing this script costs to
 * run (well under a second). Run by `postinstall`, and again right before
 * `start`/`dev:electron` and in `build`, so it can never be missing or stale
 * at the point Electron actually reads it.
 */
const esbuild = require('esbuild');
const path = require('path');

const ROOT = path.join(__dirname, '..');
const ENTRY = path.join(ROOT, 'src', 'main', 'preload', 'index.js');
const OUTPUT = path.join(ROOT, 'src', 'main', 'preload.js');

esbuild.buildSync({
    entryPoints: [ENTRY],
    outfile: OUTPUT,
    bundle: true,
    platform: 'node',
    format: 'cjs',
    // Provided by Electron's preload context at runtime; bundling it in would
    // both be pointless (it is a native binding, not JS) and drag in code
    // paths esbuild cannot resolve.
    external: ['electron'],
    logLevel: 'silent',
});

console.log(`build-preload: wrote ${path.relative(ROOT, OUTPUT)}`);
