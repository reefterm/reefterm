/**
 * Exercises plugins/credentials.js: the mapping from a plugin's own host
 * group to how to authenticate, picked by the user in Plugin settings and
 * read only by the connect path - never by the plugin itself.
 */
const assert = require('assert');
const { describe, test } = require('node:test');
const credentials = require('../src/main/plugins/credentials');

describe('credentials: resolve', () => {
    test('an unknown plugin always resolves to prompt', () => {
        assert.deepStrictEqual(credentials.resolve({}, 'com.example.a', 'prod'), { method: 'prompt' });
    });

    test('a plugin with no default and no matching group resolves to prompt', () => {
        const data = { 'com.example.a': { default: { method: 'prompt' }, groups: {} } };
        assert.deepStrictEqual(credentials.resolve(data, 'com.example.a', 'prod'), { method: 'prompt' });
    });

    test('a group with its own mapping wins over the plugin default', () => {
        const data = {
            'com.example.a': {
                default: { method: 'agent' },
                groups: { prod: { method: 'key', keyId: 'key-1' } },
            },
        };
        assert.deepStrictEqual(credentials.resolve(data, 'com.example.a', 'prod'), { method: 'key', keyId: 'key-1' });
    });

    test('a group with no mapping of its own falls back to the plugin default', () => {
        const data = { 'com.example.a': { default: { method: 'agent' }, groups: {} } };
        assert.deepStrictEqual(credentials.resolve(data, 'com.example.a', 'staging'), { method: 'agent' });
    });

    test('no group name at all resolves to the plugin default', () => {
        const data = { 'com.example.a': { default: { method: 'agent' }, groups: { prod: { method: 'agent' } } } };
        assert.deepStrictEqual(credentials.resolve(data, 'com.example.a', ''), { method: 'agent' });
        assert.deepStrictEqual(credentials.resolve(data, 'com.example.a', undefined), { method: 'agent' });
    });

    test('a "key" mapping with no keyId is not trusted to connect with nothing - it resolves to prompt', () => {
        const data = { 'com.example.a': { default: { method: 'key' }, groups: {} } };
        assert.deepStrictEqual(credentials.resolve(data, 'com.example.a', ''), { method: 'prompt' });
    });

    test('a corrupt or unknown method on disk resolves to prompt rather than being trusted', () => {
        const data = { 'com.example.a': { default: { method: 'sudo-as-root' }, groups: {} } };
        assert.deepStrictEqual(credentials.resolve(data, 'com.example.a', ''), { method: 'prompt' });
    });
});

describe('credentials: setMapping', () => {
    test('sets a group mapping without disturbing the plugin default or other groups', () => {
        let data = credentials.setMapping({}, 'com.example.a', 'prod', { method: 'agent' });
        data = credentials.setMapping(data, 'com.example.a', 'staging', { method: 'key', keyId: 'key-2' });

        assert.deepStrictEqual(credentials.resolve(data, 'com.example.a', 'prod'), { method: 'agent' });
        assert.deepStrictEqual(credentials.resolve(data, 'com.example.a', 'staging'), { method: 'key', keyId: 'key-2' });
        assert.deepStrictEqual(credentials.resolve(data, 'com.example.a', ''), { method: 'prompt' });
    });

    test('an empty group name sets the plugin-wide default instead', () => {
        const data = credentials.setMapping({}, 'com.example.a', '', { method: 'key', keyId: 'key-3' });
        assert.deepStrictEqual(credentials.resolve(data, 'com.example.a', 'anything-ungrouped'), { method: 'key', keyId: 'key-3' });
    });

    test('two plugins never share a mapping', () => {
        let data = credentials.setMapping({}, 'com.example.a', '', { method: 'agent' });
        data = credentials.setMapping(data, 'com.example.b', '', { method: 'key', keyId: 'key-4' });

        assert.deepStrictEqual(credentials.resolve(data, 'com.example.a', ''), { method: 'agent' });
        assert.deepStrictEqual(credentials.resolve(data, 'com.example.b', ''), { method: 'key', keyId: 'key-4' });
    });

    test('setting a group mapping again replaces it rather than merging', () => {
        let data = credentials.setMapping({}, 'com.example.a', 'prod', { method: 'key', keyId: 'key-1' });
        data = credentials.setMapping(data, 'com.example.a', 'prod', { method: 'agent' });
        assert.deepStrictEqual(credentials.resolve(data, 'com.example.a', 'prod'), { method: 'agent' });
    });
});

describe('credentials: load/save (reused from grants.js)', () => {
    test('what is saved is what comes back', () => {
        const os = require('os');
        const path = require('path');
        const fs = require('fs');
        const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'rt-test-plugin-credentials-'));
        const file = path.join(dir, 'plugin-credentials.json');

        const data = credentials.setMapping({}, 'com.example.a', 'prod', { method: 'key', keyId: 'key-1' });
        credentials.save(file, data);
        assert.deepStrictEqual(credentials.load(file), data);
    });
});
