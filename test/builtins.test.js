/**
 * Exercises plugins/builtins.js: default-enabled bookkeeping, persistence
 * across a fresh instance (the property the require-gate in ipc/index.js
 * depends on), and unknown-id handling. No electron dependency.
 */
const fs = require('fs');
const path = require('path');
const os = require('os');
const assert = require('assert');
const { describe, test } = require('node:test');
const { createBuiltinsManager, AI_BUILTIN_ID } = require('../src/main/plugins/builtins');

function tempFile() {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'rt-test-builtins-'));
    return path.join(dir, 'builtins.json');
}

describe('builtins: defaults and list()', () => {
    test('every definition starts enabled', () => {
        const manager = createBuiltinsManager({ stateFile: tempFile() });
        assert.strictEqual(manager.isEnabled(AI_BUILTIN_ID), true);
    });

    test('list() carries id/name/enabled/description/pendingRestart', () => {
        const manager = createBuiltinsManager({ stateFile: tempFile() });
        const entry = manager.list().find(item => item.id === AI_BUILTIN_ID);
        assert.ok(entry);
        assert.strictEqual(entry.name, 'AI Assistant');
        assert.strictEqual(entry.enabled, true);
        assert.ok(entry.description.length > 0);
        assert.strictEqual(entry.pendingRestart, false);
    });

    test('isEnabled() on an unknown id is false, not a throw', () => {
        const manager = createBuiltinsManager({ stateFile: tempFile() });
        assert.strictEqual(manager.isEnabled('com.reefterm.builtin.does-not-exist'), false);
    });
});

describe('builtins: setEnabled()', () => {
    test('an unknown id fails and does not write the state file', () => {
        const file = tempFile();
        const manager = createBuiltinsManager({ stateFile: file });
        const result = manager.setEnabled('com.reefterm.builtin.does-not-exist', false);
        assert.deepStrictEqual(result, { success: false, message: 'That built-in feature is not known' });
        assert.strictEqual(fs.existsSync(file), false);
    });

    test('a known id succeeds and is reflected immediately', () => {
        const manager = createBuiltinsManager({ stateFile: tempFile() });
        const result = manager.setEnabled(AI_BUILTIN_ID, false);
        assert.deepStrictEqual(result, { success: true });
        assert.strictEqual(manager.isEnabled(AI_BUILTIN_ID), false);
    });
});

describe('builtins: persistence across instances', () => {
    test('a fresh manager against the same file picks up a prior disable on construction', () => {
        const file = tempFile();
        const first = createBuiltinsManager({ stateFile: file });
        first.setEnabled(AI_BUILTIN_ID, false);

        const second = createBuiltinsManager({ stateFile: file });
        assert.strictEqual(second.isEnabled(AI_BUILTIN_ID), false);
    });

    test('re-enabling persists too', () => {
        const file = tempFile();
        const first = createBuiltinsManager({ stateFile: file });
        first.setEnabled(AI_BUILTIN_ID, false);
        first.setEnabled(AI_BUILTIN_ID, true);

        const second = createBuiltinsManager({ stateFile: file });
        assert.strictEqual(second.isEnabled(AI_BUILTIN_ID), true);
    });

    test('a missing state file loads as all-enabled defaults rather than throwing', () => {
        const manager = createBuiltinsManager({ stateFile: path.join(os.tmpdir(), 'rt-does-not-exist-' + Date.now(), 'builtins.json') });
        assert.strictEqual(manager.isEnabled(AI_BUILTIN_ID), true);
    });

    test('a corrupt state file loads as all-enabled defaults rather than throwing', () => {
        const file = tempFile();
        fs.writeFileSync(file, '{not json');
        const manager = createBuiltinsManager({ stateFile: file });
        assert.strictEqual(manager.isEnabled(AI_BUILTIN_ID), true);
    });
});

describe('builtins: init()', () => {
    test('returns the same shape as list()', () => {
        const manager = createBuiltinsManager({ stateFile: tempFile() });
        assert.deepStrictEqual(manager.init(), manager.list());
    });
});

describe('builtins: pendingRestart', () => {
    test('toggling away from what was loaded at construction sets pendingRestart', () => {
        const manager = createBuiltinsManager({ stateFile: tempFile() });
        manager.setEnabled(AI_BUILTIN_ID, false);

        const entry = manager.list().find(item => item.id === AI_BUILTIN_ID);
        assert.strictEqual(entry.pendingRestart, true);
    });

    test('toggling back to what was loaded at construction clears pendingRestart again', () => {
        const manager = createBuiltinsManager({ stateFile: tempFile() });
        manager.setEnabled(AI_BUILTIN_ID, false);
        manager.setEnabled(AI_BUILTIN_ID, true);

        const entry = manager.list().find(item => item.id === AI_BUILTIN_ID);
        assert.strictEqual(entry.pendingRestart, false);
    });

    test('a manager constructed with the toggle already applied has nothing pending', () => {
        const file = tempFile();
        const first = createBuiltinsManager({ stateFile: file });
        first.setEnabled(AI_BUILTIN_ID, false);

        // A fresh construction (what a real restart does) re-baselines: what
        // was just persisted is now what "loaded at boot" means.
        const second = createBuiltinsManager({ stateFile: file });
        const entry = second.list().find(item => item.id === AI_BUILTIN_ID);
        assert.strictEqual(entry.pendingRestart, false);
    });
});
