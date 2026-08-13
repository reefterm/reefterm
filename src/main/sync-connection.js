const { app, net } = require('electron');
const fs = require('fs');
const os = require('os');
const path = require('path');
const vault = require('./vault');
const syncKeys = require('./sync-keys');

/**
 * A connection to a self-hosted Reef Terminal sync server.
 *
 * Deliberately not framed as "an account": there is no identity this app
 * manages, no profile beyond an email address the server uses to tell one
 * login from another, and nothing here is required. The app is fully usable
 * with no server configured at all. What this module owns is narrower than
 * that -- registering with, authenticating to, and unlocking data from one
 * particular server the user (or someone they trust) chose to point it at.
 *
 * The login password and the E2EE passphrase are the same string by design
 * (see sync-keys.js): logging in and unlocking synced data happen in one
 * step, because to the person typing it, they are one action. The server
 * only ever sees that string for an argon2id hash comparison; the key it
 * derives locally for decryption never crosses the wire.
 *
 * Known limitation, worth being upfront about: a completely forgotten
 * passphrase with no device anywhere still holding a valid session cannot
 * currently be recovered. The recovery code lets an already-authenticated
 * session unlock or re-key without the passphrase; it is not yet a way back
 * in from a fully logged-out state. A zero-knowledge server cannot verify
 * possession of a recovery code it has never seen, so solving that properly
 * needs a second channel (e.g. an email-verified reset) this project does
 * not have yet, rather than a self-service endpoint that would just move
 * the trust problem instead of closing it.
 */

const SCHEMA_VERSION = 1;
const REQUEST_TIMEOUT_MS = 20 * 1000;

const statePath = () => path.join(app.getPath('userData'), 'sync-connection.json');

// The persisted connection, once loaded. `null` means "not loaded yet".
let state = null;

// The unlocked Sync Master Key, held only in memory for this run unless
// syncKeys.cacheSmk() has also put an encrypted copy on disk. Never
// persisted here directly.
let activeSmk = null;

/* ------------------------------------------------------------------ *
 * Persistence
 * ------------------------------------------------------------------ */

function load() {
    if (state) return state;

    try {
        const raw = JSON.parse(fs.readFileSync(statePath(), 'utf8'));

        state = {
            serverUrl: raw.serverUrl || '',
            userId: raw.userId || null,
            email: raw.email || null,
            connectedAt: raw.connectedAt || null,
            // Returns '' while the vault is locked, so a locked app reads as
            // signed out rather than throwing on every status poll.
            token: raw.token ? vault.decryptSecret(raw.token) : '',
        };
    } catch {
        state = { serverUrl: '', userId: null, email: null, connectedAt: null, token: '' };
    }

    return state;
}

function persist() {
    const current = load();

    fs.writeFileSync(statePath(), JSON.stringify({
        version: SCHEMA_VERSION,
        serverUrl: current.serverUrl,
        userId: current.userId,
        email: current.email,
        connectedAt: current.connectedAt,
        token: current.token ? vault.encryptSecret(current.token) : '',
    }, null, 2), { mode: 0o600 });
}

// A vault unlocked after startup has to invalidate the cached read, and is
// also the moment a cached sync key (if any) becomes readable.
vault.onUnlocked(() => {
    state = null;
    activeSmk = syncKeys.loadCachedSmk();
});

/* ------------------------------------------------------------------ *
 * HTTP
 * ------------------------------------------------------------------ */

/**
 * Uses Electron's net stack rather than Node's, so the request honours the
 * system proxy and certificate store -- a self-hosted server is very often
 * reached from behind a corporate proxy, or over a self-signed cert an admin
 * has trusted at the OS level.
 */
async function apiFetch(pathname, { method = 'GET', body, token } = {}) {
    const base = load().serverUrl;
    if (!base) throw new Error('No sync server configured');

    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), REQUEST_TIMEOUT_MS);

    try {
        const response = await net.fetch(`${base}${pathname}`, {
            method,
            signal: controller.signal,
            headers: {
                Accept: 'application/json',
                ...(body ? { 'Content-Type': 'application/json' } : {}),
                ...(token ? { Authorization: `Bearer ${token}` } : {}),
            },
            ...(body ? { body: JSON.stringify(body) } : {}),
        });

        const text = await response.text();
        let payload = null;

        try {
            payload = text ? JSON.parse(text) : null;
        } catch {
            // An HTML error page from a proxy, or a server that isn't this
            // one at all. Reported by status below rather than as a parse
            // failure the user cannot act on.
        }

        return { ok: response.ok, status: response.status, payload };
    } finally {
        clearTimeout(timer);
    }
}

/** This server's error envelope is `{ error: { message, ... } }`. */
const apiError = (result, fallback) =>
    result.payload?.error?.message || `${fallback} (HTTP ${result.status})`;

function deviceName() {
    const host = os.hostname() || 'Unknown device';
    return `Reef Terminal on ${host}`.slice(0, 60);
}

