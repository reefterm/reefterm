const { app } = require('electron');
const crypto = require('crypto');
const fs = require('fs');
const path = require('path');
const backup = require('./backup');
const vault = require('./vault');

/**
 * The Sync Master Key (SMK): the one secret that actually encrypts a synced
 * setup, and everything involved in getting a person back to it.
 *
 * The design is zero-knowledge. A self-hosted sync server -- someone else's
 * machine, or a community instance run by someone the user has never met --
 * must never be able to read what it stores, which means it must never see
 * this key or anything that derives it.
 *
 * The SMK itself is 32 random bytes, generated once on this machine and
 * never sent anywhere in the clear. What the server holds instead are two
 * independent *wrapped* copies of it -- envelopes, in backup.js's sense --
 * each opened by a different secret:
 *
 *   passphrase envelope   opened by the account passphrase the user chose
 *   recovery envelope     opened by a one-time recovery code shown once
 *
 * Both envelopes wrap the same SMK, but neither can be used to derive the
 * other's opening secret or the key itself. Losing the passphrase is
 * recoverable, once, with the code. Losing both is not recoverable at all --
 * that is the guarantee, not a gap in it.
 *
 * backup.js's existing seal()/unseal() is the wrapping primitive, unmodified:
 * scrypt-derive a key from whatever secret is offered, AES-256-GCM the
 * payload under it. It was written for passphrase-protected local backups,
 * but a passphrase and a recovery code are the same shape of secret to it.
 *
 * This module never talks to the network. Sending envelopes to a server and
 * fetching them back is the caller's job; what lives here is only the
 * cryptography and the local cache.
 */

const SMK_BYTES = 32;
const RECOVERY_BYTES = 15;

const SCHEMA_VERSION = 1;

const cachePath = () => path.join(app.getPath('userData'), 'sync-keys.json');

/* ------------------------------------------------------------------ *
 * Recovery codes
 *
 * Crockford's base32: no padding, and it drops I, L, O and U so a code
 * cannot be misread as a different one when copied by hand. 15 bytes is 120
 * bits -- far more than a passphrase needs to be memorable, because this is
 * never meant to be memorised. It is meant to be written down once.
 * ------------------------------------------------------------------ */

const CROCKFORD_ALPHABET = '0123456789ABCDEFGHJKMNPQRSTVWXYZ';

function base32Encode(buffer) {
    let bits = 0;
    let value = 0;
    let output = '';

    for (const byte of buffer) {
        value = (value << 8) | byte;
        bits += 8;

        while (bits >= 5) {
            output += CROCKFORD_ALPHABET[(value >>> (bits - 5)) & 0x1f];
            bits -= 5;
        }
    }

    if (bits > 0) {
        output += CROCKFORD_ALPHABET[(value << (5 - bits)) & 0x1f];
    }

    return output;
}

/** "XXXX-XXXX-XXXX-XXXX-XXXX-XXXX": easy to read back a group at a time. */
function formatRecoveryCode(raw) {
    return raw.match(/.{1,4}/g).join('-');
}

/**
 * Whatever a person typed or pasted -- any case, any spacing, hyphens or
 * not -- normalized back to the exact grouped, uppercase string the
 * envelope was sealed under. The hyphens are part of the secret sealSmk()
 * used, not decoration to strip: unsealing needs the identical string back,
 * not just the same characters in some other arrangement.
 */
function normalizeRecoveryCode(code) {
    const raw = String(code || '').replace(/[\s-]/g, '').toUpperCase();
    return raw ? formatRecoveryCode(raw) : '';
}

function generateRecoveryCode() {
    const raw = base32Encode(crypto.randomBytes(RECOVERY_BYTES));
    return formatRecoveryCode(raw);
}

/* ------------------------------------------------------------------ *
 * Sealing and unsealing the SMK
 * ------------------------------------------------------------------ */

const sealSmk = (smk, secret) => backup.seal({ key: smk.toString('base64') }, secret);

/**
 * Opens an envelope with a passphrase or recovery code. Returns the SMK, or
 * null when the secret is wrong -- identical to a tampered envelope, by
 * backup.unseal()'s own design, so this cannot be used as an oracle to tell
 * "wrong passphrase" apart from "corrupted data".
 */
