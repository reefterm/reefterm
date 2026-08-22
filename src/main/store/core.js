const { app, safeStorage } = require('electron');
const path = require('path');
const fs = require('fs');
const { normalizeProtocol, describeSerial, defaultPort } = require('../protocol-config');
const vault = require('../vault');

const SCHEMA_VERSION = 2;

// Fields that must never be written in the clear. `vncPassword`, `rdpPassword`
// and `bmcPassword` are flat rather than nested inside the `desktop` and `bmc`
// blocks so that every mechanism keyed off this list (encryption on save, the
// re-encrypt pass when the vault opens, redaction, backup export and restore)
// covers them without knowing anything about remote desktops or service
// processors.
//
// "Never leaves the main process" holds for all of these but `rdpPassword`,
// which is the documented exception: CredSSP runs in the WASM client, so rdp.js
// returns it once at open. It is still stored, logged and redacted like the
// rest, and never appears in a host record crossing IPC.
//
// `bmcPassword` is not an exception, and is the one it would be worst to make
// one of: it is root on the hardware, under the operating system. bmc.js puts
// it into the guest page from the main process precisely so it never has to
// pass through our own renderer.
const SECRET_FIELDS = ['password', 'privateKey', 'passphrase', 'vncPassword', 'rdpPassword', 'bmcPassword'];

/**
 * The only secret a proxy record has, named separately so a proxy is not written
 * out carrying four empty fields that belong to hosts and keys. Everything that
 * walks SECRET_FIELDS over a whole collection still covers it, because it skips
 * fields that hold nothing.
 */
const PROXY_SECRET_FIELDS = ['password'];

const ENC_PREFIX = 'enc.v1:';
const PLAIN_PREFIX = 'plain.v1:';

const storePath = () => path.join(app.getPath('userData'), 'sessions.json');
const backupPath = () => storePath() + '.bak';

let cache = null;
// Guards the re-entrancy between load(), the vault's unlock hook and this
// module's own upgrade pass.
let protecting = false;

function emptyStore() {
    return { version: SCHEMA_VERSION, hosts: [], folders: [], keys: [], snippets: [], proxies: [] };
}

/* ------------------------------------------------------------------ *
 * Secret handling
 * ------------------------------------------------------------------ */

/**
 * Secrets are written under the vault's data key, so an opening password (which
 * wraps that key) protects the file itself rather than only the window in front
 * of it. Throws when the vault is locked, because a save that quietly stored
 * nothing would look exactly like one that worked.
 */
function encryptSecret(value) {
    if (!value) return '';
    return vault.encryptSecret(value);
}

/** Pre-envelope formats: keystore-wrapped, obfuscated, or v1 plaintext. */
function decryptLegacy(stored) {
    // Peels one layer; an earlier bug could wrap a secret more than once, so
    // keep unwrapping until we reach something that is not our own ciphertext.
    let value = stored;
    for (let depth = 0; depth < 8; depth++) {
        try {
            if (value.startsWith(ENC_PREFIX)) {
                value = safeStorage.decryptString(Buffer.from(value.slice(ENC_PREFIX.length), 'base64'));
            } else if (value.startsWith(PLAIN_PREFIX)) {
                value = Buffer.from(value.slice(PLAIN_PREFIX.length), 'base64').toString('utf8');
            } else {
                // Legacy v1 plaintext, or a fully unwrapped secret.
                return value;
            }
        } catch (error) {
            console.error('Failed to decrypt secret:', error.message);
            return '';
        }
    }
    console.error('Secret is nested deeper than expected; refusing to unwrap further');
    return '';
}

function decryptSecret(stored) {
    if (!stored) return '';

    // Nothing is handed out while locked, whatever format it is stored in. A
    // secret written before the envelope is still readable from the OS keystore
    // alone, and the whole point of the password is that reaching the keystore
    // is not enough. Those get re-encrypted the moment the vault opens.
    if (vault.isLocked()) return '';

    return vault.isVaultSecret(stored) ? vault.decryptSecret(stored) : decryptLegacy(stored);
}

/**
 * Whether stored credentials are protected by anything real. An opening
 * password counts on its own: it encrypts the data key without the OS keystore
 * being involved, which is the case on a Linux box with no keyring.
 */
function isEncryptionAvailable() {
    return vault.keystoreAvailable() || vault.isEnabled();
}

const isCiphertext = (value) =>
    typeof value === 'string'
    && (vault.isVaultSecret(value) || value.startsWith(ENC_PREFIX) || value.startsWith(PLAIN_PREFIX));

