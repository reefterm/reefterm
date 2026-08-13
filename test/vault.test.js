/**
 * Exercises vault.js: the credential vault's envelope encryption (the DEK,
 * wrapped by the OS keystore and/or a password), unlock/lock/set/change/
 * disable, the legacy-lock-to-envelope migration, unlock hooks, and the
 * encrypt/decrypt primitives store.js builds on.
 *
 * `electron` is stubbed so this runs under plain node, the same pattern
 * store.test.js and backup.test.js use. Every test gets a fresh require of
 * vault.js (module-level `dek`/`record`/`failedAttempts` state would
 * otherwise leak between tests) pointed at its own temp userData directory.
 *
 * This is the vault's first test coverage. It is the highest-stakes file left
 * untested in the app - every stored credential's confidentiality rests on
 * this envelope being wrapped and unwrapped correctly - so it is written
 * against the module's public shape rather than its internals, ahead of any
 * further work on it.
 */
const Module = require('module');
const path = require('path');
const fs = require('fs');
const os = require('os');
const crypto = require('crypto');
const assert = require('assert');
const { describe, test } = require('node:test');

const ROOT = path.join(__dirname, '..', 'src', 'main');

/**
 * A safeStorage stand-in that actually encrypts, so the keystore-wrapped path
 * is exercised for real rather than just assumed to pass its bytes through.
 * Not real DPAPI/Keychain: a fixed key, which is exactly what makes it
 * reproducible in a test and is worthless as a description of real safety.
 */
function fakeKeystore() {
    const key = crypto.scryptSync('fake-os-keystore', Buffer.alloc(16), 32);
    return {
        isEncryptionAvailable: () => true,
        encryptString: (plaintext) => {
            const iv = Buffer.alloc(12); // fixed IV: fine for a test double, never for real use
            const cipher = crypto.createCipheriv('aes-256-gcm', key, iv);
            const body = Buffer.concat([cipher.update(plaintext, 'utf8'), cipher.final()]);
            return Buffer.concat([cipher.getAuthTag(), body]);
        },
        decryptString: (blob) => {
            const iv = Buffer.alloc(12);
            const tag = blob.subarray(0, 16);
            const body = blob.subarray(16);
            const decipher = crypto.createDecipheriv('aes-256-gcm', key, iv);
            decipher.setAuthTag(tag);
            return Buffer.concat([decipher.update(body), decipher.final()]).toString('utf8');
        },
    };
}

const noKeystore = () => ({
    isEncryptionAvailable: () => false,
    encryptString: () => { throw new Error('unavailable'); },
    decryptString: () => { throw new Error('unavailable'); },
});

/** Loads a fresh vault.js under a stubbed `electron`, isolated per test. */
function freshVault({ userData = null, keystore = false } = {}) {
    const dir = userData || fs.mkdtempSync(path.join(os.tmpdir(), 'rt-test-vault-'));
    const electronStub = {
        app: { getPath: (what) => (what === 'userData' ? dir : os.tmpdir()) },
        safeStorage: keystore ? fakeKeystore() : noKeystore(),
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
        return { vault: require(path.join(ROOT, 'vault')), userData: dir };
    } finally {
        Module._load = realLoad;
    }
}

/** Small KDF params embedded directly in a legacy lock, so tests don't pay the ~100ms real cost. */
const FAST_KDF = { N: 1024, r: 1, p: 1, keylen: 32 };

function legacyHash(password, salt, params = FAST_KDF) {
    return crypto.scryptSync(String(password), salt, params.keylen, {
        N: params.N, r: params.r, p: params.p, maxmem: 64 * 1024 * 1024,
    });
}

/** Writes a pre-envelope lock.json the way the old lock screen used to. */
function writeLegacyLock(userData, password) {
    const salt = crypto.randomBytes(16);
    const hash = legacyHash(password, salt);
    fs.writeFileSync(path.join(userData, 'lock.json'), JSON.stringify({
        salt: salt.toString('hex'),
        hash: hash.toString('hex'),
        params: FAST_KDF,
    }));
}

/* ---------------- no password (keystore-only) ---------------- */

