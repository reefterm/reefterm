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
        files: ['tailwind.config.js', 'postcss.config.js', 'eslint.config.js'],
        languageOptions: {
            sourceType: 'commonjs',
            globals: { ...globals.node },
        },
    },
    {
        // vite.config.js uses import/export — Vite transpiles it with esbuild
        // regardless of package.json's module type, so it's ESM for our purposes.
        files: ['vite.config.js'],
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
        rules: {
            'no-unused-vars': ['warn', { argsIgnorePattern: '^_', varsIgnorePattern: '^_' }],
            'no-console': 'off',
        },
    },
];
