/**
 * Exercises plugins/discover.js: scanning a plugins directory and reporting
 * what it found, one entry per subdirectory, without letting a single
 * malformed plugin hide or crash the scan of the rest.
 *
 * `electron` is stubbed the same way store.test.js does it, since
 * discover.js pulls in capabilities.js, which reads through the real store.
 */
const Module = require('module');
const fs = require('fs');
const path = require('path');
const os = require('os');
const assert = require('assert');
const { describe, test } = require('node:test');

const ROOT = path.join(__dirname, '..', 'src', 'main');

function freshDiscover() {
    const userData = fs.mkdtempSync(path.join(os.tmpdir(), 'rt-test-plugin-discover-'));
    const electronStub = {
        app: { getPath: (what) => (what === 'userData' ? userData : os.tmpdir()), getVersion: () => '1.0.0', on: () => {} },
        safeStorage: {
            isEncryptionAvailable: () => false,
            encryptString: () => { throw new Error('unavailable'); },
            decryptString: () => { throw new Error('unavailable'); },
        },
    };

    const realLoad = Module._load;
    Module._load = function (request, parent, isMain) {
        if (request === 'electron') return electronStub;
        return realLoad.call(this, request, parent, isMain);
    };
    try {
        for (const key of Object.keys(require.cache)) {
            if (key.includes(`${path.sep}main${path.sep}`)) delete require.cache[key];
        }
        return require(path.join(ROOT, 'plugins', 'discover'));
    } finally {
        Module._load = realLoad;
    }
}

function pluginsRoot() {
    return fs.mkdtempSync(path.join(os.tmpdir(), 'rt-test-plugins-root-'));
}

function writePlugin(root, id, fields, { skipManifest = false } = {}) {
    const dir = path.join(root, id);
    fs.mkdirSync(dir, { recursive: true });
    if (!skipManifest) {
        fs.writeFileSync(path.join(dir, 'plugin.json'), JSON.stringify({
            id, name: id, version: '0.1.0', entry: 'index.js', capabilities: [],
            ...fields,
        }));
    }
    fs.writeFileSync(path.join(dir, 'index.js'), 'module.exports = { activate: async () => {} };');
    return dir;
}

describe('discover: scan', () => {
    test('a missing plugins root is not an error, just nothing found', () => {
        const discover = freshDiscover();
        assert.deepStrictEqual(discover.scan(path.join(os.tmpdir(), 'rt-does-not-exist-' + Date.now())), []);
    });

    test('an empty plugins root reports nothing', () => {
        const discover = freshDiscover();
        assert.deepStrictEqual(discover.scan(pluginsRoot()), []);
    });

    test('a well-formed plugin is found, and gets its config/data/logs structure created', () => {
        const discover = freshDiscover();
        const root = pluginsRoot();
        writePlugin(root, 'com.example.good', { capabilities: ['hosts.list'] });

        const found = discover.scan(root);
        assert.strictEqual(found.length, 1);
        assert.strictEqual(found[0].ok, true);
        assert.strictEqual(found[0].id, 'com.example.good');
        assert.deepStrictEqual(found[0].manifest.capabilities, ['hosts.list']);

        for (const sub of ['config', 'data', 'logs']) {
            assert.strictEqual(fs.statSync(path.join(found[0].dir, sub)).isDirectory(), true);
        }
    });

    test('a plugin with a malformed manifest is reported, not thrown, and names why', () => {
        const discover = freshDiscover();
        const root = pluginsRoot();
        writePlugin(root, 'com.example.broken', {}, { skipManifest: true });

        const found = discover.scan(root);
        assert.strictEqual(found.length, 1);
        assert.strictEqual(found[0].ok, false);
        assert.ok(found[0].error);
    });

    test('a plugin requesting an unknown capability is refused, naming which one', () => {
        const discover = freshDiscover();
        const root = pluginsRoot();
        writePlugin(root, 'com.example.overreaching', { capabilities: ['ssh.exec', 'read.vault'] });

        const found = discover.scan(root);
        assert.strictEqual(found[0].ok, false);
        assert.match(found[0].error, /ssh\.exec/);
    });

    test('one malformed plugin does not hide or break discovery of the others', () => {
        const discover = freshDiscover();
        const root = pluginsRoot();
        writePlugin(root, 'com.example.good', { capabilities: [] });
        writePlugin(root, 'com.example.broken', {}, { skipManifest: true });
        writePlugin(root, 'com.example.also-good', { capabilities: ['hosts.list'] });

        const found = discover.scan(root);
        assert.strictEqual(found.length, 3);
        const byId = new Map(found.map(entry => [entry.id, entry]));
        assert.strictEqual(byId.get('com.example.good').ok, true);
        assert.strictEqual(byId.get('com.example.also-good').ok, true);
        assert.strictEqual(byId.get('com.example.broken').ok, false);
    });

    test('a stray file in the plugins root (not a directory) is silently ignored', () => {
        const discover = freshDiscover();
        const root = pluginsRoot();
        fs.writeFileSync(path.join(root, 'readme.txt'), 'not a plugin');
        writePlugin(root, 'com.example.good', { capabilities: [] });

        const found = discover.scan(root);
        assert.strictEqual(found.length, 1);
        assert.strictEqual(found[0].id, 'com.example.good');
    });

    test('the reserved com.reefterm namespace is refused for a drop-in plugin', () => {
        const discover = freshDiscover();
        const root = pluginsRoot();
        writePlugin(root, 'com.reefterm.builtin.fake', { id: 'com.reefterm.builtin.fake', capabilities: [] });

        const found = discover.scan(root);
        assert.strictEqual(found[0].ok, false);
        assert.match(found[0].error, /reserved/);
    });
});
