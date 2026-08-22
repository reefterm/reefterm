const { normalizeProxy, describeProxy, MAX_PROXY_HOPS } = require('../proxy-config');
const activity = require('../activity');
const core = require('./core');

/**
 * A proxy as the renderer may see it: normalised, and with the password replaced
 * by whether there is one. Normalised on the way out as well as in, so a record
 * written before a field existed still arrives complete at the editor.
 */
function redactProxy(proxy) {
    const { password, ...rest } = proxy;
    return { ...normalizeProxy(rest), hasPassword: Boolean(password) };
}

/* ------------------------------------------------------------------ *
 * Proxies
 *
 * A collection of its own rather than an address on each host, for the same
 * reason the keychain is not a private key per host: one proxy is usually the
 * route for everything, its credential belongs to it, and changing the port it
 * listens on should not be twenty edits.
 *
 * A host points at one by id. Nothing here reads a host, and the runtime never
 * reads this collection: it is handed a resolved chain by resolveCredentials.
 * ------------------------------------------------------------------ */

function getProxies() {
    return core.load().proxies.map(redactProxy);
}

function saveProxy(proxy) {
    const store = core.load();
    const id = proxy.id || `proxy-${Date.now()}`;
    const index = store.proxies.findIndex(entry => entry.id === id);
    const existing = index >= 0 ? store.proxies[index] : {};

    // Never trust the redaction flag coming back from the renderer.
    const { hasPassword: _hasPassword, ...incoming } = proxy;

    // Normalised before the secret is merged, so the record written is the same
    // shape the client will be handed whatever the editor sent.
    const record = core.mergeSecrets(
        normalizeProxy({ ...existing, ...incoming, id }),
        incoming,
        existing,
        core.PROXY_SECRET_FIELDS,
    );

    // A proxy cannot be reached through itself. Longer cycles are caught when
    // the chain is resolved, where the whole of it is visible; this one is
    // refused here because it is the one the editor can offer.
    if (record.viaProxyId === id) record.viaProxyId = '';

    if (index >= 0) store.proxies[index] = record;
    else store.proxies.push(record);

    core.persist();

    const changes = activity.diff(existing, record);
    if (index < 0 || changes.length > 0) {
        activity.record({
            category: 'data',
            action: index < 0 ? 'proxy.create' : 'proxy.update',
            target: record.name || describeProxy(record),
            subject: describeProxy(record),
            changes: index < 0 ? [] : changes,
        });
    }

    return redactProxy(record);
}

/**
 * Remove a proxy, and stop anything pointing at what is no longer there.
 *
 * Hosts left holding a dangling reference would refuse to connect rather than
 * connect directly (see resolveCredentials), which is the safe failure but a
 * confusing one. So the references are cleared here and the change is named in
 * the log: those hosts now dial straight out, which is a change to how they
 * reach the network that nobody asked for explicitly.
 */
function deleteProxy(proxyId) {
    const store = core.load();
    const removed = store.proxies.find(entry => entry.id === proxyId);
    if (!removed) return false;

    store.proxies = store.proxies.filter(entry => entry.id !== proxyId);

    const chained = store.proxies.filter(entry => entry.viaProxyId === proxyId);
    for (const entry of chained) entry.viaProxyId = '';

    const orphaned = store.hosts.filter(host => host.proxyId === proxyId);
    for (const host of orphaned) host.proxyId = '';

    core.persist();

    activity.record({
        category: 'data',
        action: 'proxy.delete',
        target: removed.name || describeProxy(removed),
        subject: describeProxy(removed),
        detail: [
            orphaned.length ? `${orphaned.length} host(s) now connect directly` : '',
            chained.length ? `${chained.length} proxy(s) are no longer chained through it` : '',
        ].filter(Boolean).join(' · '),
    });

    return true;
}

/**
 * Copy a proxy, password and all.
 *
 * Done here rather than by saving a copy from the renderer for the reason
 * duplicateHost is: the renderer has never seen the password, so a round trip
 * through it would produce a proxy that looks right and cannot authenticate.
 */
function duplicateProxy(proxyId) {
    const store = core.load();
    const source = store.proxies.find(entry => entry.id === proxyId);
    if (!source) return null;

    const record = {
        ...source,
        id: `proxy-${Date.now()}`,
        name: `${source.name || 'Proxy'} copy`,
    };

    store.proxies.push(record);
    core.persist();

    activity.record({
        category: 'data',
        action: 'proxy.create',
        target: record.name,
        subject: describeProxy(record),
        detail: `Duplicated from ${source.name || describeProxy(source)}`,
    });

    return redactProxy(record);
}

/**
 * Resolve every proxy a connection is relayed through, in the order they are
 * dialled: the first entry is reached from this machine, the last is the one
 * asked to reach the host.
 *
 * The links point the other way on the records, because `viaProxyId` says which
 * proxy *this* one is reached through, so the walk collects them innermost first
 * and reverses at the end. Same shape as resolveChain, for the same reason.
 *
 * Main process only, under the same rule as resolveCredentials: every entry
 * carries a decrypted password and must never cross IPC.
 */
function resolveProxyChain(proxyId) {
    const store = core.load();
    const fail = (error) => ({ chain: [], error });

    const chain = [];
    const seen = new Set();
    let currentId = String(proxyId || '').trim();

    while (currentId) {
        if (seen.has(currentId)) {
            return fail('A proxy in this route is reached through itself');
        }
        if (chain.length >= MAX_PROXY_HOPS) {
            return fail(`This connection is relayed through more than ${MAX_PROXY_HOPS} proxies`);
        }

        const record = store.proxies.find(entry => entry.id === currentId);
        if (!record) {
            return fail('A proxy this connection goes through no longer exists');
        }

        seen.add(currentId);

        const proxy = normalizeProxy(record);
        chain.push({ ...proxy, password: core.decryptSecret(record.password) });
        currentId = proxy.viaProxyId;
    }

    if (chain.length === 0) return fail('No proxy chosen');

    chain.reverse();
    return { chain, error: '' };
}

/**
 * The chain the Proxies page's check button should exercise.
 *
 * Two shapes, because the check has to work on a proxy that has not been saved:
 * an editor that can only test what is already stored is one that cannot help
 * you get the settings right in the first place.
 *
 *   { proxyId }   a saved record, resolved with everything it chains through
 *   { proxy }     a draft from the editor, appended to whatever its `viaProxyId`
 *                 resolves to. A blank password means "the one already stored",
 *                 which is the same rule a save follows, so testing an edit
 *                 without retyping the password works.
 */
function resolveTestChain({ proxyId, proxy } = {}) {
    if (proxyId) return resolveProxyChain(proxyId);
    if (!proxy) return { chain: [], error: 'Nothing to check' };

    const draft = normalizeProxy(proxy);

    let chain = [];
    if (draft.viaProxyId) {
        const resolved = resolveProxyChain(draft.viaProxyId);
        if (resolved.error) return resolved;
        chain = resolved.chain;
    }

    const stored = core.load().proxies.find(entry => entry.id === draft.id);
    const password = proxy.password || (stored ? core.decryptSecret(stored.password) : '');

    return { chain: [...chain, { ...draft, password }], error: '' };
}

module.exports = {
    getProxies,
    saveProxy,
    deleteProxy,
    duplicateProxy,
    resolveProxyChain,
    resolveTestChain,
};
