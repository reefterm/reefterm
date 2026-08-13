const store = require('../store');
const vnc = require('../vnc');
const activity = require('../activity');
const { describeDesktop } = require('../desktop-config');

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
    /* ---------------- Remote desktop: VNC ---------------- */

    handle('vnc-get', (event, paneId) => vnc.get(paneId));

    handle('vnc-open', async (event, { paneId, hostId }) => {
        const result = await vnc.open(paneId, hostId);

        activity.record({
            category: 'connection',
            action: 'desktop.open',
            outcome: result.success ? 'success' : 'failure',
            target: describeDesktop(store.getHostDesktop(hostId)),
            detail: 'Remote desktop',
            message: result.success ? '' : (result.message || ''),
            ...describeDesktopHost(hostId),
        });

        return result;
    });

    handle('vnc-close', (event, { paneId, hostId }) => {
        // Only a session that existed is worth a line; the view closes
        // defensively on unmount whether or not it ever opened one.
        const existed = Boolean(vnc.get(paneId));
        const result = vnc.close(paneId);

        if (existed && hostId) {
            activity.record({
                category: 'connection',
                action: 'desktop.close',
                target: describeDesktop(store.getHostDesktop(hostId)),
                detail: 'Remote desktop',
                ...describeDesktopHost(hostId),
            });
        }

        return result;
    });

    // The desktop's own name arrives in ServerInit, which only the viewer parses.
    handle('vnc-name', (event, { paneId, name }) => vnc.setDesktopName(paneId, name));
}

module.exports = { register };