describe('vault: no password set', () => {
    test('is not enabled, is never locked, and a key materialises on first use', () => {
        const { vault } = freshVault();
        assert.strictEqual(vault.isEnabled(), false);
        assert.strictEqual(vault.isLocked(), false);
        assert.strictEqual(vault.hasKey(), true);
    });

    test('a secret encrypted now still decrypts after the module is reloaded', () => {
        const { vault, userData } = freshVault();
        const stored = vault.encryptSecret('hunter2');
        assert.ok(vault.isVaultSecret(stored));

        const { vault: reopened } = freshVault({ userData });
        assert.strictEqual(reopened.decryptSecret(stored), 'hunter2');
    });

    test('writes a vault.json on first key use, not before', () => {
        const { vault, userData } = freshVault();
        assert.strictEqual(fs.existsSync(path.join(userData, 'vault.json')), false);
        vault.hasKey();
        assert.strictEqual(fs.existsSync(path.join(userData, 'vault.json')), true);
    });

    test('status reports keystore protection and no password', () => {
        const { vault } = freshVault();
        const status = vault.status();
        assert.strictEqual(status.enabled, false);
        assert.strictEqual(status.locked, false);
        assert.strictEqual(status.protection, 'keystore');
    });
});

/* ---------------- setting a password ---------------- */

describe('vault: set', () => {
    test('rejects a password shorter than the minimum', () => {
        const { vault } = freshVault();
        const result = vault.set('short');
        assert.strictEqual(result.success, false);
        assert.match(result.message, /8 characters/);
    });

    test('refuses to set a second password over an existing one', () => {
        const { vault } = freshVault();
        assert.strictEqual(vault.set('first-password').success, true);
        const second = vault.set('second-password');
        assert.strictEqual(second.success, false);
    });

    test('a secret encrypted before the password was set still decrypts after', () => {
        const { vault } = freshVault();
        const stored = vault.encryptSecret('hunter2');

        assert.strictEqual(vault.set('a-strong-password').success, true);
        assert.strictEqual(vault.decryptSecret(stored), 'hunter2');
    });

    test('stays unlocked in this process right after set, but needs the password on reload', () => {
        const { vault, userData } = freshVault();
        vault.set('a-strong-password');
        assert.strictEqual(vault.isLocked(), false);

        const { vault: reopened } = freshVault({ userData });
        assert.strictEqual(reopened.isEnabled(), true);
        assert.strictEqual(reopened.isLocked(), true);
    });

    test('the vault file never holds the password or the plaintext secret', () => {
        const { vault, userData } = freshVault();
        vault.encryptSecret('hunter2');
        vault.set('a-strong-password');

        const onDisk = fs.readFileSync(path.join(userData, 'vault.json'), 'utf8');
        assert.ok(!onDisk.includes('hunter2'));
        assert.ok(!onDisk.includes('a-strong-password'));
    });
});

/* ---------------- unlocking ---------------- */

describe('vault: unlock', () => {
    test('succeeds trivially when no password is set', async () => {
        const { vault } = freshVault();
        const result = await vault.unlock('anything');
        assert.strictEqual(result.success, true);
    });

    test('the right password unlocks; a wrong one does not and says so', async () => {
        const { vault, userData } = freshVault();
        vault.set('a-strong-password');

        const { vault: reopened } = freshVault({ userData });
        const wrong = await reopened.unlock('not-the-password');
        assert.strictEqual(wrong.success, false);
        assert.match(wrong.message, /Incorrect password/);
        assert.strictEqual(reopened.isLocked(), true);

        const right = await reopened.unlock('a-strong-password');
        assert.strictEqual(right.success, true);
        assert.strictEqual(reopened.isLocked(), false);
    });

    test('unlocking decrypts a secret written before the reload', async () => {
        const { vault, userData } = freshVault();
        const stored = vault.encryptSecret('hunter2');
        vault.set('a-strong-password');

        const { vault: reopened } = freshVault({ userData });
        await reopened.unlock('a-strong-password');
        assert.strictEqual(reopened.decryptSecret(stored), 'hunter2');
    });

    test('unlock() re-derives the key and re-runs hooks on every successful call, even when already unlocked', async () => {
        // Unlike ensureKey() (see below), unlock() has no "already have a key"
        // guard of its own: every correct-password call re-verifies and
        // re-fires the hooks, which is what lets the settings screen call
        // unlock() again to confirm a password without it being a no-op.
        const { vault, userData } = freshVault();
        vault.set('a-strong-password');

        const { vault: reopened } = freshVault({ userData });
        let calls = 0;
        reopened.onUnlocked(() => { calls += 1; });

        await reopened.unlock('a-strong-password');
        assert.strictEqual(calls, 1);

        await reopened.unlock('a-strong-password');
        assert.strictEqual(calls, 2);
    });

    test('ensureKey()-driven calls do not re-run hooks once a key is already held', async () => {
        const { vault, userData } = freshVault();
        vault.set('a-strong-password');

        const { vault: reopened } = freshVault({ userData });
        let calls = 0;
        reopened.onUnlocked(() => { calls += 1; });

        await reopened.unlock('a-strong-password');
        assert.strictEqual(calls, 1);

        reopened.hasKey();
        reopened.encryptSecret('x');
        assert.strictEqual(calls, 1);
    });

    test('a hook that throws is swallowed rather than breaking the unlock', () => {
        const { vault } = freshVault();
        vault.onUnlocked(() => { throw new Error('boom'); });
        assert.doesNotThrow(() => vault.hasKey());
    });
});

