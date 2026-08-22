const { normalizeTunnels } = require('../tunnel-config');
const { normalizeDesktop } = require('../desktop-config');
const { normalizeBmc } = require('../bmc-config');
const { normalizeMonitor } = require('../monitor-config');
const { normalizeTags, applyTagEdit, sameTags } = require('../host-tags');
const { normalizeProtocol, normalizeSerial, defaultPort } = require('../protocol-config');
const activity = require('../activity');
const core = require('./core');
const { resolveProxyChain } = require('./proxies');

/** Strip secrets before anything crosses the IPC boundary. */
function redactHost(host) {
    const { password, privateKey, passphrase: _passphrase, vncPassword, rdpPassword, bmcPassword, ...rest } = host;
    return {
        ...rest,
        hasPassword: Boolean(password),
        hasPrivateKey: Boolean(privateKey),
        hasVncPassword: Boolean(vncPassword),
        hasRdpPassword: Boolean(rdpPassword),
        hasBmcPassword: Boolean(bmcPassword),
    };
}

/** Enough to name a host in a log line, with no secret and no full record. */
function describeHost(hostId) {
    const host = findHost(hostId);
    if (!host) return { id: hostId, name: '', address: '' };
    return {
        id: hostId,
        name: host.name || host.host || hostId,
        address: core.describeAddress(host),
    };
}

/* ------------------------------------------------------------------ *
 * Hosts
 * ------------------------------------------------------------------ */

function getHosts() {
    return core.load().hosts.map(redactHost);
}

