const { app, powerMonitor } = require('electron');
const fs = require('fs');
const path = require('path');
const store = require('./store');
const knownHosts = require('./known-hosts');
const syncConnection = require('./sync-connection');
const backup = require('./backup');
const vault = require('./vault');
const activity = require('./activity');

/**
 * The setup snapshot: this machine's saved hosts, folders, keys, snippets,
 * proxies, known hosts and terminal settings, encrypted and kept on a
 * self-hosted sync server so connecting elsewhere reproduces it.
 *
 * The blob is encrypted on this machine with AES-256-GCM, under the Sync
 * Master Key (see sync-keys.js) -- a key this machine derives locally and
 * that the server never sees in any form. That is the whole point of a
 * self-hosted instance: the operator, even if it is someone else's server
 * you don't otherwise trust, cannot read what it stores.
 */

const SCHEMA_VERSION = 1;

const statePath = () => path.join(app.getPath('userData'), 'cloud-snapshot.json');

// Long enough that a burst of edits is one upload, short enough that closing
// the app right after a change usually still catches it.
const PUSH_DEBOUNCE_MS = 8000;

// Backstop for the pull side. Changes made on another device arrive within this
// even if nothing local happens to trigger a check.
const POLL_INTERVAL_MS = 5 * 60 * 1000;

let state = null;
let pushTimer = null;
let pollTimer = null;
let busy = false;
let notify = () => {};

// Terminal settings live in the renderer's localStorage, so main cannot read
// them. The renderer hands them over whenever they change and they are cached
// here for the next push.
let rendererSettings = null;

/* ------------------------------------------------------------------ *
 * Local bookkeeping
 * ------------------------------------------------------------------ */

function load() {
    if (state) return state;

    try {
        const raw = JSON.parse(fs.readFileSync(statePath(), 'utf8'));
        state = {
            enabled: raw.enabled !== false,
            revision: Number(raw.revision) || 0,
            lastPushAt: raw.lastPushAt || null,
            lastPullAt: raw.lastPullAt || null,
            lastError: raw.lastError || null,
        };
    } catch {
        state = { enabled: true, revision: 0, lastPushAt: null, lastPullAt: null, lastError: null };
    }

    return state;
}

function persist() {
    try {
        const current = load();
        fs.writeFileSync(statePath(), JSON.stringify({
            enabled: current.enabled,
            revision: current.revision,
            lastPushAt: current.lastPushAt,
            lastPullAt: current.lastPullAt,
            lastError: current.lastError,
        }, null, 2), { mode: 0o600 });
    } catch (error) {
        console.error('Failed to save snapshot state:', error.message);
    }
}

vault.onUnlocked(() => { state = null; });

/* ------------------------------------------------------------------ *
 * What goes in
 * ------------------------------------------------------------------ */

/**
 * Counts, sent in the clear alongside the ciphertext.
 *
 * This is what lets an operator confirm the feature is working -- that a device
 * is saving, and roughly how much -- without anyone decrypting a snapshot to
 * find out. Deliberately only numbers: no host name, address, username or
 * anything else that would describe a customer's infrastructure.
 */
function describe(payload) {
    return {
        hosts: payload.hosts.length,
        folders: payload.folders.length,
        keys: payload.keys.length,
        snippets: payload.snippets.length,
        proxies: payload.proxies.length,
        known_hosts: Object.keys(payload.knownHosts || {}).length,
        has_settings: Boolean(payload.settings),
        app_version: app.getVersion(),
        platform: process.platform,
    };
}

function collect() {
    const everything = store.exportAll();

    return {
        version: SCHEMA_VERSION,
        capturedAt: new Date().toISOString(),
        hosts: everything.hosts,
        folders: everything.folders,
        keys: everything.keys,
        snippets: everything.snippets,
        proxies: everything.proxies,
        knownHosts: knownHosts.exportAll(),
        settings: rendererSettings || null,
    };
}

/**
 * Fold a downloaded snapshot into this machine.
 *
 * Additive: `overwrite` is false, so a record this machine already has wins.
 * That makes a pull safe to run on launch without a prompt -- the worst it can
 * do is add something, never quietly rewrite a host that works. Two devices
 * editing the same host is the case this does not resolve, and the revision
 * guard on push is what stops that going unnoticed.
 */
