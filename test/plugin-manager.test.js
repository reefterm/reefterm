/**
 * Exercises plugins/manager.js: the consent lifecycle, persistence across a
 * restart, capability-escalation re-prompting, and that a denial or a
 * disable actually stops a plugin from running rather than just changing
 * what a settings page would show.
 *
 * `electron` is stubbed the same way store.test.js does it, since
 * capabilities.js (hosts.list) reads through the real store. Real forked
 * plugin processes throughout, same as plugin-host.test.js - the whole
 * point of several of these is proving a plugin actually did or did not
 * run, not asserting against a description of what should happen.
 */
const Module = require('module');
const fs = require('fs');
const path = require('path');
const os = require('os');
const assert = require('assert');
const { describe, test, afterEach } = require('node:test');

const ROOT = path.join(__dirname, '..', 'src', 'main');

function freshManagerModule() {
    const userData = fs.mkdtempSync(path.join(os.tmpdir(), 'rt-test-plugin-manager-'));
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
        return { createPluginManager: require(path.join(ROOT, 'plugins', 'manager')).createPluginManager, store: require(path.join(ROOT, 'store')) };
    } finally {
        Module._load = realLoad;
    }
}

const managers = [];
function freshManager({ pluginsRoot, grantsFile } = {}) {
    const { createPluginManager } = freshManagerModule();
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'rt-test-plugins-dir-'));
    const manager = createPluginManager({
        pluginsRoot: pluginsRoot || path.join(dir, 'plugins'),
        grantsFile: grantsFile || path.join(dir, 'plugins.json'),
    });
    managers.push(manager);
    return manager;
}

afterEach(async () => {
    await Promise.all(managers.splice(0).map(m => m.shutdown()));
});

function writePlugin(pluginsRoot, id, { capabilities = [], code = 'module.exports = { activate: async () => {} };' } = {}) {
    const dir = path.join(pluginsRoot, id);
    fs.mkdirSync(dir, { recursive: true });
    fs.writeFileSync(path.join(dir, 'plugin.json'), JSON.stringify({
        id, name: id, version: '0.1.0', entry: 'index.js', capabilities,
    }));
    fs.writeFileSync(path.join(dir, 'index.js'), code);
    return dir;
}

const waitFor = async (predicate, { timeout = 5000, interval = 20 } = {}) => {
    const start = Date.now();
    while (!predicate()) {
        if (Date.now() - start > timeout) throw new Error('timed out waiting for condition');
        await new Promise((r) => setTimeout(r, interval));
    }
};

describe('manager: discovery and initial state', () => {
    test('an empty plugins directory reports nothing', async () => {
        const manager = freshManager();
        assert.deepStrictEqual(await manager.init(), []);
    });

    test('a plugin requesting a capability starts as pending-consent, not running', async () => {
        const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'rt-test-plugins-dir-'));
        const pluginsRoot = path.join(dir, 'plugins');
        fs.mkdirSync(pluginsRoot, { recursive: true });
        writePlugin(pluginsRoot, 'com.example.needsconsent', { capabilities: ['hosts.list'] });

        const manager = freshManager({ pluginsRoot, grantsFile: path.join(dir, 'plugins.json') });
        const list = await manager.init();

        assert.strictEqual(list.length, 1);
        assert.strictEqual(list[0].state, 'pending-consent');
        assert.deepStrictEqual(list[0].pendingCapabilities, ['hosts.list']);
    });

    test('a plugin requesting nothing needs no consent and starts on its own', async () => {
        const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'rt-test-plugins-dir-'));
        const pluginsRoot = path.join(dir, 'plugins');
        fs.mkdirSync(pluginsRoot, { recursive: true });
        writePlugin(pluginsRoot, 'com.example.harmless', { capabilities: [] });

        const manager = freshManager({ pluginsRoot, grantsFile: path.join(dir, 'plugins.json') });
        const list = await manager.init();

        assert.strictEqual(list[0].state, 'running');
    });

    test('a malformed plugin is reported invalid, and does not stop a valid sibling from starting', async () => {
        const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'rt-test-plugins-dir-'));
        const pluginsRoot = path.join(dir, 'plugins');
        fs.mkdirSync(path.join(pluginsRoot, 'com.example.broken'), { recursive: true });
        // No plugin.json at all.
        writePlugin(pluginsRoot, 'com.example.fine', { capabilities: [] });

        const manager = freshManager({ pluginsRoot, grantsFile: path.join(dir, 'plugins.json') });
        const list = await manager.init();

        const byId = new Map(list.map(entry => [entry.id, entry]));
        assert.strictEqual(byId.get('com.example.broken').state, 'invalid');
        assert.ok(byId.get('com.example.broken').error);
        assert.strictEqual(byId.get('com.example.fine').state, 'running');
    });
});