function saveHost(host) {
    // An address dialled from a picker is not a saved record and must never
    // become one by the back door. The renderer already knows not to save it
    // back, but the call that would is the ordinary "remember when this was
    // last reached" after a successful dial, and that one is easy to reach by
    // accident. See openQuickConnect.
    if (isQuickConnectId(host?.id)) {
        const record = quickConnects.get(host.id);
        return record ? redactHost(record) : null;
    }

    const store = core.load();
    const id = host.id || `host-${Date.now()}`;
    const index = store.hosts.findIndex(h => h.id === id);
    const existing = index >= 0 ? store.hosts[index] : {};

    // Never trust redaction flags coming back from the renderer.
    const { hasPassword: _hasPassword, hasPrivateKey: _hasPrivateKey, hasVncPassword: _hasVncPassword, hasRdpPassword: _hasRdpPassword, hasBmcPassword: _hasBmcPassword, ...incoming } = host;
    const record = core.mergeSecrets({ ...existing, ...incoming, id }, incoming, existing);

    // Tunnels carry no secrets, but they do come from the renderer and drive
    // real listening sockets. Normalise so a malformed record can never reach
    // the forwarding runtime.
    if (record.tunnels !== undefined) record.tunnels = normalizeTunnels(record.tunnels);

    // Same reasoning: the desktop block decides what address the VNC bridge
    // dials, so it is normalised before it is ever stored rather than trusted
    // at the point it is used.
    if (record.desktop !== undefined) record.desktop = normalizeDesktop(record.desktop);

    // And for the BMC block, which decides what URL a pane loads and, through
    // `trustedCert`, which certificate it will accept without asking. A
    // fingerprint arriving as anything other than a trimmed string is a trust
    // decision made by malformed data, so it is normalised before it is stored.
    if (record.bmc !== undefined) record.bmc = normalizeBmc(record.bmc);

    // And again for the monitor block, which decides what address a background
    // timer opens a connection to every minute. A port arriving as a string, or
    // as 0, would be a socket dialled at nothing on a schedule.
    if (record.monitor !== undefined) record.monitor = normalizeMonitor(record.monitor);

    // Tags drive nothing but the user's own filing, so this is not a guard on
    // the runtime the way the two above are. It is a guard on the tag list
    // itself: it arrives as free text from a chip field, and every page that
    // shows tags assumes "prod" is one tag rather than three spellings of it.
    if (record.tags !== undefined) record.tags = normalizeTags(record.tags);

    // Which transport this host connects over, and the settings that one needs.
    // Normalised on the way in for the same reason as the two above: the serial
    // block is handed more or less straight to a driver, so a malformed record
    // must not be able to reach it.
    //
    // A record saved before this existed has no `protocol` and normalises to
    // `ssh`, which is what it was.
    record.protocol = normalizeProtocol(record.protocol);
    if (record.serial !== undefined || record.protocol === 'serial') {
        record.serial = normalizeSerial(record.serial);
    }

    // The bastion this host is reached through, held as a reference to another
    // saved host rather than an address, so the hop is dialled with its own
    // credentials and its own host-key trust. See resolveChain.
    //
    // A host cannot be its own bastion. Longer cycles are caught at connect
    // time, where the whole chain is visible; this one is refused here because
    // it is the one the editor is capable of offering.
    if (record.jumpHostId !== undefined) {
        record.jumpHostId = String(record.jumpHostId ?? '').trim();
        if (record.jumpHostId === id) record.jumpHostId = '';
    }

    // The proxy this host is dialled through, held as a reference to a saved
    // proxy for the same reason a jump host is: the credential belongs to the
    // proxy, not to every host that happens to be reached through it.
    //
    // A serial host cannot use one. There is no socket to proxy, and leaving a
    // stale reference on the record would show a route in the editor that
    // nothing would ever take.
    if (record.proxyId !== undefined) {
        record.proxyId = String(record.proxyId ?? '').trim();
    }
    if (record.protocol === 'serial') record.proxyId = '';

    // Same tidy-up for the monitor, and it has to happen after the two fields
    // above are settled because it is decided by them. A serial console has no
    // socket to check, and a host reached through a bastion has no route from
    // this machine at all, so a check from here would report a perfectly
    // healthy host offline every minute. Cleared rather than left set: a switch
    // that reads as on while nothing ever acts on it is worse than one that
    // went off when its reason did.
    if (record.monitor?.enabled && (record.protocol === 'serial' || record.jumpHostId)) {
        record.monitor = { ...record.monitor, enabled: false };
    }

    // Written into the shell on every connect, so it is stored in the exact
    // form it will be sent: CRLF normalised, trailing blank lines dropped. The
    // newline that actually runs it is added at send time rather than stored,
    // so a record that lost its last line cannot silently stop working.
    if (record.initCommand !== undefined) {
        record.initCommand = String(record.initCommand ?? '')
            .replace(/\r\n/g, '\n')
            .replace(/\s+$/, '');
    }

    if (index >= 0) store.hosts[index] = record;
    else store.hosts.push(record);

    core.persist();

    // Logged from here rather than the IPC layer because this is the only place
    // that holds both sides of the edit. A save whose only difference is
    // bookkeeping (the connect timestamp, a detected OS) records nothing:
    // those are written on every dial and would bury the real edits.
    const changes = activity.diff(existing, record);
    if (index < 0 || changes.length > 0) {
        activity.record({
            category: 'data',
            action: index < 0 ? 'host.create' : 'host.update',
            target: record.name || record.host || id,
            subject: core.describeAddress(record),
            hostId: id,
            hostName: record.name || '',
            // A new record has no "before", so every field would read as a
            // change. Only an edit gets a diff.
            changes: index < 0 ? [] : changes,
        });
    }

    return redactHost(record);
}

function deleteHost(hostId) {
    const store = core.load();
    const removed = store.hosts.find(h => h.id === hostId);
    store.hosts = store.hosts.filter(h => h.id !== hostId);

    // Anything relayed through the host that just went has to stop pointing at
    // it. Left dangling it would still look connectable in the list and fail on
    // the dial, naming a bastion that no longer exists to be looked at.
    const orphaned = store.hosts.filter(h => h.jumpHostId === hostId);
    for (const host of orphaned) host.jumpHostId = '';

    core.persist();

    if (removed) {
        activity.record({
            category: 'data',
            action: 'host.delete',
            target: removed.name || removed.host || hostId,
            subject: core.describeAddress(removed),
            hostId,
            hostName: removed.name || '',
            // Worth a line: those hosts now connect directly, which is a change
            // to how they reach the network that nobody asked for explicitly.
            detail: orphaned.length
                ? `${orphaned.length} host(s) are no longer relayed through it`
                : '',
        });
    }

    return true;
}

/**
 * Copy a host, credentials and all.
 *
 * Done here rather than by saving a copy from the renderer, because the
 * renderer has never seen the secrets: a round trip through it would produce a
 * host that looks right and cannot log in. The stored ciphertext is copied
 * as-is, so nothing has to be decrypted to make the copy and a locked vault is
 * no obstacle.
 *
 * The copy deliberately does not inherit "last connected": it has not been.
 */
