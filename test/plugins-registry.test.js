/**
 * Exercises plugins/registry.js: the one primitive both the AI provider
 * registry and the import-source registry are built from. No electron
 * dependency here at all, so this runs against the real module directly.
 */
const assert = require('assert');
const { describe, test } = require('node:test');
const { createRegistry } = require('../src/main/plugins/registry');

describe('registry: registration', () => {
    test('a registered implementation is returned by get()', () => {
        const registry = createRegistry('test');
        const impl = { run: () => {} };
        registry.register('a', impl);
        assert.strictEqual(registry.get('a'), impl);
    });

    test('an unregistered id is undefined, not a throw', () => {
        const registry = createRegistry('test');
        assert.strictEqual(registry.get('nope'), undefined);
    });

    test('refuses a non-string or empty id', () => {
        const registry = createRegistry('test');
        assert.throws(() => registry.register('', {}), /non-empty string id/);
        assert.throws(() => registry.register(null, {}), /non-empty string id/);
        assert.throws(() => registry.register(undefined, {}), /non-empty string id/);
    });

    test('refuses registering the same id twice', () => {
        const registry = createRegistry('test');
        registry.register('a', {});
        assert.throws(() => registry.register('a', {}), /already registered/);
    });

    test('the registry name appears in its own error messages', () => {
        const registry = createRegistry('ai.providers');
        assert.throws(() => registry.register('', {}), /ai\.providers/);
    });
});

describe('registry: validation', () => {
    test('runs validate(impl, id) at registration time, before the entry is stored', () => {
        const seen = [];
        const registry = createRegistry('test', {
            validate: (impl, id) => { seen.push({ impl, id }); },
        });
        const impl = { ok: true };

        registry.register('a', impl);
        assert.deepStrictEqual(seen, [{ impl, id: 'a' }]);
    });

    test('a validate() that throws stops the registration from taking effect', () => {
        const registry = createRegistry('test', {
            validate: (impl) => { if (typeof impl.run !== 'function') throw new Error('needs a run() function'); },
        });

        assert.throws(() => registry.register('bad', {}), /needs a run/);
        assert.strictEqual(registry.has('bad'), false);
        assert.strictEqual(registry.get('bad'), undefined);
    });

    test('a validate() that passes lets the registration through unchanged', () => {
        const registry = createRegistry('test', {
            validate: (impl) => { if (typeof impl.run !== 'function') throw new Error('needs run()'); },
        });
        const impl = { run: () => 'ok' };

        registry.register('good', impl);
        assert.strictEqual(registry.get('good'), impl);
    });
});

describe('registry: enable/disable', () => {
    test('get() hides a disabled entry, but has() still reports it exists', () => {
        const registry = createRegistry('test');
        registry.register('a', {});

        assert.strictEqual(registry.setEnabled('a', false), true);
        assert.strictEqual(registry.get('a'), undefined);
        assert.strictEqual(registry.has('a'), true);
    });

    test('re-enabling brings get() back', () => {
        const registry = createRegistry('test');
        const impl = {};
        registry.register('a', impl);

        registry.setEnabled('a', false);
        registry.setEnabled('a', true);
        assert.strictEqual(registry.get('a'), impl);
    });

    test('setEnabled on an unregistered id reports false and changes nothing', () => {
        const registry = createRegistry('test');
        assert.strictEqual(registry.setEnabled('nope', false), false);
    });

    test('enabledByDefault: false starts an entry disabled without an explicit setEnabled call', () => {
        const registry = createRegistry('test');
        registry.register('a', {}, { enabledByDefault: false });
        assert.strictEqual(registry.get('a'), undefined);
        assert.strictEqual(registry.has('a'), true);
    });

    test('enabled defaults to true when no meta is given at all', () => {
        const registry = createRegistry('test');
        const impl = {};
        registry.register('a', impl);
        assert.strictEqual(registry.get('a'), impl);
    });
});

describe('registry: list', () => {
    test('lists every registration, including disabled ones, with their state', () => {
        const registry = createRegistry('test');
        registry.register('a', {}, { name: 'Alpha' });
        registry.register('b', {}, { name: 'Beta', enabledByDefault: false });

        const list = registry.list();
        assert.deepStrictEqual(
            list.sort((x, y) => x.id.localeCompare(y.id)),
            [
                { id: 'a', name: 'Alpha', enabled: true },
                { id: 'b', name: 'Beta', enabled: false },
            ]
        );
    });

    test('name falls back to the id when none is given', () => {
        const registry = createRegistry('test');
        registry.register('a', {});
        assert.strictEqual(registry.list()[0].name, 'a');
    });

    test('an empty registry lists nothing', () => {
        const registry = createRegistry('test');
        assert.deepStrictEqual(registry.list(), []);
    });

    test('list() does not expose the raw implementation', () => {
        const registry = createRegistry('test');
        registry.register('a', { secret: 'do-not-leak' });
        assert.strictEqual('impl' in registry.list()[0], false);
        assert.strictEqual('secret' in registry.list()[0], false);
    });
});

describe('registry: all()', () => {
    test('carries the implementation, unlike list()', () => {
        const registry = createRegistry('test');
        const impl = { secret: 'ok-here' };
        registry.register('a', impl, { name: 'Alpha' });

        assert.deepStrictEqual(registry.all(), [{ id: 'a', impl, name: 'Alpha', enabled: true }]);
    });

    test('includes a disabled entry\'s implementation too', () => {
        const registry = createRegistry('test');
        const impl = {};
        registry.register('a', impl, { enabledByDefault: false });

        const [entry] = registry.all();
        assert.strictEqual(entry.impl, impl);
        assert.strictEqual(entry.enabled, false);
    });
});

describe('registry: independence between instances', () => {
    test('two registries never see each other\'s registrations', () => {
        const a = createRegistry('a');
        const b = createRegistry('b');
        a.register('x', { from: 'a' });

        assert.strictEqual(b.get('x'), undefined);
        assert.strictEqual(b.has('x'), false);
    });
});
