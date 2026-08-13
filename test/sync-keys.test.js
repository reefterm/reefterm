/**
 * Exercises the Sync Master Key lifecycle: registration, unlocking by
 * passphrase or recovery code, passphrase changes, recovery-code rotation,
 * and the local vault-backed cache. `electron` is stubbed so it runs under
 * plain node.
 */
const Module = require('module');
const path = require('path');
const fs = require('fs');
const os = require('os');
const assert = require('assert');

const ROOT = path.join(__dirname, '..', 'src', 'main');
const userData = fs.mkdtempSync(path.join(os.tmpdir(), 'cb-test-sync-keys-'));

const electronStub = {
    app: {
        getPath: () => userData,
        getVersion: () => '1.0.0',
    },
    // No OS keystore: the vault falls back to storing the data key unwrapped,
    // which is the Linux-without-a-keyring path and is fine for a test.
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

const syncKeys = require(path.join(ROOT, 'sync-keys.js'));

let passed = 0;
const check = (label, fn) => {
    try {
        fn();
        console.log(`  ok   ${label}`);
        passed++;
    } catch (error) {
        console.log(`  FAIL ${label}`);
        console.log(`       ${error.message}`);
        process.exitCode = 1;
    }
};

/* ---------------- registration ---------------- */

console.log('\nsync-keys: registration');

check('creates a 32-byte key and two envelopes wrapping it', () => {
    const { smk, passphraseEnvelope, recoveryEnvelope, recoveryCode } = syncKeys.createAccount('a good passphrase');

    assert.strictEqual(smk.length, 32);
    assert.strictEqual(passphraseEnvelope.format, 'reefterm-backup');
    assert.strictEqual(recoveryEnvelope.format, 'reefterm-backup');
    assert.ok(recoveryCode.length > 0);
});

check('rejects a passphrase shorter than the minimum', () => {
    assert.throws(() => syncKeys.createAccount('short'));
});

check('the recovery code is grouped for readability', () => {
    const { recoveryCode } = syncKeys.createAccount('a good passphrase');
    assert.match(recoveryCode, /^[0-9A-Z]{4}(-[0-9A-Z]{4}){5}$/);
});

check('two accounts never share a key or a recovery code', () => {
    const a = syncKeys.createAccount('a good passphrase');
    const b = syncKeys.createAccount('a good passphrase');

    assert.notStrictEqual(a.smk.toString('hex'), b.smk.toString('hex'));
    assert.notStrictEqual(a.recoveryCode, b.recoveryCode);
});

/* ---------------- unlocking ---------------- */

console.log('\nsync-keys: unlocking');

check('unlocks with the passphrase', () => {
    const { smk, passphraseEnvelope } = syncKeys.createAccount('a good passphrase');
    const opened = syncKeys.unsealSmk(passphraseEnvelope, 'a good passphrase');
    assert.strictEqual(opened.toString('hex'), smk.toString('hex'));
});

check('unlocks with the recovery code', () => {
    const { smk, recoveryEnvelope, recoveryCode } = syncKeys.createAccount('a good passphrase');
    const opened = syncKeys.unsealSmk(recoveryEnvelope, recoveryCode);
    assert.strictEqual(opened.toString('hex'), smk.toString('hex'));
});

check('the recovery code still works normalized (no hyphens, lowercase)', () => {
    const { smk, recoveryEnvelope, recoveryCode } = syncKeys.createAccount('a good passphrase');
    const typed = recoveryCode.toLowerCase().replace(/-/g, ' ');
    const opened = syncKeys.unsealSmk(recoveryEnvelope, syncKeys.normalizeRecoveryCode(typed));
    assert.strictEqual(opened.toString('hex'), smk.toString('hex'));
});

check('a wrong passphrase fails exactly like a tampered envelope: null, not a thrown error', () => {
    const { passphraseEnvelope } = syncKeys.createAccount('a good passphrase');
    assert.strictEqual(syncKeys.unsealSmk(passphraseEnvelope, 'the wrong passphrase'), null);
});

check('a wrong recovery code fails the same way', () => {
    const { recoveryEnvelope } = syncKeys.createAccount('a good passphrase');
    assert.strictEqual(syncKeys.unsealSmk(recoveryEnvelope, 'WRONG-CODE-ENTIRELY-HERE-XX'), null);
});

check('the passphrase envelope does not open with the recovery code, or vice versa', () => {
    const { passphraseEnvelope, recoveryEnvelope, recoveryCode } = syncKeys.createAccount('a good passphrase');
    assert.strictEqual(syncKeys.unsealSmk(passphraseEnvelope, recoveryCode), null);
    assert.strictEqual(syncKeys.unsealSmk(recoveryEnvelope, 'a good passphrase'), null);
});

/* ---------------- changing the passphrase ---------------- */

console.log('\nsync-keys: changing the passphrase');

check('resealing under a new passphrase opens with the new one', () => {
    const { smk } = syncKeys.createAccount('the old passphrase');
    const resealed = syncKeys.reseal(smk, 'the new passphrase');

    const opened = syncKeys.unsealSmk(resealed, 'the new passphrase');
    assert.strictEqual(opened.toString('hex'), smk.toString('hex'));
});

check('the old passphrase no longer opens the resealed envelope', () => {
    const { smk } = syncKeys.createAccount('the old passphrase');
    const resealed = syncKeys.reseal(smk, 'the new passphrase');
    assert.strictEqual(syncKeys.unsealSmk(resealed, 'the old passphrase'), null);
});

check('changing the passphrase leaves the recovery code working, unrelated to it', () => {
    const { smk, recoveryEnvelope, recoveryCode } = syncKeys.createAccount('the old passphrase');
    syncKeys.reseal(smk, 'the new passphrase'); // the recovery envelope is a separate row server-side; untouched here

    const opened = syncKeys.unsealSmk(recoveryEnvelope, recoveryCode);
    assert.strictEqual(opened.toString('hex'), smk.toString('hex'));
});

check('rejects resealing under a too-short passphrase', () => {
    const { smk } = syncKeys.createAccount('a good passphrase');
    assert.throws(() => syncKeys.reseal(smk, 'no'));
});

/* ---------------- rotating the recovery code ---------------- */

console.log('\nsync-keys: rotating the recovery code');

check('rotation produces a new code that opens the same key', () => {
    const { smk } = syncKeys.createAccount('a good passphrase');
    const { recoveryCode, recoveryEnvelope } = syncKeys.rotateRecoveryCode(smk);

    const opened = syncKeys.unsealSmk(recoveryEnvelope, recoveryCode);
    assert.strictEqual(opened.toString('hex'), smk.toString('hex'));
});

check('the old recovery code does not open the rotated envelope', () => {
    const { smk, recoveryCode: oldCode } = syncKeys.createAccount('a good passphrase');
    const { recoveryEnvelope } = syncKeys.rotateRecoveryCode(smk);

    assert.strictEqual(syncKeys.unsealSmk(recoveryEnvelope, oldCode), null);
});

/* ---------------- local cache ---------------- */

console.log('\nsync-keys: local cache');

check('caches and reloads the key', () => {
    const { smk } = syncKeys.createAccount('a good passphrase');
    syncKeys.cacheSmk(smk);

    const loaded = syncKeys.loadCachedSmk();
    assert.strictEqual(loaded.toString('hex'), smk.toString('hex'));
});

check('reports no cached key when none was ever cached', () => {
    fs.rmSync(path.join(userData, 'sync-keys.json'), { force: true });
    assert.strictEqual(syncKeys.loadCachedSmk(), null);
});

check('clearing the cache removes the file', () => {
    const { smk } = syncKeys.createAccount('a good passphrase');
    syncKeys.cacheSmk(smk);
    syncKeys.clearCache();

    assert.strictEqual(syncKeys.loadCachedSmk(), null);
    assert.ok(!fs.existsSync(path.join(userData, 'sync-keys.json')));
});

check('the cache file on disk never contains the key in the clear', () => {
    const { smk } = syncKeys.createAccount('a good passphrase');
    syncKeys.cacheSmk(smk);

    const onDisk = fs.readFileSync(path.join(userData, 'sync-keys.json'), 'utf8');
    assert.ok(!onDisk.includes(smk.toString('base64')), 'the raw key appears in the cache file');
});

console.log(`\n${passed} checks passed${process.exitCode ? ', with failures above' : ''}`);