function duplicateHost(hostId) {
    const store = core.load();
    const source = store.hosts.find(h => h.id === hostId);
    if (!source) return null;

    const { lastConnectedAt: _lastConnectedAt, ...rest } = source;
    const record = {
        ...rest,
        id: `host-${Date.now()}`,
        name: `${source.name || 'Host'} copy`,
    };

    // Lands immediately after its original in a manual arrangement, rather than
    // at the end of a list the user has just finished ordering. The next drop
    // in that folder renumbers everything to whole positions again.
    if (Number.isFinite(source.order)) record.order = source.order + 0.5;

    store.hosts.push(record);
    core.persist();

    activity.record({
        category: 'data',
        action: 'host.create',
        target: record.name,
        subject: core.describeAddress(record),
        hostId: record.id,
        hostName: record.name,
        detail: `Duplicated from ${source.name || source.host || hostId}`,
    });

    return redactHost(record);
}

/**
 * Add and remove tags across a set of hosts in one write.
 *
 * Its own path rather than a `saveHost` per record, for the same reason
 * arranging has one: tagging is something you do to a selection, and a dozen
 * saves would be a dozen writes, a dozen log lines, and a dozen chances to
 * leave the set half-tagged if one of them threw.
 *
 * Only `tags` is read from the payload. Nothing else on the incoming ids can
 * reach a record, so this cannot carry a rename or a credential the way a full
 * save could. It is the same rule `arrangeItems` follows, and for the same
 * reason: it accepts a list straight from the renderer.
 *
 * A host whose tags the edit would not change is left untouched, so re-applying
 * a tag that is already there is not an edit and does not say it was one.
 */
function tagHosts({ hostIds = [], add = [], remove = [] } = {}) {
    const adding = normalizeTags(add);
    const removing = normalizeTags(remove);
    if (adding.length === 0 && removing.length === 0) return { changed: 0, hostIds: [] };

    const store = core.load();
    const wanted = new Set(Array.isArray(hostIds) ? hostIds : []);
    const touched = [];

    for (const host of store.hosts) {
        if (!wanted.has(host.id)) continue;

        const before = normalizeTags(host.tags);
        const after = applyTagEdit(before, { add: adding, remove: removing });
        if (sameTags(before, after)) continue;

        host.tags = after;
        touched.push(host);
    }

    if (touched.length === 0) return { changed: 0, hostIds: [] };

    core.persist();

    // One line for the whole edit rather than one per host. The detail names
    // the tags rather than counting them, because "Added prod" is the thing
    // worth reading back and there is never enough of it to fill a row.
    const detail = [
        adding.length > 0 && `Added ${adding.join(', ')}`,
        removing.length > 0 && `Removed ${removing.join(', ')}`,
    ].filter(Boolean).join(' · ');

    const single = touched.length === 1 ? touched[0] : null;

    activity.record({
        category: 'data',
        action: 'host.tag',
        target: single
            ? (single.name || single.host || single.id)
            : `${touched.length} hosts`,
        detail,
        // Only when there is one host to point at: a log row that links to a
        // host has to mean that host, not the first of twelve.
        ...(single ? { hostId: single.id, hostName: single.name || '', subject: core.describeAddress(single) } : {}),
    });

    return { changed: touched.length, hostIds: touched.map(host => host.id) };
}

/* ------------------------------------------------------------------ *
 * Quick connect
 * ------------------------------------------------------------------ */

/**
 * An address typed into a picker, held as a host record for as long as the app
 * is running and no longer.
 *
 * Everything downstream of the launcher works by host id: the dispatcher reads
 * the protocol by id, the connection layer resolves a chain by id, the pane
 * asks for a session by id. So an ad-hoc address becomes a record like any
 * other, and none of that has to learn a second way of being told where to go.
 * What makes it ad-hoc is only where it lives: in this map, never in `hosts`,
 * so it is not saved, not listed, not exported and not backed up.
 *
 * The login goes on the record once the user has typed it, which is what makes
 * a dropped session reconnect without stopping to ask again. It is in memory
 * and in the clear, because there is nothing on disk for it to be encrypted
 * against; it goes when the app locks, and when the app closes.
 */
const QUICK_PREFIX = 'quick-';

const quickConnects = new Map();
let quickCounter = 0;

