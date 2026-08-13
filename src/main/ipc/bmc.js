const store = require('../store');
const bmc = require('../bmc');
const activity = require('../activity');
const { describeBmc } = require('../bmc-config');

/**
 * Named from the host record rather than from `ssh.describe`, because a
 * direct-transport desktop has no SSH session to describe and would
 * otherwise be logged as happening nowhere.
 */
function describeDesktopHost(hostId) {
    const info = store.describeHost(hostId);
    return { hostId: info.id, hostName: info.name, subject: info.address };
}

function register({ handle }) {
    /* ---------------- Service processors (IPMI / BMC) ---------------- */

    handle('bmc-get', (event, paneId) => bmc.get(paneId));

    /**
     * Prepare a BMC pane. Returns the URL and partition for the `<webview>` to
     * load; the password stays in main, and reaches the page from there.
     */
    handle('bmc-open', async (event, { paneId, hostId }) => {
        const result = await bmc.open(paneId, hostId);

        activity.record({
            category: 'connection',
            action: 'bmc.open',
            outcome: result.success ? 'success' : 'failure',
            target: describeBmc(store.getHostBmc(hostId)),
            detail: 'IPMI',
            message: result.success ? '' : (result.message || ''),
            ...describeDesktopHost(hostId),
        });

        return result;
    });

    /**
     * The renderer handing over the guest page it has just created. Everything
     * done *to* that page (the login, the popup policy, the load reporting)
     * happens in main from here on.
     */
    handle('bmc-attach', (event, { paneId, webContentsId }) => bmc.attach(paneId, webContentsId));

    /** Fill the login form again, from the pane's own button. */
    handle('bmc-login', (event, paneId) => bmc.login(paneId));

    handle('bmc-close', (event, { paneId, hostId }) => {
        const existed = Boolean(bmc.get(paneId));
        const result = bmc.close(paneId);

        if (existed && hostId) {
            activity.record({
                category: 'connection',
                action: 'bmc.close',
                target: describeBmc(store.getHostBmc(hostId)),
                detail: 'IPMI',
                ...describeDesktopHost(hostId),
            });
        }

        return result;
    });
}

module.exports = { register };
