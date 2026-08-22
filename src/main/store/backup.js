const { normalizeTunnels } = require('../tunnel-config');
const { normalizeSnippet, normalizeSnippets } = require('../snippet-config');
const { normalizeDesktop } = require('../desktop-config');
const { normalizeBmc } = require('../bmc-config');
const { normalizeMonitor } = require('../monitor-config');
const { normalizeProxy } = require('../proxy-config');
const { normalizeTags } = require('../host-tags');
const vault = require('../vault');
const core = require('./core');

/* ------------------------------------------------------------------ *
 * Backup
 * ------------------------------------------------------------------ */

/**
 * Everything worth backing up, with secrets in the clear.
 *
 * Main process only, under the same rule as resolveCredentials: the return
 * value must never cross IPC. It exists so backup.js can re-encrypt under a
 * passphrase the user chose, which is what makes the file portable: the vault
 * key is wrapped by this machine's keystore and means nothing anywhere else.
 *
 * Throws when locked rather than exporting blanks: a backup full of empty
 * passwords would look like a backup and restore as a broken setup.
 */
function exportAll() {
    if (vault.isLocked()) throw new Error('Unlock the app before exporting a backup');

    const store = core.load();
    const withSecrets = (record) => {
        const copy = { ...record };
        for (const field of core.SECRET_FIELDS) {
            copy[field] = record[field] ? core.decryptSecret(record[field]) : '';
        }
        return copy;
    };

    return {
        hosts: store.hosts.map(withSecrets),
        folders: store.folders.map(folder => ({ ...folder })),
        keys: store.keys.map(withSecrets),
        snippets: normalizeSnippets(store.snippets),
        // A host that connects through a proxy is not restorable without the
        // proxy, so the collection travels with the rest of the setup. Written
        // out field by field rather than through `withSecrets`, because
        // normalising drops the stored ciphertext that call would read.
        proxies: store.proxies.map(record => ({
            ...normalizeProxy(record),
            password: record.password ? core.decryptSecret(record.password) : '',
        })),
    };
}

/**
 * Upsert by id. Records already present are skipped unless `overwrite`, so
 * restoring onto a machine that already has hosts is additive by default and
 * cannot quietly undo local edits.
 */
function mergeCollection(existing, incoming, { overwrite, prepare }) {
    const result = { added: 0, replaced: 0, skipped: 0 };

    for (const raw of Array.isArray(incoming) ? incoming : []) {
        let record;
        try {
            record = prepare(raw);
        } catch (error) {
            console.error('Skipping an unreadable backup record:', error.message);
            result.skipped++;
            continue;
        }
        if (!record?.id) {
            result.skipped++;
            continue;
        }

        const index = existing.findIndex(entry => entry.id === record.id);
        if (index < 0) {
            existing.push(record);
            result.added++;
        } else if (overwrite) {
            existing[index] = record;
            result.replaced++;
        } else {
            result.skipped++;
        }
    }

    return result;
}

/**
 * Bring a decrypted backup payload into the store, encrypting its secrets under
 * the local vault key on the way in.
 *
 * Secrets are encrypted explicitly here rather than through mergeSecrets, whose
 * "does this already look like ciphertext" heuristic is right for a record
 * round-tripping through the renderer and wrong for a restore: a password that
 * genuinely began with `v2:` would be stored unencrypted.
 */
function importAll(payload, { overwrite = false } = {}) {
    if (vault.isLocked()) throw new Error('Unlock the app before restoring a backup');

    const store = core.load();

    const prepareSecrets = (raw, fields = core.SECRET_FIELDS) => {
        const { hasPassword: _hasPassword, hasPrivateKey: _hasPrivateKey, hasPassphrase: _hasPassphrase, hasVncPassword: _hasVncPassword, ...rest } = raw || {};
        const record = { ...rest };
        for (const field of fields) {
            record[field] = raw?.[field] ? core.encryptSecret(raw[field]) : '';
        }
        return record;
    };

    const summary = {
        hosts: mergeCollection(store.hosts, payload?.hosts, {
            overwrite,
            prepare: (raw) => {
                const record = prepareSecrets(raw);
                // Same normalisation a saved host gets: these drive real
                // listening sockets and must not reach the runtime malformed.
                if (record.tunnels !== undefined) record.tunnels = normalizeTunnels(record.tunnels);
                if (record.desktop !== undefined) record.desktop = normalizeDesktop(record.desktop);
                if (record.bmc !== undefined) record.bmc = normalizeBmc(record.bmc);
                if (record.monitor !== undefined) record.monitor = normalizeMonitor(record.monitor);
                // A backup is a file a person can edit, so the tag list arrives
                // as untrusted as one from the editor does.
                if (record.tags !== undefined) record.tags = normalizeTags(record.tags);
                return record;
            },
        }),
        folders: mergeCollection(store.folders, payload?.folders, {
            overwrite,
            prepare: (raw) => ({ ...raw }),
        }),
        keys: mergeCollection(store.keys, payload?.keys, {
            overwrite,
            prepare: prepareSecrets,
        }),
        snippets: mergeCollection(store.snippets, payload?.snippets, {
            overwrite,
            prepare: normalizeSnippet,
        }),
        // Normalised on the way in like the tunnel and desktop blocks are, and
        // for the same reason: a backup is a file a person can edit, and these
        // records decide where a socket is opened.
        proxies: mergeCollection(store.proxies, payload?.proxies, {
            overwrite,
            prepare: (raw) => {
                const record = prepareSecrets(raw, core.PROXY_SECRET_FIELDS);
                return { ...normalizeProxy(record), password: record.password };
            },
        }),
    };

    core.persist();
    return summary;
}

/** How a payload would land, without changing anything. */
function previewImport(payload) {
    const store = core.load();
    const count = (incoming, existing) => {
        const ids = new Set(existing.map(entry => entry.id));
        let fresh = 0;
        let conflicting = 0;
        for (const record of Array.isArray(incoming) ? incoming : []) {
            if (record?.id && ids.has(record.id)) conflicting++;
            else fresh++;
        }
        return { total: fresh + conflicting, new: fresh, existing: conflicting };
    };

    return {
        hosts: count(payload?.hosts, store.hosts),
        folders: count(payload?.folders, store.folders),
        keys: count(payload?.keys, store.keys),
        snippets: count(payload?.snippets, store.snippets),
        proxies: count(payload?.proxies, store.proxies),
    };
}

module.exports = {
    exportAll,
    importAll,
    previewImport,
};
