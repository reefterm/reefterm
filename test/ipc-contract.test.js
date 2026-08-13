/**
 * The boundary between preload.js's exposed `window.api` and the channels
 * ipc/ registers. Splitting both of them into per-feature files (see
 * src/main/ipc/ and src/main/preload/) removed the one thing that used to
 * make a channel-name typo impossible to miss by accident: everything living
 * in the same two files, side by side. This is that safety net instead -
 * every channel preload can actually call has to have a matching handler
 * registered in ipc, or a typo on either side silently strands a feature
 * (the renderer call rejects with "No handler registered", the kind of
 * failure that only shows up when someone clicks the button).
 *
 * Runs both sides for real, under a stubbed `electron`, rather than grepping
 * for channel strings: a call spanning more than one line (there is exactly
 * one, sync-connection-recover-complete) defeats a regex but not an actual
 * function call.
 */
const path = require('path');
const os = require('os');
const assert = require('assert');
const { describe, test } = require('node:test');
const Module = require('module');

const ROOT = path.join(__dirname, '..', 'src', 'main');

class FakeEmitter {
    constructor() { this.handlers = {}; }
    on(event, fn) { (this.handlers[event] ||= []).push(fn); return this; }
    emit(event, ...args) { (this.handlers[event] || []).forEach(fn => fn(...args)); }
}

/** Everything both preload.js's tree and ipc/'s tree touch on `electron`. */
function buildElectronStub({ onRegister, onCall }) {
    return {
        app: Object.assign(new FakeEmitter(), {
            getPath: () => os.tmpdir(),
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
        ipcRenderer: {
            invoke: (channel) => { onCall(channel); return Promise.resolve(); },
            send: (channel) => onCall(channel),
            on: () => {},
            removeListener: () => {},
            setMaxListeners: () => {},
        },
        contextBridge: { exposeInMainWorld: () => {} },
        webUtils: { getPathForFile: () => '' },
        dialog: {
            showOpenDialog: async () => ({ canceled: true }),
            showSaveDialog: async () => ({ canceled: true }),
        },
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
        MessageChannelMain: function () {
            this.port1 = new FakeEmitter();
            this.port2 = new FakeEmitter();
        },
        net: { fetch: async () => ({ ok: false }) },
        Notification: function () { this.show = () => {}; },
        session: { defaultSession: { webRequest: { onHeadersReceived: () => {} } } },
        webContents: { fromId: () => null },
    };
}

/** Calls every function reachable from `node`, ignoring whatever they throw. */
function callEveryFunction(node, seen = new Set()) {
    if (!node || typeof node !== 'object' || seen.has(node)) return;
    seen.add(node);
    for (const value of Object.values(node)) {
        if (typeof value === 'function') {
            // Every leaf here is `(...args) => ipcRenderer.invoke(channel, ...)`
            // or a `subscribe(channel, cb)` wrapper; an empty object satisfies
            // any destructuring these take, and the invoke/send call (if any)
            // happens before anything a bad argument could throw on.
            try { value({}, {}, {}, {}); } catch { /* only the call, if any, matters */ }
        } else if (value && typeof value === 'object') {
            callEveryFunction(value, seen);
        }
    }
}

function loadWithStub(relativePath, { onRegister = () => {}, onCall = () => {} } = {}) {
    const stub = buildElectronStub({ onRegister, onCall });
    const realLoad = Module._load;
    Module._load = function (request, parent, isMain) {
        if (request === 'electron') return stub;
        return realLoad.call(this, request, parent, isMain);
    };
    try {
        for (const key of Object.keys(require.cache)) {
            if (key.includes(`${path.sep}main${path.sep}`)) delete require.cache[key];
        }
        return require(path.join(ROOT, relativePath));
    } finally {
        Module._load = realLoad;
    }
}

describe('ipc/preload channel contract', () => {
    test('every channel preload.js can invoke or send is registered in ipc/', () => {
        const registered = new Set();
        loadWithStub('ipc/index.js', { onRegister: (c) => registered.add(c) })
            .register(() => null);

        const invoked = new Set();
        // preload.js calls contextBridge.exposeInMainWorld at require time, so
        // the whole tree runs just by requiring it; walk the module's own
        // namespace objects by re-requiring each preload/* file directly
        // instead of trying to recover the exposed object from the stub.
        const preloadDir = path.join(ROOT, 'preload');
        const stub = buildElectronStub({ onRegister: () => {}, onCall: (c) => invoked.add(c) });
        const realLoad = Module._load;
        Module._load = function (request, parent, isMain) {
            if (request === 'electron') return stub;
            return realLoad.call(this, request, parent, isMain);
        };
        try {
            for (const key of Object.keys(require.cache)) {
                if (key.includes(`${path.sep}main${path.sep}`)) delete require.cache[key];
            }
            const fs = require('fs');
            for (const file of fs.readdirSync(preloadDir)) {
                if (file === 'channel.js' || !file.endsWith('.js')) continue;
                callEveryFunction(require(path.join(preloadDir, file)));
            }
        } finally {
            Module._load = realLoad;
        }

        const orphaned = [...invoked].filter((channel) => !registered.has(channel));
        assert.deepStrictEqual(
            orphaned,
            [],
            `preload calls these channels, but ipc/ registers no handler for them: ${orphaned.join(', ')}`,
        );
        // A sanity floor so this test cannot quietly start checking nothing -
        // if either walk stops finding channels, that is the bug worth failing on.
        assert.ok(registered.size > 150, `expected >150 registered channels, found ${registered.size}`);
        assert.ok(invoked.size > 150, `expected >150 invoked channels, found ${invoked.size}`);
    });
});