/**
 * Bring every secret under the vault key.
 *
 * Runs whenever the key becomes available. A record left in a pre-envelope
 * format would stay readable with the OS keystore alone, so a password that
 * covered everything else would not cover that one.
 */
function protectSecrets() {
    // `cache` rather than load(): asking the vault for a key runs this hook
    // again, and during the v1 migration the store is still being built.
    if (protecting || !cache) return 0;

    protecting = true;
    try {
        if (!vault.hasKey()) return 0;

        const store = cache;
        let upgraded = 0;

        for (const item of [...store.hosts, ...store.keys, ...store.proxies]) {
            for (const field of SECRET_FIELDS) {
                const value = item[field];
                if (!value || vault.isVaultSecret(value)) continue;

                const plain = decryptLegacy(value);
                item[field] = plain ? vault.encryptSecret(plain) : '';
                upgraded++;
            }
        }

        if (upgraded > 0) {
            console.log(`Re-encrypted ${upgraded} secret(s) under the vault key`);
            persist();
        }
        return upgraded;
    } catch (error) {
        console.error('Could not re-encrypt stored secrets:', error.message);
        return 0;
    } finally {
        protecting = false;
    }
}

// The key can arrive later than this module (a locked app unlocks mid-run), so
// the upgrade is driven by the vault rather than run once at startup.
vault.onUnlocked(protectSecrets);

/**
 * Apply incoming secret fields to a record.
 *   undefined / ''  -> keep whatever is already stored (edit without retyping)
 *   null            -> clear the secret
 *   non-empty       -> encrypt and replace
 *
 * `incoming` must be the caller's own object, never one already merged over
 * `existing`. Otherwise a save that omits a secret would hand us the stored
 * ciphertext and we would encrypt it a second time.
 */
function mergeSecrets(record, incoming, existing = {}, fields = SECRET_FIELDS) {
    const result = { ...record };
    for (const field of fields) {
        const value = incoming[field];
        if (value === null) {
            result[field] = '';
        } else if (value === undefined || value === '') {
            result[field] = existing[field] || '';
        } else if (isCiphertext(value)) {
            // Already encrypted (a record round-tripping through a caller);
            // storing it as-is keeps it from gaining another layer.
            result[field] = value;
        } else {
            result[field] = encryptSecret(value);
        }
    }
    return result;
}

/** `user@address:port`, the form the activity log names a server by. */
function describeAddress(host) {
    // A serial host has no address in this sense: no user, no port number, and
    // nothing a network could route. It is named by the cable instead, in the
    // same `COM3 · 115200 8N1` form the pane header uses, so a log line still
    // says which console was reached.
    if (normalizeProtocol(host?.protocol) === 'serial') {
        return describeSerial(host?.serial);
    }

    if (!host?.host) return '';
    const standard = defaultPort(host?.protocol);
    const port = host.port || standard;
    const where = port === standard ? host.host : `${host.host}:${port}`;
    // Telnet asks for a login over the connection itself, so there is no
    // username on the record to name it by even when the device has one.
    return host.username ? `${host.username}@${where}` : where;
}

/* ------------------------------------------------------------------ *
 * Disk I/O
 * ------------------------------------------------------------------ */

/** Write via temp file + fsync + rename so a crash can never truncate the store. */
function writeAtomic(file, contents) {
    const tmp = `${file}.${process.pid}.tmp`;
    const fd = fs.openSync(tmp, 'w');
    try {
        fs.writeFileSync(fd, contents, 'utf8');
        fs.fsyncSync(fd);
    } finally {
        fs.closeSync(fd);
    }
    if (fs.existsSync(file)) {
        fs.copyFileSync(file, backupPath());
    }
    fs.renameSync(tmp, file);
}

/** v1 was a flat array with records discriminated by `type` / `isFolder`. */
function migrateV1(entries) {
    const migrated = emptyStore();

    for (const entry of entries) {
        if (!entry || typeof entry !== 'object') continue;

        if (entry.type === 'folder' || entry.isFolder) {
            const { isFolder: _isFolder, type: _type, ...folder } = entry;
            migrated.folders.push(folder);
        } else if (entry.type === 'keychain') {
            // v1 overwrote each key's algorithm with the 'keychain' tag; it is
            // not recoverable, so fall back to blank rather than showing it.
            migrated.keys.push({
                ...entry,
                type: '',
                privateKey: encryptSecret(entry.privateKey),
                passphrase: encryptSecret(entry.passphrase),
            });
        } else {
            const { type: _type, ...host } = entry;
            migrated.hosts.push({
                ...host,
                password: encryptSecret(entry.password),
                privateKey: encryptSecret(entry.privateKey),
            });
        }
    }

    return migrated;
}

