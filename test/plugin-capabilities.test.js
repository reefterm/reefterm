/**
 * Exercises plugins/capabilities.js, including the end-to-end path that
 * actually matters: a real plugin, running in the real sandboxed child
 * process, calling hosts.list and getting real store data back with secrets
 * already stripped - not a description of what should happen, the thing
 * itself happening.
 *
 * `electron` is stubbed the same way store.test.js does it, since
 * hosts.list reads through the real store. Real child processes for the
 * end-to-end tests, the same as plugin-host.test.js.
 */
const Module = require('module');
const fs = require('fs');
const path = require('path');
const os = require('os');
const assert = require('assert');
const { describe, test } = require('node:test');
const { createPluginHost } = require('../src/main/plugins/host');

const ROOT = path.join(__dirname, '..', 'src', 'main');

function freshCapabilities() {
    const userData = fs.mkdtempSync(path.join(os.tmpdir(), 'rt-test-plugin-caps-'));
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
        return {
            capabilities: require(path.join(ROOT, 'plugins', 'capabilities')),
            store: require(path.join(ROOT, 'store')),
        };
    } finally {
        Module._load = realLoad;
    }
}

describe('capabilities: the catalog', () => {
    test('hosts.list is registered with a human-readable description', () => {
        const { capabilities } = freshCapabilities();
        assert.strictEqual(capabilities.has('hosts.list'), true);
        assert.match(capabilities.describe('hosts.list'), /saved hosts/);
    });

    test('an unknown capability name is not in the catalog', () => {
        const { capabilities } = freshCapabilities();
        assert.strictEqual(capabilities.has('ssh.exec'), false);
        assert.strictEqual(capabilities.describe('ssh.exec'), '');
    });

    test('list() enumerates every registered capability', () => {
        const { capabilities } = freshCapabilities();
        const names = capabilities.list().map(entry => entry.name);
        assert.ok(names.includes('hosts.list'));
    });
});

describe('capabilities: hosts.list end to end, through the real sandbox', () => {
    test('a plugin granted hosts.list gets real hosts back with no password anywhere in them', async () => {
        const { capabilities, store } = freshCapabilities();
        store.saveHost({ name: 'db', host: '10.0.0.5', authMethod: 'password', password: 'hunter2' });

        const host = createPluginHost();
        capabilities.registerAll(host);

        // A plugin has no fs access at all (proven in plugin-host.test.js), so
        // it cannot write its result to a file for this test to read back -
        // it reports it the same way it does everything else, through a
        // second mediated capability, registered here for the test's own
        // purposes rather than as part of the real catalog.
        let reported;
        host.registerCapability('test.report', async (value) => { reported = value; });

        const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'rt-test-plugin-caps-plugin-'));
        const entry = path.join(dir, 'plugin.js');
        fs.writeFileSync(entry, `
            module.exports = {
                activate: async ({ call }) => {
                    const hosts = await call('hosts.list');
                    await call('test.report', hosts);
                },
            };
        `);

        try {
            await host.start({ id: 'a', entryFile: entry, capabilities: ['hosts.list', 'test.report'] });
        } finally {
            await host.stopAll();
        }

        assert.strictEqual(reported.length, 1);
        assert.strictEqual(reported[0].name, 'db');
        assert.match(reported[0].address, /^10\.0\.0\.5/);
        assert.strictEqual(reported[0].password, undefined);
        assert.strictEqual(JSON.stringify(reported).includes('hunter2'), false);
    });

    test('a plugin not granted hosts.list cannot call it, even though the capability exists', async () => {
        const { capabilities } = freshCapabilities();
        const host = createPluginHost();
        capabilities.registerAll(host);

        let reported;
        host.registerCapability('test.report', async (value) => { reported = value; });

        const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'rt-test-plugin-caps-denied-'));
        const entry = path.join(dir, 'plugin.js');
        fs.writeFileSync(entry, `
            module.exports = {
                activate: async ({ call }) => {
                    try {
                        await call('hosts.list');
                        await call('test.report', 'SHOULD_NOT_REACH_HERE');
                    } catch (error) {
                        await call('test.report', 'refused: ' + error.message);
                    }
                },
            };
        `);

        try {
            await host.start({ id: 'a', entryFile: entry, capabilities: ['test.report'] });
        } finally {
            await host.stopAll();
        }

        assert.match(reported, /refused: This plugin was not granted/);
    });
});