/* ---------------- locking ---------------- */

describe('vault: lock', () => {
    test('forgets the key; a locked vault refuses to encrypt', () => {
        const { vault } = freshVault();
        vault.set('a-strong-password');
        assert.strictEqual(vault.lock().success, true);
        assert.strictEqual(vault.isLocked(), true);
        assert.throws(() => vault.encryptSecret('x'), /locked/);
    });

    test('a locked vault decrypts to empty rather than throwing', () => {
        const { vault } = freshVault();
        const stored = vault.encryptSecret('hunter2');
        vault.set('a-strong-password');
        vault.lock();
        assert.strictEqual(vault.decryptSecret(stored), '');
    });

    test('refuses to lock when no password is set', () => {
        const { vault } = freshVault();
        const result = vault.lock();
        assert.strictEqual(result.success, false);
    });
});

/* ---------------- changing the password ---------------- */

describe('vault: change', () => {
    test('wrong current password is refused', () => {
        const { vault } = freshVault();
        vault.set('first-password');
        const result = vault.change('not-it', 'second-password');
        assert.strictEqual(result.success, false);
    });

    test('rejects a new password that fails validation', () => {
        const { vault } = freshVault();
        vault.set('first-password');
        const result = vault.change('first-password', 'short');
        assert.strictEqual(result.success, false);
    });

    test('the DEK survives a change: old secrets decrypt under the new password', async () => {
        const { vault, userData } = freshVault();
        const stored = vault.encryptSecret('hunter2');
        vault.set('first-password');
        assert.strictEqual(vault.change('first-password', 'second-password').success, true);

        const { vault: reopened } = freshVault({ userData });
        const wrongOld = await reopened.unlock('first-password');
        assert.strictEqual(wrongOld.success, false);

        const withNew = await reopened.unlock('second-password');
        assert.strictEqual(withNew.success, true);
        assert.strictEqual(reopened.decryptSecret(stored), 'hunter2');
    });
});

/* ---------------- disabling the password ---------------- */

describe('vault: disable', () => {
    test('is a no-op success when no password was set', () => {
        const { vault } = freshVault();
        assert.strictEqual(vault.disable('anything').success, true);
    });

    test('wrong password refuses to disable', () => {
        const { vault } = freshVault();
        vault.set('a-strong-password');
        const result = vault.disable('not-it');
        assert.strictEqual(result.success, false);
        assert.strictEqual(vault.isEnabled(), true);
    });

    test('drops back to keystore-only, and old secrets keep decrypting with no unlock needed', () => {
        const { vault, userData } = freshVault();
        const stored = vault.encryptSecret('hunter2');
        vault.set('a-strong-password');
        assert.strictEqual(vault.disable('a-strong-password').success, true);

        const { vault: reopened } = freshVault({ userData });
        assert.strictEqual(reopened.isEnabled(), false);
        assert.strictEqual(reopened.isLocked(), false);
        assert.strictEqual(reopened.decryptSecret(stored), 'hunter2');
    });
});

/* ---------------- the OS keystore layer ---------------- */

describe('vault: keystore wrapping', () => {
    test('a secret round-trips when the keystore is available', () => {
        const { vault, userData } = freshVault({ keystore: true });
        const stored = vault.encryptSecret('hunter2');

        const { vault: reopened } = freshVault({ userData, keystore: true });
        assert.strictEqual(reopened.decryptSecret(stored), 'hunter2');
    });

    test('a vault written under the keystore refuses to open without it', () => {
        const { vault, userData } = freshVault({ keystore: true });
        vault.hasKey(); // forces the vault to actually be written

        const { vault: reopened } = freshVault({ userData, keystore: false });
        assert.throws(() => reopened.hasKey(), /OS keystore/);
    });

    test('keystoreAvailable never throws even when safeStorage itself does', () => {
        const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'rt-test-vault-'));
        const electronStub = {
            app: { getPath: () => dir },
            safeStorage: { isEncryptionAvailable: () => { throw new Error('no platform support'); } },
        };
        const realLoad = Module._load;
        Module._load = function (request, parent, isMain) {
            if (request === 'electron') return electronStub;
            return realLoad.call(this, request, parent, isMain);
        };
        let vault;
        try {
            for (const key of Object.keys(require.cache)) {
                if (key.includes(`${path.sep}main${path.sep}`)) delete require.cache[key];
            }
            vault = require(path.join(ROOT, 'vault'));
        } finally {
            Module._load = realLoad;
        }
        assert.strictEqual(vault.keystoreAvailable(), false);
    });
});