/** Remove exactly one layer of our own wrapping, or null if there is none. */
function peelOnce(value) {
    if (value.startsWith(ENC_PREFIX)) {
        return safeStorage.decryptString(Buffer.from(value.slice(ENC_PREFIX.length), 'base64'));
    }
    if (value.startsWith(PLAIN_PREFIX)) {
        return Buffer.from(value.slice(PLAIN_PREFIX.length), 'base64').toString('utf8');
    }
    return null;
}

/**
 * Re-wrap any secret that an earlier save encrypted more than once, so the
 * stored form is single-layered again. Returns how many were repaired.
 */
function repairNestedSecrets(store) {
    let repaired = 0;

    for (const record of [...store.hosts, ...store.keys, ...store.proxies]) {
        for (const field of SECRET_FIELDS) {
            const value = record[field];
            if (!isCiphertext(value)) continue;
            try {
                if (!isCiphertext(peelOnce(value))) continue; // already single-layered
                const plain = decryptSecret(value);
                record[field] = plain ? encryptSecret(plain) : '';
                repaired++;
            } catch (error) {
                console.error(`Could not repair ${field}:`, error.message);
            }
        }
    }

    return repaired;
}

/**
 * Build the store from disk. Never call directly: `load` holds the vault's
 * unlock hook off while this runs, so the upgrade pass cannot reach a store
 * that is still half-built.
 */
function loadFromDisk() {
    const file = storePath();
    try {
        if (!fs.existsSync(file)) {
            cache = emptyStore();
            return cache;
        }

        const parsed = JSON.parse(fs.readFileSync(file, 'utf8'));

        if (Array.isArray(parsed)) {
            console.log('Migrating sessions store from v1 to v2 (encrypting secrets)');
            fs.copyFileSync(file, file + '.v1.bak');
            cache = migrateV1(parsed);
            persist();
            return cache;
        }

        cache = {
            version: SCHEMA_VERSION,
            hosts: parsed.hosts || [],
            folders: parsed.folders || [],
            keys: parsed.keys || [],
            // Added after v2 shipped. A store written before then simply has
            // none, which needs no migration: the collection starts empty.
            snippets: parsed.snippets || [],
            proxies: parsed.proxies || [],
        };

        const repaired = repairNestedSecrets(cache);
        if (repaired > 0) {
            console.log(`Repaired ${repaired} over-encrypted secret(s)`);
            persist();
        }

        return cache;
    } catch (error) {
        console.error('Failed to load store, falling back to backup:', error.message);
        try {
            if (fs.existsSync(backupPath())) {
                // Merged over an empty store rather than used as it stands: a
                // backup written by an older build is missing whichever
                // collections were added since, and half this file spreads them
                // without checking. One collection short is a crash on load,
                // which is the worst possible moment for one.
                cache = { ...emptyStore(), ...JSON.parse(fs.readFileSync(backupPath(), 'utf8')) };
                return cache;
            }
        } catch (backupError) {
            console.error('Backup is unreadable too:', backupError.message);
        }
        cache = emptyStore();
        return cache;
    }
}

function load() {
    if (cache) return cache;

    // Asking the vault for a key runs the unlock hook, which calls back in
    // here. Held off until the store exists, then run once, deliberately.
    protecting = true;
    try {
        loadFromDisk();
    } finally {
        protecting = false;
    }

    protectSecrets();
    return cache;
}

/**
 * Notified after every successful write. The cloud snapshot uses this to know
 * it has something to upload; hooking the single place that writes is what
 * keeps it from having to be remembered at each of the two dozen call sites
 * that change something.
 */
const changeHooks = [];

function onChanged(hook) {
    changeHooks.push(hook);
}

function persist() {
    try {
        writeAtomic(storePath(), JSON.stringify(cache, null, 2));

        for (const hook of changeHooks) {
            try {
                hook();
            } catch (error) {
                // A listener must never be able to fail the write that fired it.
                console.error('Store change hook failed:', error.message);
            }
        }

        return true;
    } catch (error) {
        console.error('Failed to persist store:', error.message);
        return false;
    }
}

module.exports = {
    SECRET_FIELDS,
    PROXY_SECRET_FIELDS,
    load,
    persist,
    onChanged,
    isEncryptionAvailable,
    encryptSecret,
    decryptSecret,
    mergeSecrets,
    describeAddress,
};
