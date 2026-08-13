const tunnels = require('../tunnels');
const activity = require('../activity');
const ssh = require('../ssh');
const { describeTunnel } = require('../tunnel-config');

/** Name a forward the way its row in the tunnels view does. */
function describeForward(tabId, tunnelId) {
    const found = tunnels.list(tabId).find(entry => entry.id === tunnelId);
    if (!found) return tunnelId;
    return found.name ? `${found.name} (${describeTunnel(found)})` : describeTunnel(found);
}

function logTunnel(action, tabId, tunnelId, result) {
    activity.record({
        category: 'connection',
        action,
        outcome: result?.success ? 'info' : 'failure',
        target: describeForward(tabId, tunnelId),
        detail: 'Port forward',
        message: result?.success ? '' : (result?.message || ''),
        ...ssh.describe(tabId),
    });
    return result;
}

function register({ handle }) {
    /* ---------------- Port forwarding ---------------- */

    handle('tunnels-list', (event, tabId) => tunnels.list(tabId));
    // Called after the host's tunnel list is edited, so what runs matches what
    // is configured without needing a reconnect.
    handle('tunnels-sync', (event, { tabId, hostId }) => tunnels.sync(tabId, hostId));
    handle('tunnels-start', (event, { tabId, tunnelId }) =>
        logTunnel('tunnel.start', tabId, tunnelId, tunnels.start(tabId, tunnelId)));
    handle('tunnels-stop', (event, { tabId, tunnelId }) =>
        logTunnel('tunnel.stop', tabId, tunnelId, tunnels.stop(tabId, tunnelId)));
    handle('tunnels-start-all', (event, tabId) => tunnels.startAll(tabId));
    handle('tunnels-stop-all', (event, tabId) => tunnels.stopAll(tabId));
}

module.exports = { register };
