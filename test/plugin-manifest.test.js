/**
 * Exercises plugins/manifest.js: id validation (this string becomes a
 * literal directory name, so it is checked before it is ever used as one),
 * the reserved com.reefterm namespace, manifest parsing, and the specific
 * security property the whole module exists for - a plugin's manifest
 * cannot claim an id other than the folder it was actually found in, which
 * is what stops a new plugin from inheriting an existing one's granted
 * capabilities by simply declaring the same id.
 *
 * No electron dependency here at all, so this runs against the real module
 * directly.
 */
const fs = require('fs');
const path = require('path');
const os = require('os');
const assert = require('assert');
const { describe, test } = require('node:test');
const manifest = require('../src/main/plugins/manifest');

function tempPluginDir(id) {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'rt-test-plugin-manifest-'));
    const dir = path.join(root, id);
    fs.mkdirSync(dir, { recursive: true });
    return dir;
}

function writeManifest(dir, fields) {
    fs.writeFileSync(path.join(dir, 'plugin.json'), JSON.stringify(fields));
}

const VALID_FIELDS = {
    id: 'com.example.myplugin',
    name: 'My Plugin',
    version: '0.1.0',
    entry: 'index.js',
    capabilities: ['hosts.list'],
};

describe('manifest: isValidId', () => {
    test('accepts reverse-DNS ids with hyphenated segments', () => {
        assert.strictEqual(manifest.isValidId('com.example.my-plugin'), true);
        assert.strictEqual(manifest.isValidId('io.github.someone.docker-status'), true);
    });

    test('refuses anything that is not at least two segments', () => {
        assert.strictEqual(manifest.isValidId('noDots'), false);
    });

    test('refuses path traversal and separators outright', () => {
        assert.strictEqual(manifest.isValidId('../../evil'), false);
        assert.strictEqual(manifest.isValidId('a/b.c'), false);
        assert.strictEqual(manifest.isValidId('a\\b.c'), false);
    });

    test('refuses uppercase, empty segments, and leading/trailing dots', () => {
        assert.strictEqual(manifest.isValidId('Com.Example.Bad'), false);
        assert.strictEqual(manifest.isValidId('a..b'), false);
        assert.strictEqual(manifest.isValidId('.a.b'), false);
        assert.strictEqual(manifest.isValidId('a.b.'), false);
    });

    test('refuses a Windows-reserved device name in any segment', () => {
        assert.strictEqual(manifest.isValidId('con.plugin'), false);
        assert.strictEqual(manifest.isValidId('plugin.com1'), false);
        assert.strictEqual(manifest.isValidId('plugin.NUL'), false);
    });
});

describe('manifest: reserved namespace', () => {
    test('com.reefterm and anything under it is reserved', () => {
        assert.strictEqual(manifest.isReservedNamespace('com.reefterm'), true);
        assert.strictEqual(manifest.isReservedNamespace('com.reefterm.builtin.hostsimporter'), true);
    });

    test('a namespace that merely starts with the same letters is not reserved', () => {
        assert.strictEqual(manifest.isReservedNamespace('com.reeftermish.plugin'), false);
    });

    test('readManifest refuses the reserved namespace by default', () => {
        const dir = tempPluginDir('com.reefterm.builtin.fake');
        writeManifest(dir, { ...VALID_FIELDS, id: 'com.reefterm.builtin.fake' });

        const result = manifest.readManifest(dir);
        assert.strictEqual(result.ok, false);
        assert.match(result.error, /reserved/);
    });

    test('readManifest allows the reserved namespace when explicitly told to', () => {
        const dir = tempPluginDir('com.reefterm.builtin.fake');
        writeManifest(dir, { ...VALID_FIELDS, id: 'com.reefterm.builtin.fake' });

        const result = manifest.readManifest(dir, { allowReservedNamespace: true });
        assert.strictEqual(result.ok, true);
    });
});