/* ---------------- secrets ---------------- */

describe('vault: encryptSecret / decryptSecret', () => {
    test('marks its own output so the store can tell a v2 secret from a legacy one', () => {
        const { vault } = freshVault();
        const stored = vault.encryptSecret('hunter2');
        assert.ok(vault.isVaultSecret(stored));
        assert.strictEqual(vault.isVaultSecret('plaintext'), false);
        assert.strictEqual(vault.isVaultSecret(''), false);
        assert.strictEqual(vault.isVaultSecret(undefined), false);
    });

    test('never stores the plaintext inside the encrypted value', () => {
        const { vault } = freshVault();
        const stored = vault.encryptSecret('hunter2');
        assert.ok(!stored.includes('hunter2'));
    });

    test('a tampered ciphertext fails closed rather than returning garbage', () => {
        const { vault } = freshVault();
        const stored = vault.encryptSecret('hunter2');
        const tampered = stored.slice(0, -4) + (stored.slice(-4) === 'AAAA' ? 'BBBB' : 'AAAA');
        assert.strictEqual(vault.decryptSecret(tampered), '');
    });
});

/* ---------------- legacy lock migration ---------------- */

describe('vault: legacy lock migration', () => {
    test('a legacy lock with no vault yet reports enabled and locked', () => {
        const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'rt-test-vault-'));
        writeLegacyLock(dir, 'old-password');
        const { vault } = freshVault({ userData: dir });

        assert.strictEqual(vault.isEnabled(), true);
        assert.strictEqual(vault.isLocked(), true);
        assert.strictEqual(vault.status().protection, 'legacy');
    });

    test('the wrong legacy password is refused and the lock file survives', async () => {
        const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'rt-test-vault-'));
        writeLegacyLock(dir, 'old-password');
        const { vault } = freshVault({ userData: dir });

        const result = await vault.unlock('not-it');
        assert.strictEqual(result.success, false);
        assert.strictEqual(fs.existsSync(path.join(dir, 'lock.json')), true);
        assert.strictEqual(fs.existsSync(path.join(dir, 'vault.json')), false);
    });

    test('the right legacy password upgrades to a real vault and removes the old lock', async () => {
        const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'rt-test-vault-'));
        writeLegacyLock(dir, 'old-password');
        const { vault } = freshVault({ userData: dir });

        const result = await vault.unlock('old-password');
        assert.strictEqual(result.success, true);
        assert.strictEqual(fs.existsSync(path.join(dir, 'lock.json')), false);
        assert.strictEqual(fs.existsSync(path.join(dir, 'vault.json')), true);
        assert.strictEqual(vault.isLocked(), false);

        // The new vault holds a real DEK, so it survives a reload with the
        // same password rather than the lock's old verify-only behaviour.
        const { vault: reopened } = freshVault({ userData: dir });
        assert.strictEqual((await reopened.unlock('old-password')).success, true);
    });

    test('an upgrade runs the unlock hooks so pre-envelope secrets can be brought under the DEK', async () => {
        const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'rt-test-vault-'));
        writeLegacyLock(dir, 'old-password');
        const { vault } = freshVault({ userData: dir });

        let ran = false;
        vault.onUnlocked(() => { ran = true; });
        await vault.unlock('old-password');
        assert.strictEqual(ran, true);
    });
});

/* ---------------- a corrupt or unreadable vault file ---------------- */

describe('vault: corrupt vault.json', () => {
    test('is treated as no vault, rather than crashing', () => {
        const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'rt-test-vault-'));
        fs.writeFileSync(path.join(dir, 'vault.json'), '{not json');
        const { vault } = freshVault({ userData: dir });

        assert.doesNotThrow(() => vault.status());
        assert.strictEqual(vault.isEnabled(), false);
        assert.strictEqual(vault.hasKey(), true);
    });

    test('a vault.json with no wrapped field is also treated as no vault', () => {
        const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'rt-test-vault-'));
        fs.writeFileSync(path.join(dir, 'vault.json'), JSON.stringify({ version: 1 }));
        const { vault } = freshVault({ userData: dir });

        assert.strictEqual(vault.isEnabled(), false);
    });
});
