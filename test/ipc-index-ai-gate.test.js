/**
 * Pins the actual point of the builtin-plugin gate: a disabled "ai" builtin
 * means src/main/ai/index.js is never require()'d, not merely that its
 * channels are unreachable - ipc-contract.test.js wouldn't catch a
 * regression back to "require it anyway, just skip wiring it up".
 *
 * Same Module._load electron-stub trick as ipc-contract.test.js, duplicated
 * since that file doesn't export its stub.
 */
const fs = require('fs');
const path = require('path');
const os = require('os');
const assert = require('assert');
const { describe, test } = require('node:test');
const Module = require('module');

const ROOT = path.join(__dirname, '..', 'src', 'main');
const AI_INDEX_SUFFIX = path.join('main', 'ai', 'index.js');

class FakeEmitter {
    constructor() { this.handlers = {}; }
    on(event, fn) { (this.handlers[event] ||= []).push(fn); return this; }
    emit(event, ...args) { (this.handlers[event] || []).forEach(fn => fn(...args)); }
}

// A fresh, private userData dir per test, not the shared os.tmpdir() other
// stubs use: builtins.js reads its state file synchronously at construction,
// so a shared path would race against other test files running concurrently.
function buildElectronStub({ onRegister, userDataDir }) {
    return {
        app: Object.assign(new FakeEmitter(), {
            getPath: () => userDataDir,
            getVersion: () => '1.0.0',
            getName: () => 'reefterm',
            isPackaged: false,
            quit: () => {},
        }),
        ipcMain: {
            handle: (channel) => onRegister(channel),
            on: (channel) => onRegister(channel),
            removeHandler: () => {},
        },
        ipcRenderer: { invoke: () => Promise.resolve(), send: () => {}, on: () => {}, removeListener: () => {}, setMaxListeners: () => {} },
        contextBridge: { exposeInMainWorld: () => {} },
        webUtils: { getPathForFile: () => '' },
        dialog: { showOpenDialog: async () => ({ canceled: true }), showSaveDialog: async () => ({ canceled: true }) },
        shell: { openExternal: async () => {}, showItemInFolder: () => {}, openPath: async () => '' },
        clipboard: { readText: () => '', writeText: () => {} },
        powerMonitor: new FakeEmitter(),
        safeStorage: {
            isEncryptionAvailable: () => false,
            encryptString: () => { throw new Error('unavailable'); },
            decryptString: () => { throw new Error('unavailable'); },
        },
        BrowserWindow: function () {},
        screen: { getAllDisplays: () => [] },
        MessageChannelMain: function () { this.port1 = new FakeEmitter(); this.port2 = new FakeEmitter(); },
        net: { fetch: async () => ({ ok: false }) },
        Notification: function () { this.show = () => {}; },
        session: { defaultSession: { webRequest: { onHeadersReceived: () => {} } } },
        webContents: { fromId: () => null },
    };
}

/** Clears every src/main module from require.cache, and returns a fresh ipc/index.js loaded under a stubbed electron. */
function loadIpcIndex(onRegister, userDataDir) {
    const stub = buildElectronStub({ onRegister, userDataDir });
    const realLoad = Module._load;
    Module._load = function (request, parent, isMain) {
        if (request === 'electron') return stub;
        return realLoad.call(this, request, parent, isMain);
    };
    try {
        for (const key of Object.keys(require.cache)) {
            if (key.includes(`${path.sep}main${path.sep}`)) delete require.cache[key];
        }
        return require(path.join(ROOT, 'ipc', 'index.js'));
    } finally {
        Module._load = realLoad;
    }
}

function tempUserDataDir() {
    return fs.mkdtempSync(path.join(os.tmpdir(), 'rt-test-ipc-ai-gate-'));
}

describe('ipc/index.js: the "ai" builtin gate', () => {
    test('disabled: no ai-* channel is registered, and ai/index.js is never required', () => {
        const dir = tempUserDataDir();
        fs.writeFileSync(path.join(dir, 'builtins.json'), JSON.stringify({ 'com.reefterm.builtin.ai': false }));

        const registered = new Set();
        loadIpcIndex((channel) => registered.add(channel), dir).register(() => null);

        const aiChannels = [...registered].filter(channel => channel.startsWith('ai-'));
        assert.deepStrictEqual(aiChannels, []);

        const loaded = Object.keys(require.cache).some(key => key.endsWith(AI_INDEX_SUFFIX));
        assert.strictEqual(loaded, false, 'src/main/ai/index.js was required even though the builtin is disabled');
    });

    test('enabled by default: ai-status is registered, and ai/index.js is required', () => {
        const registered = new Set();
        loadIpcIndex((channel) => registered.add(channel), tempUserDataDir()).register(() => null);

        assert.ok(registered.has('ai-status'));

        const loaded = Object.keys(require.cache).some(key => key.endsWith(AI_INDEX_SUFFIX));
        assert.strictEqual(loaded, true, 'src/main/ai/index.js should have been required with the builtin left at its default (enabled)');
    });
});
