const { normalizeDesktop } = require('../desktop-config');
const { normalizeBmc } = require('../bmc-config');
const core = require('./core');
const { resolveProxyChain } = require('./proxies');

/**
 * A host's desktop block, with the address filled in.
 *
 * A direct desktop that names no address means the host itself. Requiring it to
 * be typed twice would be asking for the same answer to the same question, and
 * for an RDP-only host, where the desktop *is* the connection, it would be
 * asking for it in the one place the user has no reason to look.
 *
 * Only for `direct`: under a tunnel, a blank address means the server's own
 * loopback, which is a different (and deliberate) default.
 */
function desktopFor(host) {
    const desktop = normalizeDesktop(host?.desktop);
    if (desktop.transport === 'direct' && !desktop.host && host?.host) {
        return { ...desktop, host: host.host };
    }
    return desktop;
}

/** Whether a host has a desktop configured, for the parts of the UI that only ask that. */
function getHostDesktop(hostId) {
    const host = core.load().hosts.find(h => h.id === hostId);
    return desktopFor(host);
}

/**
 * Resolve a host's remote desktop settings, password included.
 *
 * Main process only, under the same rule as resolveCredentials: this return
 * value must never be sent over IPC as it stands. The VNC bridge performs the
 * RFB handshake itself precisely so that its password never has to reach the
 * renderer; the RDP bridge cannot, and forwards `password` alone. See the note
 * at the top of rdp.js.
 *
 * `password` is whichever secret belongs to the configured protocol, so callers
 * do not have to know which field it was stored in.
 */
function resolveDesktop(hostId) {
    const host = core.load().hosts.find(h => h.id === hostId);
    if (!host) return null;

    const desktop = desktopFor(host);

    /*
     * A desktop dialled `direct` opens its own socket, so it goes through the
     * host's proxy exactly as a shell session would. Under `tunnel` it is a
     * channel on an SSH connection that has already been made, and that
     * connection is where the proxy was applied, so the chain is left empty
     * rather than proxying something that is already inside a tunnel.
     *
     * A broken reference is reported the way resolveCredentials reports one: as
     * an error, not as a desktop that quietly reaches out on its own.
     */
    let proxyChain = [];
    let proxyError = '';
    if (desktop.transport === 'direct' && host.proxyId) {
        const resolved = resolveProxyChain(host.proxyId);
        proxyChain = resolved.chain;
        proxyError = resolved.error;
    }

    return {
        ...desktop,
        proxyChain,
        proxyError,
        password: core.decryptSecret(desktop.protocol === 'rdp' ? host.rdpPassword : host.vncPassword),
    };
}

/* ------------------------------------------------------------------ *
 * Service processors (IPMI / BMC)
 * ------------------------------------------------------------------ */

/**
 * A host's BMC block, with the address filled in.
 *
 * A blank address means the host itself, for the boards that share the machine's
 * NIC rather than having a dedicated one. Same reasoning as desktopFor: it would
 * otherwise be the same answer typed into a second box.
 */
function bmcFor(host) {
    const bmc = normalizeBmc(host?.bmc);
    if (!bmc.host && host?.host) return { ...bmc, host: host.host };
    return bmc;
}

/** Whether a host has a BMC configured, for the parts of the UI that only ask that. */
function getHostBmc(hostId) {
    const host = core.load().hosts.find(h => h.id === hostId);
    return bmcFor(host);
}

/**
 * Resolve a host's BMC settings, password included.
 *
 * Main process only, under the same rule as resolveCredentials and
 * resolveDesktop: this return value must never be sent over IPC as it stands.
 * There is no exception here of the kind rdp.js documents. bmc.js is the only
 * caller, and it puts the password into the guest page itself rather than
 * handing it to anything that could pass it on.
 *
 * No proxy chain, unlike resolveDesktop. A `<webview>` load goes out through
 * Chromium's own network stack, which this app's SOCKS records do not configure,
 * so pretending to apply one here would be describing a route that is not taken.
 */
function resolveBmc(hostId) {
    const host = core.load().hosts.find(h => h.id === hostId);
    if (!host) return null;

    return {
        ...bmcFor(host),
        password: core.decryptSecret(host.bmcPassword),
    };
}

/**
 * Record the certificate a user has agreed to for a host's BMC.
 *
 * Written straight onto the record rather than through saveHost, because
 * saveHost is the renderer's path and this decision is made in the main process
 * on behalf of a prompt the renderer only displayed. Going the long way round
 * would mean handing the renderer a host record to send back, which is how a
 * trust decision picks up an edit nobody made.
 */
function trustBmcCert(hostId, fingerprint) {
    const store = core.load();
    const host = store.hosts.find(h => h.id === hostId);
    if (!host || !fingerprint) return false;

    host.bmc = normalizeBmc({ ...normalizeBmc(host.bmc), trustedCert: fingerprint });
    core.persist();
    return true;
}

module.exports = {
    desktopFor,
    getHostDesktop,
    resolveDesktop,
    bmcFor,
    getHostBmc,
    resolveBmc,
    trustBmcCert,
};
