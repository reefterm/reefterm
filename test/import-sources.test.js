/**
 * Exercises the registry-backed dispatch in import.js: which source a
 * scan()/apply() call is routed to, detect() asking every registered source
 * (not just the default), and an unrecognised source refusing outright
 * instead of silently running the OpenSSH importer against the wrong
 * options (which is what the old `if/else` chain did - there was no
 * "unknown source" case at all before this).
 *
 * Not a test of what each source actually parses (OpenSSH config syntax,
 * the PuTTY/KiTTY registry format, MobaXterm's ini file) - those are
 * separate, substantial, and currently untested pieces of their own. This
 * is scoped to the dispatch layer the plugin-registry migration touched.
 *
 * `electron` is stubbed the same way store.test.js does it, since routing
 * to PuTTY/MobaXterm goes through store.getHosts() along the way.
 */
const Module = require('module');
const path = require('path');
const fs = require('fs');
const os = require('os');
const assert = require('assert');
const { describe, test } = require('node:test');

const ROOT = path.join(__dirname, '..', 'src', 'main');

function freshImporter() {
    const userData = fs.mkdtempSync(path.join(os.tmpdir(), 'rt-test-import-'));
    const electronStub = {
        app: {
            getPath: (what) => (what === 'userData' ? userData : os.tmpdir()),
            getVersion: () => '1.0.0',
            on: () => {},
        },
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
        return require(path.join(ROOT, 'import'));
    } finally {
        Module._load = realLoad;
    }
}

describe('import: detect()', () => {
    test('asks every registered source, not only the default one', () => {
        const importer = freshImporter();
        const detected = importer.detect();
        assert.deepStrictEqual(Object.keys(detected).sort(), ['kitty', 'mobaxterm', 'openssh', 'putty']);
    });

    test('putty and kitty are told apart, though they share one implementation module', () => {
        const importer = freshImporter();
        const detected = importer.detect();
        assert.strictEqual(detected.putty.label, 'PuTTY');
        assert.strictEqual(detected.kitty.label, 'KiTTY');
    });
});

describe('import: scan() routing', () => {
    test('with no source, scans OpenSSH', () => {
        const importer = freshImporter();
        const result = importer.scan({});
        // The OpenSSH shape (paths/config/knownHosts), not a PuTTY-shaped
        // result (source/label/hosts).
        assert.ok('paths' in result);
        assert.ok('config' in result);
    });

    test('routes "putty" and "kitty" to their own source, not to each other', () => {
        const importer = freshImporter();
        assert.strictEqual(importer.scan({ source: 'putty' }).label, 'PuTTY');
        assert.strictEqual(importer.scan({ source: 'kitty' }).label, 'KiTTY');
    });

    test('an unrecognised source refuses outright, rather than silently scanning OpenSSH with the wrong options', () => {
        const importer = freshImporter();
        assert.throws(() => importer.scan({ source: 'consul' }), /No import source named "consul"/);
    });
});

describe('import: apply() routing', () => {
    test('with no source, applies against OpenSSH and reports the standard shape', () => {
        const importer = freshImporter();
        const result = importer.apply({});
        assert.strictEqual(result.success, true);
        assert.ok('hosts' in result);
        assert.ok('knownHosts' in result);
    });

    test('an unrecognised source refuses outright', () => {
        const importer = freshImporter();
        assert.throws(() => importer.apply({ source: 'warpgate' }), /No import source named "warpgate"/);
    });
});
