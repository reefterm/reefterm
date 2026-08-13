const monitor = require('../monitor');
const cloudSnapshot = require('../cloud-snapshot');

function register({ handle }) {
    /* ---------------- Host monitoring ---------------- */

    handle('monitor-status', () => monitor.status());

    handle('monitor-configure', (event, patch) => monitor.configure(patch || {}));

    handle('monitor-check-now', () => monitor.checkNow());

    /* ---------------- Cloud setup snapshot ---------------- */

    handle('cloud-snapshot-status', () => cloudSnapshot.status());

    handle('cloud-snapshot-set-enabled', (event, enabled) => cloudSnapshot.setEnabled(enabled));

    handle('cloud-snapshot-push', async () => ({
        result: await cloudSnapshot.push(),
        status: cloudSnapshot.status(),
    }));

    handle('cloud-snapshot-pull', async () => ({
        result: await cloudSnapshot.pull({ force: true }),
        status: cloudSnapshot.status(),
    }));

    /**
     * Terminal settings live in the renderer's localStorage, which main cannot
     * read, so the renderer hands them over whenever they change. Held in
     * memory only -- the snapshot is the copy that persists.
     */
    handle('cloud-snapshot-settings', (event, settings) => {
        cloudSnapshot.setSettings(settings);
        return true;
    });
}

module.exports = { register };