function isQuickConnectId(hostId) {
    return String(hostId || '').startsWith(QUICK_PREFIX);
}

/**
 * The record behind an id, wherever it lives.
 *
 * Only the lookups the connection path actually goes through use this. A quick
 * connect has no folder, no tunnels and no desktop settings, so the readers for
 * those find nothing and answer with their empty case, which is the right
 * answer rather than a gap.
 */
function findHost(hostId) {
    return quickConnects.get(hostId) || core.load().hosts.find(h => h.id === hostId) || null;
}

/**
 * Turn a parsed address into something dialable. See src/main/address.js.
 *
 * The same address asked for twice is the same record, so a second tab to a
 * machine already reached does not ask for the login again, and both panes go
 * on sharing it the way two panes on a saved host do.
 *
 * `auth` is how a plugin's external host connects without ever having chosen
 * the credential itself (see plugins/credentials.js's `resolve()`, which is
 * the only thing allowed to produce one of these): `{ method: 'agent' }` or
 * `{ method: 'key', keyId }`. Omitted, or anything else, is the ordinary
 * "ask for a password" address every quick connect has always been - the one
 * thing a typed address on its own can mean, with no login configured
 * anywhere to reuse.
 */
function openQuickConnect(address, auth = {}) {
    const host = String(address?.host || '').trim();
    if (!host) return null;

    const username = String(address?.username || '').trim();
    const port = Number(address?.port) || defaultPort('ssh');

    const method = auth?.method === 'agent' || auth?.method === 'key' ? auth.method : 'password';
    const keyId = method === 'key' ? String(auth.keyId || '').trim() : '';
    // A "key" auth naming nothing to connect with is not a request this can
    // honour; falling back to a password prompt here would silently ask for
    // something the caller never meant to ask for.
    if (method === 'key' && !keyId) return null;

    // Part of what a repeat ask is matched against, alongside who/where/which
    // port: the same address dialled with a different credential is not the
    // same connection, and must not hand back a record built for the other one.
    const asked = `${method}:${keyId} ${username} ${host} ${port}`;

    for (const record of quickConnects.values()) {
        if (record.asked === asked) return redactHost(record);
    }

    quickCounter += 1;
    const record = {
        id: `${QUICK_PREFIX}${quickCounter}`,
        // Exactly what was typed, and what a later dial is matched against.
        // Held apart from the fields below because those fill in as the login
        // is answered, and what was asked for does not change with them.
        asked,
        // What tells the renderer not to save this back. See App.jsx.
        ephemeral: true,
        protocol: 'ssh',
        host,
        port,
        username,
        authMethod: method === 'key' ? 'keychain' : method,
        ...(method === 'key' ? { keychainKeyId: keyId } : { password: '' }),
    };
    record.name = core.describeAddress(record);

    quickConnects.set(record.id, record);
    return redactHost(record);
}

/**
 * Keep what the user typed at the prompt, for as long as the record lives.
 *
 * Called by the connection layer once an answer has been given, so the next
 * dial on the same address has it: a link that drops and comes back should not
 * put a password box in front of someone six times on the way.
 */
function rememberQuickConnect(hostId, { username, password } = {}) {
    const record = quickConnects.get(hostId);
    if (!record) return;

    if (typeof username === 'string' && username) {
        record.username = username;
        record.name = core.describeAddress(record);
    }
    if (typeof password === 'string') record.password = password;
}

/**
 * Drop every ad-hoc record and the logins typed into them.
 *
 * Locking the app is meant to put the stored secrets out of reach, and a
 * password sitting on one of these would be the one it did not.
 */
function forgetQuickConnects() {
    for (const record of quickConnects.values()) record.password = '';
    quickConnects.clear();
}

/**
 * Resolve the credentials for a host at connect time. Main process only:
 * the return value must never be sent over IPC.
 */
