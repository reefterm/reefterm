const activity = require('../activity');
const core = require('./core');

function redactKey(key) {
    const { privateKey, passphrase, ...rest } = key;
    return {
        ...rest,
        hasPrivateKey: Boolean(privateKey),
        hasPassphrase: Boolean(passphrase),
    };
}

/* ------------------------------------------------------------------ *
 * Keychain
 * ------------------------------------------------------------------ */

function getKeys() {
    return core.load().keys.map(redactKey);
}

function saveKey(key) {
    const store = core.load();
    const id = key.id || `key-${Date.now()}`;
    const index = store.keys.findIndex(k => k.id === id);
    const existing = index >= 0 ? store.keys[index] : {};

    // `type` stays the key algorithm (ED25519/RSA/...); records are separated
    // by collection now, so nothing needs a discriminator tag.
    const { hasPrivateKey, hasPassphrase, ...incoming } = key;
    const record = core.mergeSecrets({ ...existing, ...incoming, id }, incoming, existing);

    if (index >= 0) store.keys[index] = record;
    else store.keys.push(record);

    core.persist();

    const changes = activity.diff(existing, record);
    if (index < 0 || changes.length > 0) {
        activity.record({
            category: 'security',
            action: index < 0 ? 'key.create' : 'key.update',
            target: record.name || id,
            detail: record.type || '',
            changes: index < 0 ? [] : changes,
        });
    }

    return redactKey(record);
}

function deleteKey(keyId) {
    const store = core.load();
    const removed = store.keys.find(k => k.id === keyId);
    store.keys = store.keys.filter(k => k.id !== keyId);
    core.persist();

    if (removed) {
        activity.record({
            category: 'security',
            action: 'key.delete',
            target: removed.name || keyId,
            detail: removed.type || '',
        });
    }

    return true;
}

module.exports = {
    redactKey,
    getKeys,
    saveKey,
    deleteKey,
};
