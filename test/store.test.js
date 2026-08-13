/**
 * Exercises store.js: the secret envelope, host/proxy/folder/key/snippet CRUD,
 * jump-host and proxy chain resolution (including cycle detection), quick
 * connect, backup export/import, and the v1-to-v2 migration. `electron` is
 * stubbed so it runs under plain node, the same pattern backup.test.js and
 * vnc.test.js use.
 *
 * This is the store's first test coverage; it exists specifically as the
 * safety net for splitting store.js into src/main/store/ along entity lines,
 * so it is written against the module's public shape (`require('./store')`)
 * rather than its internals, and should not need to change when the split
 * happens - only when the split changes what the module does.
 */
const Module = require('module');
const path = require('path');
const fs = require('fs');
const os = require('os');
const assert = require('assert');
const { describe, test } = require('node:test');

const ROOT = path.join(__dirname, '..', 'src', 'main');

function freshStore() {
    const userData = fs.mkdtempSync(path.join(os.tmpdir(), 'rt-test-store-'));
    const electronStub = {
        app: {
            getPath: (what) => (what === 'userData' ? userData : os.tmpdir()),
            getVersion: () => '1.0.0',
            on: () => {},
        },
        // No OS keystore: the vault falls back to storing the data key
        // unwrapped, which is the Linux-without-a-keyring path and is fine
        // for a test. isLocked() then auto-materialises a key on first use
        // because no password is ever set here, so the store is always
        // usable without an explicit unlock.
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
        return { store: require(path.join(ROOT, 'store.js')), userData };
    } finally {
        Module._load = realLoad;
    }
}

/* ---------------- secrets ---------------- */

describe('store: secrets', () => {
    test('a saved password round-trips through resolveCredentials, and never comes back from getHosts', () => {
        const { store } = freshStore();
        const saved = store.saveHost({ name: 'db', host: '10.0.0.1', authMethod: 'password', password: 'hunter2' });

        assert.strictEqual(saved.hasPassword, true);
        assert.strictEqual(saved.password, undefined);

        const listed = store.getHosts().find(h => h.id === saved.id);
        assert.strictEqual(listed.password, undefined);
        assert.strictEqual(listed.hasPassword, true);

        const creds = store.resolveCredentials(saved.id);
        assert.strictEqual(creds.password, 'hunter2');
    });

    test('omitting a secret on edit keeps the stored one; null clears it', () => {
        const { store } = freshStore();
        const saved = store.saveHost({ name: 'db', host: '10.0.0.1', authMethod: 'password', password: 'hunter2' });

        const kept = store.saveHost({ ...saved, name: 'db2' });
        assert.strictEqual(store.resolveCredentials(kept.id).password, 'hunter2');

        const cleared = store.saveHost({ ...saved, password: null });
        assert.strictEqual(store.resolveCredentials(cleared.id).password, '');
    });

    test('the file on disk never holds a plaintext password', () => {
        const { store, userData } = freshStore();
        store.saveHost({ name: 'db', host: '10.0.0.1', authMethod: 'password', password: 'hunter2' });

        const onDisk = fs.readFileSync(path.join(userData, 'sessions.json'), 'utf8');
        assert.ok(!onDisk.includes('hunter2'));
    });
});

/* ---------------- hosts ---------------- */