/* ------------------------------------------------------------------ *
 * Configuring which server to use
 * ------------------------------------------------------------------ */

function configure(serverUrl) {
    const trimmed = String(serverUrl || '').trim().replace(/\/+$/, '');

    if (!trimmed) throw new Error('Enter a server address');
    if (!/^https?:\/\//i.test(trimmed)) throw new Error('The server address must start with http:// or https://');

    state = { ...load(), serverUrl: trimmed };
    persist();

    return status();
}

/* ------------------------------------------------------------------ *
 * Register, log in, log out
 * ------------------------------------------------------------------ */

/**
 * Creates the account and unlocks it in the same step: registration
 * generates the Sync Master Key and returns the one-time recovery code
 * alongside it. The caller owns showing that code to the user exactly once
 * and then letting it go -- this module never writes the plaintext code
 * anywhere.
 */
async function register(email, passphrase, name = deviceName()) {
    if (!load().serverUrl) throw new Error('Configure a sync server first');

    const { smk, recoveryCode, passphraseEnvelope, recoveryEnvelope } = syncKeys.createAccount(passphrase);

    const result = await apiFetch('/api/v1/register', {
        method: 'POST',
        body: {
            email,
            login_password: passphrase,
            wrapped_key_passphrase: passphraseEnvelope,
            wrapped_key_recovery: recoveryEnvelope,
            device_name: name,
        },
    });

    if (!result.ok) throw new Error(apiError(result, 'Could not create your account'));

    const data = result.payload;

    activeSmk = smk;
    syncKeys.cacheSmk(smk);

    state = {
        ...load(),
        userId: data.user_id,
        email,
        connectedAt: new Date().toISOString(),
        token: data.session_token,
    };
    persist();

    return { status: status(), recoveryCode };
}

/**
 * Authenticates and unlocks in one call, because the password that does the
 * first also does the second. If the fetched passphrase envelope somehow
 * doesn't open with it -- data changed out from under this device some
 * other way -- that is reported rather than silently leaving the session
 * signed in but locked.
 */
async function login(email, passphrase, name = deviceName()) {
    const result = await apiFetch('/api/v1/login', {
        method: 'POST',
        body: { email, login_password: passphrase, device_name: name },
    });

    if (!result.ok) throw new Error(apiError(result, 'Could not sign in'));

    const data = result.payload;
    const token = data.session_token;

    const keysResult = await apiFetch('/api/v1/sync/keys', { token });
    if (!keysResult.ok) throw new Error(apiError(keysResult, 'Signed in, but could not fetch your account key'));

    const smk = syncKeys.unsealSmk(keysResult.payload?.wrapped_key_passphrase, passphrase);
    if (!smk) {
        throw new Error(
            'Signed in, but this password does not unlock your synced data. '
            + 'If you changed your password from another device, try again from there, '
            + 'or unlock with your recovery code.'
        );
    }

    activeSmk = smk;
    syncKeys.cacheSmk(smk);

    state = { ...load(), userId: data.user_id, email, connectedAt: new Date().toISOString(), token };
    persist();

    return status();
}

/**
 * Signing out revokes the session at the server first. Deleting it locally
 * alone would leave a working token behind that the user believes is gone.
 *
 * Local state clears either way: a user who is offline, or whose token the
 * server has already expired, must still be able to disconnect.
 */
async function logout() {
    const current = load();
    let revoked = false;

    if (current.token) {
        try {
            const result = await apiFetch('/api/v1/logout', { method: 'POST', token: current.token });
            // A 401 means the token was already invalid server-side, which is
            // the outcome disconnecting wanted anyway.
            revoked = result.ok || result.status === 401;
        } catch (error) {
            console.error('Failed to revoke the session on the server:', error.message);
        }
    }

    activeSmk = null;
    syncKeys.clearCache();

    // serverUrl is deliberately kept: which server this app points at is a
    // separate choice from whether it is currently signed in to it.
    state = { ...load(), userId: null, email: null, connectedAt: null, token: '' };
    persist();

    return { status: status(), revoked };
}

/** Refreshes the cached profile, and tells us whether the session still works. */
async function refresh() {
    const current = load();
    if (!current.token) return status();

    const result = await apiFetch('/api/v1/account', { token: current.token });

    if (result.status === 401) {
        activeSmk = null;
        state = { ...current, userId: null, email: null, connectedAt: null, token: '' };
        persist();
        throw new Error('This device was disconnected from the sync server');
    }

    if (!result.ok) throw new Error(apiError(result, 'Could not reach the sync server'));

    const data = result.payload;
    if (data) {
        state = { ...load(), userId: data.user_id ?? current.userId, email: data.email ?? current.email };
        persist();
    }

    return status();
}

/* ------------------------------------------------------------------ *
 * Recovery, from an already-authenticated session
 * ------------------------------------------------------------------ */

/**
 * Unlocks using the recovery code instead of the passphrase. Requires a
 * valid session already -- see this file's header comment on why a fully
 * logged-out recovery is not yet supported.
 *
 * The code that was just typed in has been seen and used, so it is rotated
 * to a fresh one on success, the same as at registration. A failure to
 * rotate does not undo the unlock; it just means the old code keeps working
 * too, which is the safe direction for that particular failure.
 */
async function unlockWithRecoveryCode(recoveryCode) {
    const current = load();
    if (!current.token) throw new Error('Not signed in');

    const keysResult = await apiFetch('/api/v1/sync/keys', { token: current.token });
    if (!keysResult.ok) throw new Error(apiError(keysResult, 'Could not fetch your account key'));

    const normalized = syncKeys.normalizeRecoveryCode(recoveryCode);
    const smk = syncKeys.unsealSmk(keysResult.payload?.wrapped_key_recovery, normalized);
    if (!smk) throw new Error('That recovery code did not unlock your data');

    activeSmk = smk;
    syncKeys.cacheSmk(smk);

    const rotated = syncKeys.rotateRecoveryCode(smk);
    const putResult = await apiFetch('/api/v1/sync/keys/recovery', {
        method: 'PUT',
        token: current.token,
        body: { envelope: rotated.recoveryEnvelope },
    });

    if (!putResult.ok) {
        console.error('Failed to rotate the recovery code after redemption:', apiError(putResult, ''));
        return { status: status(), recoveryCode: null };
    }

    return { status: status(), recoveryCode: rotated.recoveryCode };
}

/**
 * Changes the passphrase, which also changes the login password -- see this
 * file's header comment on why those move together. Requires the data to
 * already be unlocked, since re-sealing needs the key currently in memory.
 */
async function changePassphrase(currentPassphrase, newPassphrase) {
    const current = load();
    if (!current.token) throw new Error('Not signed in');

    const smk = getSyncKey();
    if (!smk) throw new Error('Unlock your synced data first');

    const passphraseEnvelope = syncKeys.reseal(smk, newPassphrase);

    const result = await apiFetch('/api/v1/account/password', {
        method: 'PUT',
        token: current.token,
        body: {
            current_login_password: currentPassphrase,
            new_login_password: newPassphrase,
            wrapped_key_passphrase: passphraseEnvelope,
        },
    });

    if (!result.ok) throw new Error(apiError(result, 'Could not change your passphrase'));

    return status();
}

/* ------------------------------------------------------------------ *
 * The synced setup snapshot
 * ------------------------------------------------------------------ */

/** Revision and size only, cheap enough to check on a timer. */
async function snapshotMeta() {
    const current = load();
    if (!current.token) throw new Error('Not signed in');

    const result = await apiFetch('/api/v1/sync/snapshot/meta', { token: current.token });
    if (!result.ok) throw new Error(apiError(result, 'Could not check your saved setup'));

    return result.payload || { exists: false, revision: 0 };
}

/** `{ payload, revision }`, or null when this account has never saved one. */
async function snapshotGet() {
    const current = load();
    if (!current.token) throw new Error('Not signed in');

    const result = await apiFetch('/api/v1/sync/snapshot', { token: current.token });

    if (result.status === 404) return null;
    if (!result.ok) throw new Error(apiError(result, 'Could not load your saved setup'));

    return result.payload;
}

/**
 * Store a blob, on the condition that `baseRevision` is still current.
 *
 * A conflict is returned rather than thrown: it is the expected outcome
 * when another device saved first, and the caller's job is to merge and
 * retry, not to treat it as a failure.
 */
async function snapshotPut({ payload, baseRevision, deviceName: device, stats }) {
    const current = load();
    if (!current.token) throw new Error('Not signed in');

    const result = await apiFetch('/api/v1/sync/snapshot', {
        method: 'POST',
        token: current.token,
        body: { payload, base_revision: baseRevision, device_name: device, stats },
    });

    if (result.status === 409) {
        return { conflict: true, revision: result.payload?.error?.revision ?? null };
    }

    if (!result.ok) throw new Error(apiError(result, 'Could not save your setup'));

    return { conflict: false, revision: result.payload?.revision ?? null };
}

/* ------------------------------------------------------------------ *
 * Reading the connection
 * ------------------------------------------------------------------ */

/** The unlocked Sync Master Key, or null if not yet unlocked. Never exposed over IPC. */
function getSyncKey() {
    if (activeSmk) return activeSmk;
    activeSmk = syncKeys.loadCachedSmk();
    return activeSmk;
}

function status() {
    const current = load();

    return {
        serverUrl: current.serverUrl,
        connected: Boolean(current.token),
        unlocked: Boolean(getSyncKey()),
        userId: current.userId,
        email: current.email,
        connectedAt: current.connectedAt,
        // The server holds the token, so a locked vault reads the same as
        // signed out unless the UI is told which it is.
        locked: vault.isLocked(),
    };
}

module.exports = {
    status,
    configure,
    register,
    login,
    logout,
    refresh,
    unlockWithRecoveryCode,
    changePassphrase,
    snapshotMeta,
    snapshotGet,
    snapshotPut,
    getSyncKey,
    deviceName,
};