describe('manifest: readManifest', () => {
    test('a well-formed manifest matching its folder reads cleanly', () => {
        const dir = tempPluginDir('com.example.myplugin');
        writeManifest(dir, VALID_FIELDS);

        const result = manifest.readManifest(dir);
        assert.strictEqual(result.ok, true);
        assert.strictEqual(result.manifest.id, 'com.example.myplugin');
        assert.strictEqual(result.manifest.name, 'My Plugin');
        assert.strictEqual(result.manifest.entryPath, path.join(dir, 'index.js'));
        assert.deepStrictEqual(result.manifest.capabilities, ['hosts.list']);
    });

    test('the folder name decides the id, not the manifest', () => {
        const dir = tempPluginDir('com.example.realname');
        writeManifest(dir, { ...VALID_FIELDS, id: 'com.example.realname' });

        assert.strictEqual(manifest.readManifest(dir).ok, true);
    });

    test('the core security property: a manifest cannot claim a different id than its own folder', () => {
        // This is exactly the attack the whole module exists to stop: a new
        // plugin, installed under its own folder, declaring the id of some
        // other (presumably already-trusted) plugin so it inherits that
        // plugin's granted capabilities with no fresh consent.
        const dir = tempPluginDir('com.example.newcomer');
        writeManifest(dir, { ...VALID_FIELDS, id: 'com.example.already-trusted' });

        const result = manifest.readManifest(dir);
        assert.strictEqual(result.ok, false);
        assert.match(result.error, /disagrees|declares id/);
    });

    test('a missing plugin.json is refused, not thrown', () => {
        const dir = tempPluginDir('com.example.nomanifest');
        const result = manifest.readManifest(dir);
        assert.strictEqual(result.ok, false);
    });

    test('malformed JSON is refused, not thrown', () => {
        const dir = tempPluginDir('com.example.badjson');
        fs.writeFileSync(path.join(dir, 'plugin.json'), '{not json');
        const result = manifest.readManifest(dir);
        assert.strictEqual(result.ok, false);
    });

    for (const field of ['id', 'name', 'version', 'entry']) {
        test(`a missing "${field}" field is refused, naming which one`, () => {
            const dir = tempPluginDir('com.example.missingfield');
            const fields = { ...VALID_FIELDS, id: 'com.example.missingfield' };
            delete fields[field];
            writeManifest(dir, fields);

            const result = manifest.readManifest(dir);
            assert.strictEqual(result.ok, false);
            assert.match(result.error, new RegExp(field));
        });
    }

    test('capabilities must be an array of non-empty strings', () => {
        const dir = tempPluginDir('com.example.badcaps');
        writeManifest(dir, { ...VALID_FIELDS, id: 'com.example.badcaps', capabilities: 'hosts.list' });
        assert.strictEqual(manifest.readManifest(dir).ok, false);

        const dir2 = tempPluginDir('com.example.badcaps2');
        writeManifest(dir2, { ...VALID_FIELDS, id: 'com.example.badcaps2', capabilities: ['hosts.list', ''] });
        assert.strictEqual(manifest.readManifest(dir2).ok, false);
    });

    test('duplicate capabilities are deduplicated', () => {
        const dir = tempPluginDir('com.example.dupcaps');
        writeManifest(dir, { ...VALID_FIELDS, id: 'com.example.dupcaps', capabilities: ['hosts.list', 'hosts.list'] });

        const result = manifest.readManifest(dir);
        assert.deepStrictEqual(result.manifest.capabilities, ['hosts.list']);
    });

    test('uiExtensions is optional and defaults to an empty array', () => {
        const dir = tempPluginDir('com.example.nouiext');
        writeManifest(dir, { ...VALID_FIELDS, id: 'com.example.nouiext' });

        const result = manifest.readManifest(dir);
        assert.strictEqual(result.ok, true);
        assert.deepStrictEqual(result.manifest.uiExtensions, []);
    });

    test('a well-formed uiExtensions entry, with and without a sample, reads cleanly', () => {
        const dir = tempPluginDir('com.example.uiext');
        writeManifest(dir, {
            ...VALID_FIELDS,
            id: 'com.example.uiext',
            uiExtensions: [
                { point: 'pane.headerAction', sample: { type: 'button', label: 'Containers', onAction: 'x' } },
                { point: 'host.contextMenuItem' },
            ],
        });

        const result = manifest.readManifest(dir);
        assert.strictEqual(result.ok, true);
        assert.deepStrictEqual(result.manifest.uiExtensions, [
            { point: 'pane.headerAction', sample: { type: 'button', label: 'Containers', onAction: 'x' } },
            { point: 'host.contextMenuItem', sample: null },
        ]);
    });

    test('uiExtensions must be an array of { point, sample? } objects', () => {
        const dir = tempPluginDir('com.example.baduiext');
        writeManifest(dir, { ...VALID_FIELDS, id: 'com.example.baduiext', uiExtensions: 'pane.headerAction' });
        assert.strictEqual(manifest.readManifest(dir).ok, false);

        const dir2 = tempPluginDir('com.example.baduiext2');
        writeManifest(dir2, { ...VALID_FIELDS, id: 'com.example.baduiext2', uiExtensions: [{ sample: {} }] });
        assert.strictEqual(manifest.readManifest(dir2).ok, false);

        const dir3 = tempPluginDir('com.example.baduiext3');
        writeManifest(dir3, {
            ...VALID_FIELDS, id: 'com.example.baduiext3', uiExtensions: [{ point: 'x', sample: 'not-an-object' }],
        });
        assert.strictEqual(manifest.readManifest(dir3).ok, false);
    });

    test('an entry path is resolved relative to the plugin\'s own directory', () => {
        const dir = tempPluginDir('com.example.nested');
        writeManifest(dir, { ...VALID_FIELDS, id: 'com.example.nested', entry: 'src/index.js' });

        const result = manifest.readManifest(dir);
        assert.strictEqual(result.ok, true);
        assert.strictEqual(result.manifest.entryPath, path.join(dir, 'src', 'index.js'));
    });

    test('an entry path that escapes the plugin\'s own directory is refused', () => {
        const dir = tempPluginDir('com.example.traversal');
        writeManifest(dir, { ...VALID_FIELDS, id: 'com.example.traversal', entry: '../../../etc/passwd' });

        const result = manifest.readManifest(dir);
        assert.strictEqual(result.ok, false);
        assert.match(result.error, /entry/);
    });
});

describe('manifest: ensureStructure', () => {
    test('creates config/, data/ and logs/ when they do not exist', () => {
        const dir = tempPluginDir('com.example.structure');
        manifest.ensureStructure(dir);

        for (const sub of ['config', 'data', 'logs']) {
            assert.strictEqual(fs.statSync(path.join(dir, sub)).isDirectory(), true);
        }
    });

    test('is idempotent and does not disturb existing content', () => {
        const dir = tempPluginDir('com.example.structure2');
        manifest.ensureStructure(dir);
        fs.writeFileSync(path.join(dir, 'data', 'state.json'), '{"count":1}');

        manifest.ensureStructure(dir);
        assert.strictEqual(fs.readFileSync(path.join(dir, 'data', 'state.json'), 'utf8'), '{"count":1}');
    });
});
