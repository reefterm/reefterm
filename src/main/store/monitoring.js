const { normalizeMonitor, monitorSupport, defaultCheckPort } = require('../monitor-config');
const { defaultPort } = require('../protocol-config');
const core = require('./core');
const { resolveProxyChain } = require('./proxies');

/* ------------------------------------------------------------------ *
 * Monitoring
 * ------------------------------------------------------------------ */

/**
 * What one watched host resolves to: where to knock, and what stops it being
 * knocked on at all.
 *
 * Everything except the proxy route, which is the only expensive part and the
 * only part that carries a secret. Both readers below are built on this so that
 * the list a settings page shows and the list the poller dials cannot disagree
 * about which port a host is checked on.
 */
function monitorEntry(host) {
    const monitor = normalizeMonitor(host.monitor);
    const label = { hostId: host.id, name: host.name || host.host || host.id };

    const support = monitorSupport(host);
    if (!support.ok) {
        // Configured on, and no longer checkable: the host was switched to
        // serial, or given a jump host, after monitoring was turned on.
        return { ...label, host: '', port: 0, error: support.reason };
    }

    // A desktop-only host is named by its desktop address when it has one of
    // its own; for everything else there is one address on the record.
    const desktopOnly = Boolean(host.desktop?.enabled && host.desktop.only);
    const address = (desktopOnly ? host.desktop.host || host.host : host.host) || '';
    const port = monitor.port || defaultCheckPort(host, defaultPort(host.protocol));

    if (!port) {
        return { ...label, host: address, port: 0, error: 'There is no port to check this host on' };
    }

    return { ...label, host: address, port, error: '' };
}

/** Every host with the switch on, in the order they are stored. */
const monitoredHosts = () =>
    core.load().hosts.filter(host => normalizeMonitor(host.monitor).enabled);

/**
 * Every host the poller should be checking, with the address, port and proxy
 * route resolved.
 *
 * Main process only, under the same rule as resolveCredentials: a proxy chain
 * carries decrypted passwords, so this return value must never cross IPC as it
 * stands. monitor.js keeps them and sends the renderer nothing but names.
 *
 * A host whose settings cannot be resolved (a proxy that has been deleted out
 * from under it) is returned with `error` set rather than dropped. Silently not
 * checking a host that is switched on reads, from the outside, exactly like a
 * host that is up.
 */
function getMonitorTargets() {
    return monitoredHosts().map((host) => {
        const entry = { ...monitorEntry(host), proxyChain: [] };
        if (entry.error || !host.proxyId) return entry;

        // The same route the session would take. A host only reachable through
        // a proxy has to be checked through it too, or the check is answering a
        // question about a network this machine is not on.
        const { chain, error } = resolveProxyChain(host.proxyId);
        if (error) entry.error = error;
        else entry.proxyChain = chain;

        return entry;
    });
}

/**
 * The same list, named for a person rather than for a socket, and safe to send
 * over IPC: no proxy chain, so no password, so nothing to redact.
 *
 * This is what answers "which hosts am I watching", which has to be answerable
 * before any check has ever run and while monitoring is switched off entirely.
 * Deriving it from the results of the last sweep, which is the obvious thing to
 * do, means a settings page that can only tell you what it is watching after it
 * has watched something.
 *
 * Monitoring facts only: an id, a name and where the check goes. Anything about
 * how a host is *drawn* (its OS, its distro icon) is deliberately not here. The
 * renderer already holds every host record, and joining on the id there means
 * one source for what a host looks like rather than a second copy travelling
 * alongside every status update.
 */
function listMonitoredHosts() {
    return monitoredHosts().map((host) => {
        const entry = monitorEntry(host);
        return {
            hostId: entry.hostId,
            name: entry.name,
            address: entry.host ? `${entry.host}:${entry.port}` : '',
            error: entry.error,
        };
    });
}

module.exports = {
    getMonitorTargets,
    listMonitoredHosts,
};