describe('store: hosts', () => {
    test('save creates, a second save with the same id updates', () => {
        const { store } = freshStore();
        const created = store.saveHost({ name: 'one', host: 'a' });
        assert.strictEqual(store.getHosts().length, 1);

        store.saveHost({ ...created, name: 'renamed' });
        const hosts = store.getHosts();
        assert.strictEqual(hosts.length, 1);
        assert.strictEqual(hosts[0].name, 'renamed');
    });

    test('deleting a host un-points anything that jumped through it', () => {
        const { store } = freshStore();
        const bastion = store.saveHost({ name: 'bastion', host: 'b' });
        const leaf = store.saveHost({ name: 'leaf', host: 'l', jumpHostId: bastion.id });

        store.deleteHost(bastion.id);

        const after = store.getHosts().find(h => h.id === leaf.id);
        assert.strictEqual(after.jumpHostId, '');
    });

    test('duplicate copies the secret without ever decrypting it through the renderer shape', () => {
        const { store } = freshStore();
        const original = store.saveHost({ name: 'db', host: 'a', authMethod: 'password', password: 'hunter2' });
        const copy = store.duplicateHost(original.id);

        assert.notStrictEqual(copy.id, original.id);
        assert.strictEqual(copy.name, 'db copy');
        assert.strictEqual(store.resolveCredentials(copy.id).password, 'hunter2');
    });

    test('tagHosts adds and removes across a selection in one call', () => {
        const { store } = freshStore();
        const a = store.saveHost({ name: 'a', host: 'a' });
        const b = store.saveHost({ name: 'b', host: 'b', tags: ['staging'] });

        const result = store.tagHosts({ hostIds: [a.id, b.id], add: ['prod'], remove: ['staging'] });
        assert.strictEqual(result.changed, 2);

        const hosts = store.getHosts();
        assert.deepStrictEqual(hosts.find(h => h.id === a.id).tags, ['prod']);
        assert.deepStrictEqual(hosts.find(h => h.id === b.id).tags, ['prod']);
    });

    test('a host cannot be made its own jump host', () => {
        const { store } = freshStore();
        const host = store.saveHost({ name: 'a', host: 'a' });
        const resaved = store.saveHost({ ...host, jumpHostId: host.id });
        assert.strictEqual(resaved.jumpHostId, '');
    });
});

/* ---------------- quick connect ---------------- */

describe('store: quick connect', () => {
    test('the same address asked for twice resolves to the same ephemeral record', () => {
        const { store } = freshStore();
        const first = store.openQuickConnect({ host: '10.0.0.9', username: 'root', port: 22 });
        const second = store.openQuickConnect({ host: '10.0.0.9', username: 'root', port: 22 });
        assert.strictEqual(first.id, second.id);
    });

    test('quick connects never appear in the saved host list', () => {
        const { store } = freshStore();
        store.openQuickConnect({ host: '10.0.0.9', username: 'root', port: 22 });
        assert.strictEqual(store.getHosts().length, 0);
    });

    test('rememberQuickConnect keeps the login for the next dial, forgetQuickConnects drops it', () => {
        const { store } = freshStore();
        const record = store.openQuickConnect({ host: '10.0.0.9', username: '', port: 22 });
        store.rememberQuickConnect(record.id, { username: 'root', password: 'hunter2' });

        assert.strictEqual(store.resolveCredentials(record.id).password, 'hunter2');

        store.forgetQuickConnects();
        assert.strictEqual(store.resolveCredentials(record.id), null);
    });
});

/* ---------------- resolveCredentials ---------------- */

describe('store: resolveCredentials', () => {
    test('keychain auth pulls the key from the keychain, not the host', () => {
        const { store } = freshStore();
        const key = store.saveKey({ name: 'id', type: 'ED25519', privateKey: 'PRIVATE', passphrase: '' });
        const host = store.saveHost({ name: 'a', host: 'a', authMethod: 'keychain', keychainKeyId: key.id });

        const creds = store.resolveCredentials(host.id);
        assert.strictEqual(creds.authMethod, 'key');
        assert.strictEqual(creds.privateKey, 'PRIVATE');
    });

    test('a keychain host pointed at a deleted key reports an error rather than connecting bare', () => {
        const { store } = freshStore();
        const host = store.saveHost({ name: 'a', host: 'a', authMethod: 'keychain', keychainKeyId: 'no-such-key' });
        const creds = store.resolveCredentials(host.id);
        assert.ok(creds.error);
    });

    test('agent auth carries no secret at all', () => {
        const { store } = freshStore();
        const host = store.saveHost({ name: 'a', host: 'a', authMethod: 'agent' });
        const creds = store.resolveCredentials(host.id);
        assert.strictEqual(creds.password, '');
        assert.strictEqual(creds.privateKey, '');
    });

    test('an unknown host id resolves to null', () => {
        const { store } = freshStore();
        assert.strictEqual(store.resolveCredentials('does-not-exist'), null);
    });
});

/* ---------------- jump host chains ---------------- */