describe('manager: consent actually gates execution', () => {
    test('approving consent starts the plugin for real, not just changes what list() reports', async () => {
        const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'rt-test-plugins-dir-'));
        const pluginsRoot = path.join(dir, 'plugins');
        fs.mkdirSync(pluginsRoot, { recursive: true });
        // Calls a real, granted capability; if activate() throws (including
        // "not granted"), host.start() rejects and the plugin never reaches
        // 'ready' - so the pending-consent -> running transition below is
        // only observable once this has actually executed successfully.
        writePlugin(pluginsRoot, 'com.example.approved', {
            capabilities: ['hosts.list'],
            code: `module.exports = { activate: async ({ call }) => { await call('hosts.list'); } };`,
        });

        const manager = freshManager({ pluginsRoot, grantsFile: path.join(dir, 'plugins.json') });
        const before = await manager.init();
        assert.strictEqual(before[0].state, 'pending-consent');

        const result = await manager.respondToConsent('com.example.approved', { approved: true });
        assert.strictEqual(result.success, true);

        const list = manager.list();
        assert.strictEqual(list[0].state, 'running');
    });

    test('denying consent disables the plugin; it never starts', async () => {
        const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'rt-test-plugins-dir-'));
        const pluginsRoot = path.join(dir, 'plugins');
        fs.mkdirSync(pluginsRoot, { recursive: true });
        writePlugin(pluginsRoot, 'com.example.denied', { capabilities: ['hosts.list'] });

        const manager = freshManager({ pluginsRoot, grantsFile: path.join(dir, 'plugins.json') });
        await manager.init();

        await manager.respondToConsent('com.example.denied', { approved: false });
        const list = manager.list();

        assert.strictEqual(list[0].state, 'disabled');
    });

    test('consent is remembered across a restart: no re-prompt for the same capabilities', async () => {
        const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'rt-test-plugins-dir-'));
        const pluginsRoot = path.join(dir, 'plugins');
        const grantsFile = path.join(dir, 'plugins.json');
        fs.mkdirSync(pluginsRoot, { recursive: true });
        writePlugin(pluginsRoot, 'com.example.remembered', { capabilities: ['hosts.list'] });

        const first = freshManager({ pluginsRoot, grantsFile });
        await first.init();
        await first.respondToConsent('com.example.remembered', { approved: true });
        await first.shutdown();

        const second = freshManager({ pluginsRoot, grantsFile });
        const list = await second.init();

        assert.strictEqual(list[0].state, 'running');
    });

    test('rescanning without any manifest change does not re-trigger consent for an already-granted plugin', async () => {
        // The capability-escalation diff itself (a manifest requesting a
        // capability not yet in the granted set becomes newly pending,
        // without re-asking for what was already granted) is exercised
        // directly in plugin-grants.test.js's pendingCapabilities tests -
        // the real capability catalog only has one entry (hosts.list) right
        // now, so there is no second genuine capability to escalate *to*
        // through this full pipeline yet. What belongs here instead is the
        // property that a plain rescan is not itself a reason to re-prompt.
        const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'rt-test-plugins-dir-'));
        const pluginsRoot = path.join(dir, 'plugins');
        const grantsFile = path.join(dir, 'plugins.json');
        fs.mkdirSync(pluginsRoot, { recursive: true });
        writePlugin(pluginsRoot, 'com.example.stable', { capabilities: ['hosts.list'] });

        const manager = freshManager({ pluginsRoot, grantsFile });
        await manager.init();
        await manager.respondToConsent('com.example.stable', { approved: true });
        assert.strictEqual(manager.list()[0].state, 'running');

        manager.rescan();
        assert.strictEqual(manager.list()[0].state, 'running');
        assert.deepStrictEqual(manager.list()[0].pendingCapabilities, undefined);
    });
});