function unsealSmk(envelope, secret) {
    const payload = backup.unseal(envelope, secret);
    if (!payload?.key) return null;

    const smk = Buffer.from(payload.key, 'base64');
    return smk.length === SMK_BYTES ? smk : null;
}

/* ------------------------------------------------------------------ *
 * Registration and rotation
 * ------------------------------------------------------------------ */

/**
 * Start a brand new account: a fresh SMK, wrapped under the chosen
 * passphrase and under a freshly generated recovery code.
 *
 * The recovery code is returned in the clear exactly once, in this return
 * value -- the one deliberate exception to "no secret material crosses the
 * IPC bridge" elsewhere in this app. The caller must show it to the user,
 * get their confirmation that it is saved, and then let it go: this module
 * never persists the plaintext code anywhere, and neither should anything
 * downstream of it.
 */
function createAccount(passphrase) {
    const problem = backup.validatePassphrase(passphrase);
    if (problem) throw new Error(problem);

    const smk = crypto.randomBytes(SMK_BYTES);
    const recoveryCode = generateRecoveryCode();

    return {
        smk,
        recoveryCode,
        passphraseEnvelope: sealSmk(smk, passphrase),
        recoveryEnvelope: sealSmk(smk, recoveryCode),
    };
}

/** Re-wrap an existing SMK under a new passphrase. The recovery envelope is untouched. */
function reseal(smk, passphrase) {
    const problem = backup.validatePassphrase(passphrase);
    if (problem) throw new Error(problem);

    return sealSmk(smk, passphrase);
}

/**
 * Generate a fresh recovery code and wrap the SMK under it, replacing the
 * old one. Called after every successful recovery-code redemption: the code
 * that was just typed into a device has been seen, so treating it as spent
 * is the safe default even though nothing enforces single use server-side.
 */
function rotateRecoveryCode(smk) {
    const recoveryCode = generateRecoveryCode();
    return { recoveryCode, recoveryEnvelope: sealSmk(smk, recoveryCode) };
}

/* ------------------------------------------------------------------ *
 * Local cache
 *
 * Asking for the passphrase on every launch would defeat the point of an
 * always-on sync: this app already keeps far more sensitive material (host
 * passwords, private keys) behind the same local vault, so caching the SMK
 * there too is not a lower bar than the rest of the app already accepts.
 * The passphrase's job becomes joining a new device and disaster recovery,
 * not gating every sync -- authorising a sync on a known device degrades to
 * "the local vault is unlocked", exactly the tradeoff the vault already
 * makes for every other stored secret.
 * ------------------------------------------------------------------ */

function readCache() {
    try {
        return JSON.parse(fs.readFileSync(cachePath(), 'utf8'));
    } catch {
        return null;
    }
}

/** Encrypted under the local vault's own key, same as any other stored secret. */
function cacheSmk(smk) {
    const payload = {
        version: SCHEMA_VERSION,
        smk: vault.encryptSecret(smk.toString('base64')),
    };
    fs.writeFileSync(cachePath(), JSON.stringify(payload, null, 2), { mode: 0o600 });
}

/** Returns the cached SMK, or null if there is none or the vault is locked. */
function loadCachedSmk() {
    const raw = readCache();
    if (!raw?.smk) return null;

    const decoded = vault.decryptSecret(raw.smk);
    if (!decoded) return null;

    const smk = Buffer.from(decoded, 'base64');
    return smk.length === SMK_BYTES ? smk : null;
}

function clearCache() {
    try {
        fs.rmSync(cachePath(), { force: true });
    } catch (error) {
        console.error('Failed to remove the cached sync key:', error.message);
    }
}

module.exports = {
    createAccount,
    unsealSmk,
    reseal,
    rotateRecoveryCode,
    cacheSmk,
    loadCachedSmk,
    clearCache,
    normalizeRecoveryCode,
    // Exported for tests: the format is worth pinning down without going
    // through the full createAccount flow.
    generateRecoveryCode,
};