describe('store: resolveChain', () => {
    test('a host with no jump host resolves to a chain of one, itself the target', () => {
        const { store } = freshStore();
        const host = store.saveHost({ name: 'a', host: 'a' });
        const { chain, error } = store.resolveChain(host.id);
        assert.strictEqual(error, '');
        assert.strictEqual(chain.length, 1);
        assert.strictEqual(chain[0].isTarget, true);
    });

    test('a chain is dialled outermost first, target last', () => {
        const { store } = freshStore();
        const bastion = store.saveHost({ name: 'bastion', host: 'b' });
        const leaf = store.saveHost({ name: 'leaf', host: 'l', jumpHostId: bastion.id });

        const { chain, error } = store.resolveChain(leaf.id);
        assert.strictEqual(error, '');
        assert.strictEqual(chain.length, 2);
        assert.strictEqual(chain[0].hostId, bastion.id);
        assert.strictEqual(chain[0].isTarget, false);
        assert.strictEqual(chain[1].hostId, leaf.id);
        assert.strictEqual(chain[1].isTarget, true);
    });

    test('a host reached through itself is refused rather than looped', () => {
        const { store } = freshStore();
        const a = store.saveHost({ name: 'a', host: 'a' });
        const b = store.saveHost({ name: 'b', host: 'b', jumpHostId: a.id });
        // Close the cycle by hand: saveHost already refuses a *direct*
        // self-reference, but not one two hops around.
        store.saveHost({ ...a, jumpHostId: b.id });

        const { chain, error } = store.resolveChain(a.id);
        assert.strictEqual(chain.length, 0);
        assert.ok(error.includes('reached through itself'));
    });

    test('a jump host that no longer exists is a named failure, not a crash', () => {
        const { store } = freshStore();
        const leaf = store.saveHost({ name: 'leaf', host: 'l', jumpHostId: 'ghost' });
        const { chain, error } = store.resolveChain(leaf.id);
        assert.strictEqual(chain.length, 0);
        assert.ok(error.includes('no longer exists'));
    });

    test('a non-SSH hop cannot relay a connection', () => {
        const { store } = freshStore();
        const telnetHop = store.saveHost({ name: 'switch', host: 's', protocol: 'telnet' });
        const leaf = store.saveHost({ name: 'leaf', host: 'l', jumpHostId: telnetHop.id });
        const { chain, error } = store.resolveChain(leaf.id);
        assert.strictEqual(chain.length, 0);
        assert.ok(error.includes('not an SSH host'));
    });
});

/* ---------------- proxies ---------------- */

describe('store: proxies', () => {
    test('save creates, resolveProxyChain resolves a single hop with its password decrypted', () => {
        const { store } = freshStore();
        const proxy = store.saveProxy({ name: 'p1', host: 'proxy.local', port: 1080, password: 'secret' });
        const { chain, error } = store.resolveProxyChain(proxy.id);
        assert.strictEqual(error, '');
        assert.strictEqual(chain.length, 1);
        assert.strictEqual(chain[0].password, 'secret');
    });

    test('a proxy reached through itself is refused', () => {
        const { store } = freshStore();
        const p = store.saveProxy({ name: 'p1', host: 'a' });
        store.saveProxy({ ...p, viaProxyId: p.id });
        // saveProxy refuses a direct self-reference (viaProxyId === own id is
        // blanked), so the record on disk is unaffected either way; assert
        // the guard held rather than assuming a cycle got through.
        const { chain, error } = store.resolveProxyChain(p.id);
        assert.strictEqual(error, '');
        assert.strictEqual(chain.length, 1);
    });

    test('deleting a proxy un-points hosts and chained proxies rather than leaving them dangling', () => {
        const { store } = freshStore();
        const proxy = store.saveProxy({ name: 'p1', host: 'a' });
        const host = store.saveHost({ name: 'h', host: 'h', proxyId: proxy.id });
        const chained = store.saveProxy({ name: 'p2', host: 'b', viaProxyId: proxy.id });

        store.deleteProxy(proxy.id);

        assert.strictEqual(store.getHosts().find(h => h.id === host.id).proxyId, '');
        assert.strictEqual(store.getProxies().find(p => p.id === chained.id).viaProxyId, '');
    });

    test('resolveTestChain can check a draft that has never been saved', () => {
        const { store } = freshStore();
        const { chain, error } = store.resolveTestChain({ proxy: { host: 'a', port: 1080, password: 'x' } });
        assert.strictEqual(error, '');
        assert.strictEqual(chain.length, 1);
    });
});