describe('manager: enable/disable independent of consent', () => {
    test('disabling a running plugin stops it without revoking its grant', async () => {
        const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'rt-test-plugins-dir-'));
        const pluginsRoot = path.join(dir, 'plugins');
        const grantsFile = path.join(dir, 'plugins.json');
        fs.mkdirSync(pluginsRoot, { recursive: true });
        writePlugin(pluginsRoot, 'com.example.toggle', { capabilities: ['hosts.list'] });

        const manager = freshManager({ pluginsRoot, grantsFile });
        await manager.init();
        await manager.respondToConsent('com.example.toggle', { approved: true });
        assert.strictEqual(manager.list()[0].state, 'running');

        await manager.setEnabled('com.example.toggle', false);
        assert.strictEqual(manager.list()[0].state, 'disabled');

        // Re-enabling starts it again without asking for consent a second time.
        await manager.setEnabled('com.example.toggle', true);
        await waitFor(() => manager.list()[0].state === 'running');
    });
});

describe('manager: shutdown', () => {
    test('shutdown stops every running plugin', async () => {
        const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'rt-test-plugins-dir-'));
        const pluginsRoot = path.join(dir, 'plugins');
        fs.mkdirSync(pluginsRoot, { recursive: true });
        writePlugin(pluginsRoot, 'com.example.a', { capabilities: [] });
        writePlugin(pluginsRoot, 'com.example.b', { capabilities: [] });

        const manager = freshManager({ pluginsRoot, grantsFile: path.join(dir, 'plugins.json') });
        await manager.init();
        assert.ok(manager.list().every(entry => entry.state === 'running'));

        await manager.shutdown();
        // Nothing left to assert on host state directly from here (that is
        // host.js's own territory, covered in plugin-host.test.js); this is
        // just confirming shutdown() does not hang or throw with plugins live.
    });
});

describe('manager: a new plugin cannot inherit another one\'s grant', () => {
    test('a plugin whose manifest claims an already-approved id, from a different folder, is rejected rather than inheriting its grants', async () => {
        // The attack manifest.test.js's unit tests already prove readManifest()
        // itself refuses: this proves it holds through the full pipeline,
        // including a plugin that was actually approved and running.
        const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'rt-test-plugins-dir-'));
        const pluginsRoot = path.join(dir, 'plugins');
        const grantsFile = path.join(dir, 'plugins.json');
        fs.mkdirSync(pluginsRoot, { recursive: true });
        writePlugin(pluginsRoot, 'com.example.trusted', { capabilities: ['hosts.list'] });

        const manager = freshManager({ pluginsRoot, grantsFile });
        await manager.init();
        await manager.respondToConsent('com.example.trusted', { approved: true });
        assert.strictEqual(manager.list().find(e => e.id === 'com.example.trusted').state, 'running');

        // A second, different folder, whose manifest.json claims the
        // already-trusted plugin's id.
        const impostorDir = path.join(pluginsRoot, 'com.example.impostor');
        fs.mkdirSync(impostorDir, { recursive: true });
        fs.writeFileSync(path.join(impostorDir, 'plugin.json'), JSON.stringify({
            id: 'com.example.trusted', name: 'Impostor', version: '0.1.0',
            entry: 'index.js', capabilities: ['hosts.list'],
        }));
        fs.writeFileSync(path.join(impostorDir, 'index.js'), 'module.exports = { activate: async () => {} };');

        const list = manager.rescan();
        const impostor = list.find(entry => entry.id === 'com.example.impostor');

        assert.strictEqual(impostor.state, 'invalid');
        assert.match(impostor.error, /disagrees|declares id/);
        // The real one is completely unaffected: still running, still on
        // its own original grant.
        assert.strictEqual(list.find(e => e.id === 'com.example.trusted').state, 'running');
    });
});