function resolveCredentials(hostId) {
    const store = core.load();
    const host = findHost(hostId);
    if (!host) return null;

    const protocol = normalizeProtocol(host.protocol);

    const credentials = {
        protocol,
        host: host.host,
        port: host.port || defaultPort(protocol),
        username: host.username,
        // Not a credential either, and read only by serial.js. It is resolved
        // here rather than fetched separately so that every transport gets its
        // connect-time configuration from the same call, by host id.
        serial: normalizeSerial(host.serial),
        authMethod: host.authMethod || 'password',
        legacyAlgorithms: Boolean(host.legacyAlgorithms),
        // Blank means "auto-detect"; the connection layer resolves it.
        agentPath: host.agentPath || '',
        agentForward: Boolean(host.agentForward),
        // Not a credential, but it is connect-time host config resolved by id
        // in exactly the same way, and the shell layer already reads this object.
        initCommand: host.initCommand || '',
        // Where the socket is opened, as opposed to what is spoken over it. In
        // dial order, and every entry carries its own decrypted password.
        proxyId: '',
        proxyChain: [],
        password: '',
        privateKey: '',
        passphrase: '',
    };

    /*
     * The proxy this connection is dialled through.
     *
     * Resolved here for the same reasons the credentials are: by id, in the main
     * process, and never taken from the renderer. It is resolved before the
     * protocol check below because it applies to every transport that opens a
     * socket, not only SSH; a serial line has none to open, so it is not asked.
     *
     * A dangling reference is a failure rather than a quiet direct connection.
     * A proxy is usually the only route to the host, and where it is not, it was
     * chosen to keep the connection off the local network: falling back to
     * dialling straight out would be the one thing the setting exists to stop.
     */
    if (protocol !== 'serial' && host.proxyId) {
        const { chain, error } = resolveProxyChain(host.proxyId);
        if (error) return { ...credentials, error };
        credentials.proxyId = host.proxyId;
        credentials.proxyChain = chain;
    }

    // Only SSH authenticates from here. Telnet and serial have no client-side
    // authentication at all (a device asks for a login over the connection
    // itself, if it asks), so their records carry whatever auth settings they
    // had before the protocol was switched, and none of it is read.
    //
    // This is a guard, not a tidy-up. Without it a host switched to telnet
    // while it was set to keychain auth fails to dial with "Selected SSH key
    // not found in keychain", over a key the connection was never going to use.
    if (protocol !== 'ssh') return credentials;

    // An address typed into a picker arrives with no login on it, so the
    // connection layer does the asking: the user name before it dials, since
    // there is no handshake without one, and the password only once the server
    // has asked for it and its host key has been accepted. Cleared as soon as
    // there is a password to reuse, which is what makes the reconnect after a
    // dropped link silent. See openQuickConnect and ssh.js.
    //
    // Only for a password address, though: one built with a real credential
    // (an agent, or a keychain key - see openQuickConnect's `auth`) has
    // something to authenticate with already and dials exactly like a saved
    // host would, through the ordinary auth handler below rather than the
    // ask-as-you-go one this flag switches on.
    if (host.ephemeral && credentials.authMethod === 'password') credentials.promptCredentials = !host.password;

    if (credentials.authMethod === 'keychain') {
        const key = store.keys.find(k => k.id === host.keychainKeyId);
        if (!key) return { ...credentials, error: 'Selected SSH key not found in keychain' };

        // A Windows Hello key has no private half to hand over: the TPM signs,
        // and only after the person in front of the machine has proved who they
        // are. So the connection is given the credential's name and the public
        // key, and does the asking when it gets there.
        if (key.hello) {
            credentials.authMethod = 'key';
            credentials.hello = { credential: key.helloCredential, publicKey: key.publicKey };
            return credentials;
        }

        credentials.privateKey = core.decryptSecret(key.privateKey);
        credentials.passphrase = core.decryptSecret(key.passphrase);
        // A certificate is public and is carried in the clear. It rides along
        // with the key rather than being chosen per host, the same way `ssh`
        // picks up `<key>-cert.pub` on its own: a certificate belongs to the
        // key it was issued for, not to the server it is shown to.
        credentials.certificate = key.certificate || '';
        credentials.authMethod = 'key';
    } else if (credentials.authMethod === 'key') {
        credentials.privateKey = core.decryptSecret(host.privateKey);
        credentials.passphrase = core.decryptSecret(host.passphrase);
    } else if (credentials.authMethod === 'agent') {
        // The agent holds the key material; there is nothing to decrypt.
    } else if (host.ephemeral) {
        // Held in memory and in the clear: an ad-hoc record is never written,
        // so there is no stored secret here to unwrap. See openQuickConnect.
        credentials.password = String(host.password || '');
    } else {
        credentials.password = core.decryptSecret(host.password);
    }

    return credentials;
}

