const js = require('@eslint/js');
const react = require('eslint-plugin-react');
const reactHooks = require('eslint-plugin-react-hooks');
const globals = require('globals');

module.exports = [
    {
        ignores: [
            'dist/**',
            'build/**',
            'node_modules/**',
            'resources/**',
            'src/renderer/styles.css',
            // Bundled from src/main/preload/ by scripts/build-preload.js.
            'src/main/preload.js',
            'patches/**',
        ],
    },
    js.configs.recommended,
    {
        // Electron main process: CommonJS, Node globals.
        files: ['src/main/**/*.js', 'scripts/**/*.js', 'test/**/*.js'],
        languageOptions: {
            sourceType: 'commonjs',
            globals: { ...globals.node },
        },
    },
    {
        // Root-level tooling config that's plain CommonJS (no package.json
        // "type": "module", so these run as CJS under plain Node).
        files: ['tailwind.config.js', 'postcss.config.js', 'eslint.config.js', 'commitlint.config.js'],
        languageOptions: {
            sourceType: 'commonjs',
            globals: { ...globals.node },
        },
    },
    {
        // vite.config.js uses import/export — Vite transpiles it with esbuild
        // regardless of package.json's module type, so it's ESM for our
        // purposes. vitest.config.mjs is ESM outright, by its extension.
        files: ['vite.config.js', 'vitest.config.mjs'],
        languageOptions: {
            sourceType: 'module',
            ecmaVersion: 'latest',
            globals: { ...globals.node },
        },
    },
    {
        // Renderer: ESM/JSX, browser globals, React.
        files: ['src/renderer/**/*.{js,jsx}'],
        plugins: { react, 'react-hooks': reactHooks },
        languageOptions: {
            sourceType: 'module',
            ecmaVersion: 'latest',
            parserOptions: { ecmaFeatures: { jsx: true } },
            globals: { ...globals.browser },
        },
        settings: { react: { version: '18.2' } },
        rules: {
            ...react.configs.recommended.rules,
            ...reactHooks.configs.recommended.rules,
            'react/react-in-jsx-scope': 'off',
            'react/prop-types': 'off',
            // Electron's <webview> tag carries its own non-standard attributes.
            'react/no-unknown-property': ['error', { ignore: ['partition', 'allowpopups'] }],
        },
    },
    {
        // Renderer tests (Vitest + jsdom): same shape as the renderer itself,
        // ESM/JSX with browser globals for the DOM jsdom simulates. Node
        // globals too - Vitest itself runs under Node, and setup.js is part
        // of this same tree.
        //
        // A sibling of test/, not test/renderer/: node:test's own default
        // discovery treats every .js file under any directory literally
        // named `test` as a test to run, which setup.js is not.
        files: ['test-renderer/**/*.{js,jsx}'],
        plugins: { react, 'react-hooks': reactHooks },
        languageOptions: {
            sourceType: 'module',
            ecmaVersion: 'latest',
            parserOptions: { ecmaFeatures: { jsx: true } },
            globals: { ...globals.browser, ...globals.node },
        },
        settings: { react: { version: '18.2' } },
        rules: {
            ...react.configs.recommended.rules,
            ...reactHooks.configs.recommended.rules,
            'react/react-in-jsx-scope': 'off',
            'react/prop-types': 'off',
        },
    },
    {
        rules: {
            'no-unused-vars': ['warn', { argsIgnorePattern: '^_', varsIgnorePattern: '^_' }],
            'no-console': 'off',
        },
    },
];