function apply(payload) {
    const summary = store.importAll({
        hosts: Array.isArray(payload?.hosts) ? payload.hosts : [],
        folders: Array.isArray(payload?.folders) ? payload.folders : [],
        keys: payload?.keys,
        snippets: payload?.snippets,
        proxies: payload?.proxies,
    }, { overwrite: false });

    if (payload?.knownHosts) knownHosts.importAll(payload.knownHosts, { overwrite: false });

    // Handed to the renderer rather than applied here; localStorage is its own.
    if (payload?.settings) notify('cloud-snapshot-settings', payload.settings);

    return summary;
}

/* ------------------------------------------------------------------ *
 * Key
 * ------------------------------------------------------------------ */

/**
 * The Sync Master Key, already unlocked -- never fetched from the server,
 * which never holds it in any usable form. If this throws, the fix is to
 * unlock (passphrase or recovery code), not to retry the network.
 */
async function ensureKey() {
    const key = syncConnection.getSyncKey();
    if (!key) throw new Error('Unlock your synced data first');
    return key;
}

/* ------------------------------------------------------------------ *
 * Push and pull
 * ------------------------------------------------------------------ */

/** Why a sync cannot run right now, or '' when it can. */
function blocked() {
    if (!load().enabled) return 'Syncing your setup is turned off';

    const connection = syncConnection.status();
    if (!connection.connected) return 'Not connected to a sync server';
    if (!connection.unlocked) return 'Your synced data is locked';

    // exportAll and importAll both refuse while locked, and a snapshot written
    // with the secrets missing would be worse than no snapshot at all.
    if (vault.isLocked()) return 'The app is locked';
    return '';
}

async function pull({ force = false } = {}) {
    const stop = blocked();
    if (stop) return { skipped: stop };
    if (busy) return { skipped: 'A sync is already running' };

    busy = true;

    try {
        return await pullLocked({ force });
    } finally {
        busy = false;
    }
}

/** The pull itself. Assumes the caller already holds `busy`. */
async function pullLocked({ force = false } = {}) {
    try {
        const meta = await syncConnection.snapshotMeta();
        const current = load();

        if (!meta.exists) return { pulled: false, reason: 'Nothing saved yet' };

        if (!force && meta.revision <= current.revision) {
            return { pulled: false, reason: 'Already up to date', revision: current.revision };
        }

        const remote = await syncConnection.snapshotGet();

        if (!remote?.payload) return { pulled: false, reason: 'Nothing saved yet' };

        const key = await ensureKey();

        // Unlike the old CloudBlast console, this server stores payload as
        // real JSON rather than an opaque string, so what comes back is
        // already the envelope object sealWithKey() produced -- no parse
        // step needed to get back to where push() left off.
        const payload = backup.unsealWithKey(remote.payload, key);

        // A null here means the key does not open the blob. Not fatal and not
        // silently ignorable either: it usually means the Sync Master Key was
        // replaced (a passphrase reset elsewhere, say), and pushing over it
        // would destroy whatever is up there.
        if (!payload) {
            throw new Error('Your saved setup could not be decrypted with this device\'s key');
        }

        const summary = apply(payload);

        state = {
            ...load(),
            revision: remote.revision,
            lastPullAt: new Date().toISOString(),
            lastError: null,
        };
        persist();

        const added = (summary?.hosts?.added || 0) + (summary?.keys?.added || 0)
            + (summary?.snippets?.added || 0) + (summary?.folders?.added || 0)
            + (summary?.proxies?.added || 0);

        if (added > 0) {
            activity.record({
                category: 'data',
                action: 'sync.restore',
                outcome: 'success',
                target: 'synced setup',
                detail: `${summary.hosts?.added || 0} host(s), ${summary.keys?.added || 0} key(s) restored`,
            });
        }

        notify('cloud-snapshot-state', { ...status(), pulled: true, added });

        return { pulled: true, revision: remote.revision, added, summary };
    } catch (error) {
        state = { ...load(), lastError: error.message };
        persist();
        notify('cloud-snapshot-state', { ...status(), error: error.message });
        return { error: error.message };
    }
}

async function push() {
    const stop = blocked();
    if (stop) return { skipped: stop };
    if (busy) return { skipped: 'A sync is already running' };

    busy = true;

    try {
        return await pushLocked({ retry: true });
    } catch (error) {
        state = { ...load(), lastError: error.message };
        persist();
        notify('cloud-snapshot-state', { ...status(), error: error.message });
        return { error: error.message };
    } finally {
        busy = false;
    }
}