/* ---------------- folders ---------------- */

describe('store: folders', () => {
    test('deleting a folder reparents its contents rather than deleting them', () => {
        const { store } = freshStore();
        const root = store.saveFolder({ name: 'root' });
        const child = store.saveFolder({ name: 'child', parentId: root.id });
        const grandchild = store.saveFolder({ name: 'grandchild', parentId: child.id });
        const host = store.saveHost({ name: 'h', host: 'h', folderId: child.id });

        store.deleteFolder(child.id);

        assert.strictEqual(store.getFolders().find(f => f.id === grandchild.id).parentId, root.id);
        assert.strictEqual(store.getHosts().find(h => h.id === host.id).folderId, root.id);
    });

    test('arrangeItems moves a host into a folder and reorders it', () => {
        const { store } = freshStore();
        const folder = store.saveFolder({ name: 'f' });
        const host = store.saveHost({ name: 'h', host: 'h' });

        store.arrangeItems({ hosts: [{ id: host.id, folderId: folder.id, order: 3 }] });

        const after = store.getHosts().find(h => h.id === host.id);
        assert.strictEqual(after.folderId, folder.id);
        assert.strictEqual(after.order, 3);
    });

    test('arrangeItems refuses to file a folder inside its own descendant', () => {
        const { store } = freshStore();
        const parent = store.saveFolder({ name: 'parent' });
        const child = store.saveFolder({ name: 'child', parentId: parent.id });

        store.arrangeItems({ folders: [{ id: parent.id, parentId: child.id }] });

        // The cycle was refused, so parent's parentId is unchanged from
        // whatever saveFolder left it at (no parentId key at all, for a
        // folder created with none).
        assert.strictEqual(store.getFolders().find(f => f.id === parent.id).parentId, undefined);
    });
});

/* ---------------- keys and snippets ---------------- */

describe('store: keys', () => {
    test('save, list (redacted) and delete', () => {
        const { store } = freshStore();
        const key = store.saveKey({ name: 'id', type: 'ED25519', privateKey: 'PRIVATE' });
        assert.strictEqual(key.hasPrivateKey, true);
        assert.strictEqual(key.privateKey, undefined);

        assert.strictEqual(store.getKeys().length, 1);
        store.deleteKey(key.id);
        assert.strictEqual(store.getKeys().length, 0);
    });
});

describe('store: snippets', () => {
    test('save, list and delete', () => {
        const { store } = freshStore();
        const snippet = store.saveSnippet({ name: 's1', command: 'uptime' });
        assert.strictEqual(store.getSnippets().length, 1);
        store.deleteSnippet(snippet.id);
        assert.strictEqual(store.getSnippets().length, 0);
    });
});

/* ---------------- backup ---------------- */

describe('store: backup', () => {
    test('exportAll hands back secrets in the clear, for backup.js to seal', () => {
        const { store } = freshStore();
        store.saveHost({ name: 'db', host: 'a', authMethod: 'password', password: 'hunter2' });
        const payload = store.exportAll();
        assert.strictEqual(payload.hosts[0].password, 'hunter2');
    });

    test('importAll is additive by default: an existing id is skipped, not overwritten', () => {
        const { store } = freshStore();
        const host = store.saveHost({ name: 'original', host: 'a' });

        const summary = store.importAll({
            hosts: [{ ...host, name: 'from backup' }],
        }, { overwrite: false });

        assert.strictEqual(summary.hosts.skipped, 1);
        assert.strictEqual(store.getHosts().find(h => h.id === host.id).name, 'original');
    });

    test('importAll with overwrite replaces an existing record', () => {
        const { store } = freshStore();
        const host = store.saveHost({ name: 'original', host: 'a' });

        const summary = store.importAll({
            hosts: [{ ...host, name: 'from backup' }],
        }, { overwrite: true });

        assert.strictEqual(summary.hosts.replaced, 1);
        assert.strictEqual(store.getHosts().find(h => h.id === host.id).name, 'from backup');
    });

    test('importAll re-encrypts an incoming plaintext secret under the local vault key', () => {
        const { store } = freshStore();
        const summary = store.importAll({
            hosts: [{ id: 'h1', name: 'restored', host: 'a', authMethod: 'password', password: 'hunter2' }],
        });
        assert.strictEqual(summary.hosts.added, 1);
        assert.strictEqual(store.resolveCredentials('h1').password, 'hunter2');
    });

    test('previewImport counts without changing anything', () => {
        const { store } = freshStore();
        const host = store.saveHost({ name: 'a', host: 'a' });

        const preview = store.previewImport({
            hosts: [{ id: host.id }, { id: 'new-one' }],
        });

        assert.strictEqual(preview.hosts.existing, 1);
        assert.strictEqual(preview.hosts.new, 1);
        assert.strictEqual(store.getHosts().length, 1); // unchanged
    });
});

