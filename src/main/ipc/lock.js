const store = require('../store');
const vault = require('../vault');
const transport = require('../transport');
const knownHosts = require('../known-hosts');
const activity = require('../activity');

/**
 * Record one lock event. A refused unlock is the entry that earns this its
 * place: a run of them is the only sign this file ever gives that someone
 * sat down in front of a locked app and started guessing.
 */
function logLock(action, result, detail = '') {
    activity.record({
        category: 'security',
        action,
        outcome: result?.success ? 'info' : 'failure',
        target: 'App lock',
        detail,
        message: result?.success ? '' : (result?.message || ''),
    });
    return result;
}

/** Untrusting a key means the next connection will ask again; worth a line. */
function logForget(target, detail, removed) {
    if (removed) {
        activity.record({
            category: 'security',
            action: 'hostkey.forget',
            outcome: 'info',
            target,
            detail,
        });
    }
    return removed;
}

function register({ handle, notify }) {
    handle('store-status', () => ({
        encryptionAvailable: store.isEncryptionAvailable(),
        protection: vault.status().protection,
        keystoreAvailable: vault.keystoreAvailable(),
    }));

    /* ---------------- App lock ---------------- */

    handle('app-lock-status', () => vault.status());

    handle('app-lock-unlock', (event, password) =>
        logLock('lock.unlock', vault.unlock(password)));
    handle('app-lock-set', (event, password) =>
        logLock('lock.enable', vault.set(password), 'An opening password is now required'));
    handle('app-lock-change', (event, { current, next }) =>
        logLock('lock.change', vault.change(current, next)));
    handle('app-lock-disable', (event, password) =>
        logLock('lock.disable', vault.disable(password), 'Stored secrets are no longer behind a password'));

    // Locking drops every live session first. Leaving them up would keep the
    // shells the password is meant to be guarding attached and running. The
    // ad-hoc records go with them: they hold a login in memory, which is the
    // one secret locking the app would otherwise leave sitting where it was.
    handle('app-lock-lock', () => {
        const result = vault.lock();
        if (result.success) {
            transport.destroyAll();
            store.forgetQuickConnects();
            notify('app-locked', {});
        }
        return logLock('lock.lock', result);
    });

    /* ---------------- Host keys ---------------- */

    handle('known-hosts-list', () => knownHosts.list());

    handle('known-hosts-forget', (event, { host, port }) =>
        logForget(`${host}:${port || 22}`, 'All trusted keys removed', knownHosts.forget(host, port)));
    handle('known-hosts-forget-id', (event, id) =>
        logForget(id, 'All trusted keys removed', knownHosts.forgetById(id)));
    handle('known-hosts-forget-key', (event, { id, fingerprint }) =>
        logForget(id, `Key ${fingerprint} removed`, knownHosts.forgetFingerprint(id, fingerprint)));
}

module.exports = { register };
