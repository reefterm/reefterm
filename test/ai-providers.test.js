/**
 * Exercises the part of ai/index.js this session's plugin-registry migration
 * actually touches: which providers status() reports as available, and what
 * happens when the configured provider is not one of them. Not a test of the
 * conversation orchestration as a whole (see claude-provider.test.js,
 * codex-provider.test.js, opencode-provider.test.js, assistant-approval.test.js
 * and assistant-terminal.test.js for the pieces that already cover) - this is
 * specifically the registry-backed dispatch that replaced a bare object
 * literal (`PROVIDERS = { 'claude-code': require(...), ... }`) and an
 * `if/else` chain.
 *
 * `electron` is stubbed so this runs under plain node, the same pattern
 * assistant-approval.test.js uses.
 */
const Module = require('module');
const path = require('path');
const fs = require('fs');
const os = require('os');
const assert = require('assert');
const { describe, test, afterEach } = require('node:test');

const ROOT = path.join(__dirname, '..', 'src', 'main');
const userData = fs.mkdtempSync(path.join(os.tmpdir(), 'rt-test-ai-providers-'));

const electronStub = {
    app: {
        getPath: () => userData,
        getVersion: () => '1.0.0',
        on: () => {},
        whenReady: () => new Promise(() => {}),
    },
    safeStorage: {
        isEncryptionAvailable: () => false,
        encryptString: () => { throw new Error('unavailable'); },
        decryptString: () => { throw new Error('unavailable'); },
    },
    MessageChannelMain: class { constructor() { this.port1 = {}; this.port2 = {}; } },
    ipcMain: { handle: () => {}, on: () => {} },
};

const realLoad = Module._load;
Module._load = function (request, parent, isMain) {
    if (request === 'electron') return electronStub;
    return realLoad.call(this, request, parent, isMain);
};

const assistant = require(path.join(ROOT, 'ai'));
const providers = require(path.join(ROOT, 'ai', 'providers'));

Module._load = realLoad;

describe('ai/index.js status(): the registry-backed provider list', () => {
    test('reports every built-in provider as ready, by default', () => {
        const status = assistant.status();
        assert.deepStrictEqual([...status.providers].sort(), ['claude-code', 'codex', 'opencode']);
        assert.strictEqual(status.ready, true); // default provider is claude-code
    });

    test('ready and providers both track the registry\'s enabled state, not just registration', () => {
        providers.setEnabled('codex', false);
        try {
            const status = assistant.status();
            assert.strictEqual(status.providers.includes('codex'), false);
            // Still registered, just off - has() would say true, get() (what
            // ready and providers are built from) says no.
            assert.strictEqual(providers.has('codex'), true);
        } finally {
            providers.setEnabled('codex', true);
        }
    });

    test('ready reflects whichever provider is currently selected', async () => {
        const before = await assistant.settings.set({ provider: 'codex' });
        try {
            assert.strictEqual(assistant.status().ready, true);

            providers.setEnabled('codex', false);
            try {
                assert.strictEqual(assistant.status().ready, false);
            } finally {
                providers.setEnabled('codex', true);
            }
        } finally {
            await assistant.settings.set({ provider: before.provider });
        }
    });
});

describe('ai/index.js send(): a provider that is not available', () => {
    afterEach(() => {
        providers.setEnabled('codex', true);
    });

    test('a disabled provider is refused the same way an unregistered one would be, without ever starting it', async () => {
        const before = await assistant.settings.set({ provider: 'codex' });
        providers.setEnabled('codex', false);

        const { conversationId } = assistant.create({ scope: 'global' });
        const result = await assistant.send(conversationId, 'hello');

        assert.strictEqual(result.success, false);
        assert.match(result.message, /No provider named "codex" is available/);

        await assistant.close(conversationId);
        await assistant.settings.set({ provider: before.provider });
    });
});
