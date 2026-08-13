import { defineConfig } from 'vitest/config';
import react from '@vitejs/plugin-react';
import path from 'path';

// Deliberately not sharing vite.config.js: that one is shaped around building
// the renderer into dist/ (its own `root`, `build.outDir`, the WASM asset
// plugin), none of which a test run wants. The one thing worth keeping in
// step with it is the `@` alias, since a spec importing app code has to
// resolve it the same way the app itself does.
export default defineConfig({
    plugins: [react()],
    resolve: {
        alias: {
            '@': path.join(__dirname, 'src/renderer'),
        },
    },
    test: {
        environment: 'jsdom',
        include: ['test-renderer/**/*.test.jsx'],
        setupFiles: ['test-renderer/setup.js'],
        // Explicit imports (describe/test/expect from 'vitest'), matching the
        // rest of the suite's node:test style, rather than injected globals.
        globals: false,
    },
});