/**
 * The push itself. Assumes the caller already holds `busy`.
 *
 * On a conflict it merges what the other device wrote and tries once more. Only
 * once: a second conflict means something is pushing continuously, and retrying
 * again would keep losing the same race while holding the lock.
 */
async function pushLocked({ retry }) {
    const key = await ensureKey();
    const payload = collect();

    const result = await syncConnection.snapshotPut({
        payload: backup.sealWithKey(payload, key),
        baseRevision: load().revision,
        deviceName: syncConnection.deviceName(),
        stats: describe(payload),
    });

    if (result.conflict) {
        if (!retry) return { conflict: true };

        await pullLocked({ force: true });

        return pushLocked({ retry: false });
    }

    state = {
        ...load(),
        revision: result.revision ?? load().revision + 1,
        lastPushAt: new Date().toISOString(),
        lastError: null,
    };
    persist();

    notify('cloud-snapshot-state', status());

    return { pushed: true, revision: state.revision };
}

/* ------------------------------------------------------------------ *
 * Triggers
 * ------------------------------------------------------------------ */

/**
 * Something local changed. Debounced, because editing a host fires several of
 * these and each one would otherwise be an upload of the whole setup.
 */
function schedulePush() {
    if (blocked()) return;

    if (pushTimer) clearTimeout(pushTimer);
    pushTimer = setTimeout(() => { pushTimer = null; push(); }, PUSH_DEBOUNCE_MS);
    pushTimer.unref?.();
}

/** Terminal settings, handed over by the renderer when they change. */
function setSettings(settings) {
    const next = JSON.stringify(settings ?? null);
    if (next === JSON.stringify(rendererSettings ?? null)) return;

    rendererSettings = settings ?? null;
    schedulePush();
}

function status() {
    const current = load();

    return {
        enabled: current.enabled,
        revision: current.revision,
        lastPushAt: current.lastPushAt,
        lastPullAt: current.lastPullAt,
        lastError: current.lastError,
        pending: Boolean(pushTimer),
        blocked: blocked(),
    };
}

/**
 * Forget everything tied to the connection that was just disconnected.
 *
 * The revision belongs to one server connection, not to this machine. Left
 * behind after disconnecting, it would make the next connection's snapshot
 * look older than what this device has already seen, and the pull that
 * should restore it would decide there was nothing to do.
 *
 * The preference itself survives: whether the user wants sync on is about
 * them, not about which server they were last connected to.
 */
function reset() {
    if (pushTimer) clearTimeout(pushTimer);
    pushTimer = null;

    state = {
        enabled: load().enabled,
        revision: 0,
        lastPushAt: null,
        lastPullAt: null,
        lastError: null,
    };
    persist();

    return status();
}

function setEnabled(enabled) {
    state = { ...load(), enabled: Boolean(enabled) };
    persist();

    if (state.enabled) {
        startPolling();
        pull().then(() => push());
    } else {
        stopPolling();
        if (pushTimer) clearTimeout(pushTimer);
        pushTimer = null;
    }

    return status();
}

function startPolling() {
    stopPolling();
    pollTimer = setInterval(() => { pull(); }, POLL_INTERVAL_MS);
    pollTimer.unref?.();
}

function stopPolling() {
    if (pollTimer) clearInterval(pollTimer);
    pollTimer = null;
}

function start(notifier) {
    if (typeof notifier === 'function') notify = notifier;

    store.onChanged?.(schedulePush);
    knownHosts.onChanged?.(schedulePush);

    powerMonitor.on('resume', () => { if (!blocked()) pull(); });
    vault.onUnlocked(() => { if (!blocked()) pull(); });

    if (load().enabled) {
        startPolling();
        pull();
    }
}

/**
 * Flush a pending upload before the app exits, so quitting right after an edit
 * does not lose it. Best effort: the process is going away regardless.
 */
function flush() {
    if (!pushTimer) return null;

    clearTimeout(pushTimer);
    pushTimer = null;

    return push();
}

module.exports = {
    status,
    setEnabled,
    reset,
    push,
    pull,
    schedulePush,
    setSettings,
    start,
    flush,
    collect,
};