/**
 * How many servers one connection may be relayed through.
 *
 * A bound rather than a limit anybody will reach: two hops is already unusual
 * and ten is a mistake. It exists so a chain that cycle detection somehow let
 * through still ends, rather than dialling until something else gives out.
 */
const MAX_JUMP_HOPS = 10;

/**
 * Resolve every hop a host is reached through, in the order they are dialled.
 *
 * The last entry is the host itself; anything before it is a jump host, the
 * outermost first. A host with no `jumpHostId` resolves to a chain of one,
 * which is why the connection layer needs no separate path for the ordinary
 * case: it dials a list either way.
 *
 * A jump host is stored as a reference to another saved host rather than as an
 * address, and this is what that buys: each hop is resolved through the same
 * `resolveCredentials` as any other connection, so a bastion is reached with
 * its own key, its own agent, its own certificate and its own host-key trust,
 * none of which would exist if it were a `user@host:port` string on this
 * record.
 *
 * Main process only, under the same rule as resolveCredentials, and more so:
 * this holds decrypted secrets for every hop and must never cross IPC.
 */
function resolveChain(hostId) {
    const fail = (error) => ({ chain: [], error });

    // Walked target-first, because that is the direction the links point, and
    // reversed at the end: a chain is dialled from the outside in.
    const ids = [];
    const seen = new Set();
    let currentId = String(hostId || '').trim();

    while (currentId) {
        if (seen.has(currentId)) {
            return fail(`${describeHost(currentId).name || 'That host'} is reached through itself`);
        }
        if (ids.length >= MAX_JUMP_HOPS) {
            return fail(`This connection is relayed through more than ${MAX_JUMP_HOPS} servers`);
        }

        const host = findHost(currentId);
        if (!host) {
            // The target's own absence is the caller's ordinary "no such host";
            // a missing hop is a dangling reference, which reads differently.
            return fail(ids.length === 0
                ? 'Host not found'
                : 'A jump host this connection is relayed through no longer exists');
        }

        seen.add(currentId);
        ids.push(currentId);
        currentId = String(host.jumpHostId || '').trim();
    }

    // A blank host id never entered the loop, so it collected nothing. Reported
    // as the missing host it is rather than returned as an empty chain, which
    // the connection layer would walk into believing it had a target.
    if (ids.length === 0) return fail('Host not found');

    ids.reverse();

    const chain = [];
    for (const [index, id] of ids.entries()) {
        const isTarget = index === ids.length - 1;
        const label = describeHost(id);

        // A relay is a channel on an SSH connection, so a hop that is not
        // itself an SSH host has nothing to open one on. Only checked for the
        // hops: what the target speaks is the dispatcher's business.
        if (!isTarget && getHostProtocol(id) !== 'ssh') {
            return fail(`${label.name} is not an SSH host, so nothing can be relayed through it`);
        }

        const credentials = resolveCredentials(id);
        if (!credentials) {
            return fail('A jump host this connection is relayed through no longer exists');
        }
        if (credentials.error) {
            // Named, because "Selected SSH key not found in keychain" about a
            // bastion the user was not thinking about is otherwise a message
            // that appears to be about the host they asked for.
            return fail(isTarget ? credentials.error : `${label.name}: ${credentials.error}`);
        }

        chain.push({ ...credentials, hostId: id, label, isTarget });
    }

    return { chain, error: '' };
}

/**
 * Which transport a host connects over.
 *
 * Separate from resolveCredentials because the dispatcher needs it before it
 * has chosen a backend, and resolving credentials to answer a question with no
 * secret in it would decrypt a private key just to read one string.
 */
function getHostProtocol(hostId) {
    const host = findHost(hostId);
    return normalizeProtocol(host?.protocol);
}

/** Port forwards configured for a host, in the shape the runtime expects. */
function getHostTunnels(hostId) {
    const host = core.load().hosts.find(h => h.id === hostId);
    return normalizeTunnels(host?.tunnels);
}

module.exports = {
    redactHost,
    describeHost,
    getHosts,
    saveHost,
    deleteHost,
    duplicateHost,
    tagHosts,
    isQuickConnectId,
    findHost,
    openQuickConnect,
    rememberQuickConnect,
    forgetQuickConnects,
    resolveCredentials,
    MAX_JUMP_HOPS,
    resolveChain,
    getHostProtocol,
    getHostTunnels,
};