/* ---------------- migration and disk fallback ---------------- */

describe('store: migration and disk fallback', () => {
    test('a v1 flat array store migrates hosts, folders and keychain entries', () => {
        const userData = fs.mkdtempSync(path.join(os.tmpdir(), 'rt-test-store-migrate-'));
        fs.writeFileSync(path.join(userData, 'sessions.json'), JSON.stringify([
            { id: 'f1', name: 'Folder', isFolder: true },
            { id: 'h1', name: 'host', host: 'a', password: 'plain' },
            { id: 'k1', name: 'key', type: 'keychain', privateKey: 'PRIVATE' },
        ]));

        const electronStub = {
            app: { getPath: () => userData, getVersion: () => '1.0.0', on: () => {} },
            safeStorage: {
                isEncryptionAvailable: () => false,
                encryptString: () => { throw new Error('unavailable'); },
                decryptString: () => { throw new Error('unavailable'); },
            },
        };
        const Mod = require('module');
        const realLoad = Mod._load;
        Mod._load = function (request, parent, isMain) {
            if (request === 'electron') return electronStub;
            return realLoad.call(this, request, parent, isMain);
        };
        let store;
        try {
            for (const key of Object.keys(require.cache)) {
                if (key.includes(`${path.sep}main${path.sep}`)) delete require.cache[key];
            }
            store = require(path.join(ROOT, 'store.js'));
        } finally {
            Mod._load = realLoad;
        }

        assert.strictEqual(store.getFolders().length, 1);
        assert.strictEqual(store.getHosts().length, 1);
        assert.strictEqual(store.getHosts()[0].hasPassword, true);
        assert.strictEqual(store.resolveCredentials('h1').password, 'plain');
        assert.strictEqual(store.getKeys().length, 1);
        assert.strictEqual(store.getKeys()[0].type, ''); // v1's algorithm was lost, not guessed at
    });

    test('a corrupt primary file falls back to the .bak copy rather than losing everything', () => {
        const { store, userData } = freshStore();
        // writeAtomic only copies the *existing* file to .bak before writing
        // the new one, so the first save ever has nothing to back up yet -
        // two saves are needed before sessions.json.bak exists. Same id both
        // times, an edit rather than a second host, so the count stays 1.
        const first = store.saveHost({ name: 'a', host: 'a' });
        store.saveHost({ ...first, name: 'a' });

        fs.writeFileSync(path.join(userData, 'sessions.json'), '{not json');

        const electronStub = {
            app: { getPath: () => userData, getVersion: () => '1.0.0', on: () => {} },
            safeStorage: {
                isEncryptionAvailable: () => false,
                encryptString: () => { throw new Error('unavailable'); },
                decryptString: () => { throw new Error('unavailable'); },
            },
        };
        const Mod = require('module');
        const realLoad = Mod._load;
        Mod._load = function (request, parent, isMain) {
            if (request === 'electron') return electronStub;
            return realLoad.call(this, request, parent, isMain);
        };
        let reloaded;
        try {
            for (const key of Object.keys(require.cache)) {
                if (key.includes(`${path.sep}main${path.sep}`)) delete require.cache[key];
            }
            reloaded = require(path.join(ROOT, 'store.js'));
        } finally {
            Mod._load = realLoad;
        }

        assert.strictEqual(reloaded.getHosts().length, 1);
        assert.strictEqual(reloaded.getHosts()[0].name, 'a');
    });
});
