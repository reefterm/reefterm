/**
 * Exercises plugins/grants.js: persisted consent, and the diff that decides
 * whether a plugin needs to ask again. No electron dependency, so this runs
 * directly against the real module.
 */
const fs = require('fs');
const path = require('path');
const os = require('os');
const assert = require('assert');
const { describe, test } = require('node:test');
const grants = require('../src/main/plugins/grants');

function tempFile() {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'rt-test-plugin-grants-'));
    return path.join(dir, 'plugins.json');
}

describe('grants: load/save', () => {
    test('a missing file loads as empty, not a throw', () => {
        assert.deepStrictEqual(grants.load(path.join(os.tmpdir(), 'rt-does-not-exist-' + Date.now())), {});
    });

    test('a corrupt file loads as empty rather than crashing', () => {
        const file = tempFile();
        fs.writeFileSync(file, '{not json');
        assert.deepStrictEqual(grants.load(file), {});
    });

    test('a file holding a JSON array (wrong shape) loads as empty', () => {
        const file = tempFile();
        fs.writeFileSync(file, '[]');
        assert.deepStrictEqual(grants.load(file), {});
    });

    test('what is saved is what comes back', () => {
        const file = tempFile();
        const data = { 'com.example.a': { granted: ['hosts.list'], enabled: true } };
        grants.save(file, data);
        assert.deepStrictEqual(grants.load(file), data);
    });

    test('save creates its parent directory if it does not exist yet', () => {
        const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'rt-test-plugin-grants-'));
        const file = path.join(dir, 'nested', 'plugins.json');
        grants.save(file, {});
        assert.strictEqual(fs.existsSync(file), true);
    });
});

describe('grants: pendingCapabilities', () => {
    test('a brand new plugin (nothing granted yet) needs everything it requests', () => {
        assert.deepStrictEqual(grants.pendingCapabilities([], ['hosts.list', 'ssh.exec']), ['hosts.list', 'ssh.exec']);
    });

    test('nothing pending once every requested capability is already granted', () => {
        assert.deepStrictEqual(grants.pendingCapabilities(['hosts.list', 'ssh.exec'], ['hosts.list']), []);
    });

    test('a plugin update requesting one more capability only asks for the new one', () => {
        assert.deepStrictEqual(grants.pendingCapabilities(['hosts.list'], ['hosts.list', 'ssh.exec']), ['ssh.exec']);
    });

    test('a capability the plugin no longer requests is simply not pending (not an error)', () => {
        assert.deepStrictEqual(grants.pendingCapabilities(['hosts.list', 'ssh.exec'], ['hosts.list']), []);
    });

    test('handles a missing granted list as though it were empty', () => {
        assert.deepStrictEqual(grants.pendingCapabilities(undefined, ['hosts.list']), ['hosts.list']);
    });
});
