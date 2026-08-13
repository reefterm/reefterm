const { dialog, shell } = require('electron');
const fs = require('fs');
const path = require('path');
const activity = require('../activity');
const sessionLog = require('../session-log');
const ssh = require('../ssh');

function register({ handle, getWindow }) {
    /* ---------------- Activity log ----------------
     *
     * Behind the same lock as everything else: the log names every server this
     * machine reaches and every path that was touched on them, which is worth
     * as much to someone snooping as the host list itself.
     */

    handle('activity-list', (event, options) => activity.list(options || {}));
    handle('activity-summary', () => activity.summary());
    handle('activity-clear', () => activity.clear());

    handle('activity-export', async () => {
        const stamp = new Date().toISOString().slice(0, 10);
        const { canceled, filePath } = await dialog.showSaveDialog(getWindow(), {
            title: 'Export activity log',
            defaultPath: `reefterm-activity-${stamp}.json`,
            filters: [{ name: 'JSON', extensions: ['json'] }],
        });
        if (canceled || !filePath) return { success: false, canceled: true };

        const entries = activity.exportAll();
        try {
            fs.writeFileSync(filePath, JSON.stringify({
                exportedAt: new Date().toISOString(),
                exportedBy: activity.actor(),
                entries,
            }, null, 2), 'utf8');
        } catch (error) {
            return { success: false, message: `Could not write the log: ${error.message}` };
        }

        return { success: true, path: filePath, count: entries.length };
    });

    /* ---------------- Session transcripts ----------------
     *
     * The output half of the audit trail. Everything here is about files on
     * this machine and the setting that governs them; the bytes themselves
     * never come back through the bridge, so the renderer can start, stop and
     * find a transcript without ever being handed its contents.
     */

    handle('session-log-config', () => sessionLog.getConfig());
    handle('session-log-configure', (event, patch) => sessionLog.setConfig(patch || {}));
    handle('session-log-status', (event, tabId) => sessionLog.status(tabId));
    handle('session-log-list', (event, options) => sessionLog.list(options || {}));

    // Recording this one session while the global setting is off. The host is
    // resolved from the live session rather than passed in, so the renderer
    // cannot name a file after a server it is not actually connected to.
    handle('session-log-start', (event, tabId) => {
        const session = ssh.get(tabId);
        if (!session) return { success: false, message: 'That session is not connected' };

        const filePath = sessionLog.start(tabId, {
            hostName: session.hostName,
            address: session.address,
            hostId: session.hostId,
            force: true,
        });

        return filePath
            ? { success: true, ...sessionLog.status(tabId) }
            : { success: false, message: 'Could not open a log file. Check the folder in Settings.' };
    });

    handle('session-log-stop', (event, tabId) => {
        const filePath = sessionLog.close(tabId, { reason: 'stopped' });
        return { success: Boolean(filePath), path: filePath || '', ...sessionLog.status(tabId) };
    });

    handle('session-log-choose-directory', async () => {
        const { directory } = sessionLog.getConfig();
        const { canceled, filePaths } = await dialog.showOpenDialog(getWindow(), {
            title: 'Where to keep session logs',
            defaultPath: directory,
            properties: ['openDirectory', 'createDirectory'],
        });
        if (canceled || !filePaths?.[0]) return { success: false, canceled: true };

        return { success: true, config: sessionLog.setConfig({ directory: filePaths[0] }) };
    });

    /** Back to the default folder, without having to navigate to it in a picker. */
    handle('session-log-reset-directory', () =>
        ({ success: true, config: sessionLog.setConfig({ directory: '' }) }));

    handle('session-log-reveal', async (event, filePath) => {
        // Only ever a path this module handed out, so it is checked against the
        // log directory rather than trusted: `showItemInFolder` on an arbitrary
        // string would let the renderer point Explorer anywhere.
        const { directory } = sessionLog.getConfig();
        const resolved = path.resolve(String(filePath || ''));
        const root = path.resolve(directory);

        if (resolved !== root && !resolved.startsWith(root + path.sep)) {
            return { success: false, message: 'That file is not in the session log folder' };
        }

        if (!fs.existsSync(resolved)) return { success: false, message: 'That log is no longer there' };
        shell.showItemInFolder(resolved);
        return { success: true };
    });

    handle('session-log-open-folder', async () => {
        const { directory } = sessionLog.getConfig();
        try {
            fs.mkdirSync(directory, { recursive: true });
        } catch (error) {
            return { success: false, message: error.message };
        }
        const failure = await shell.openPath(directory);
        return failure ? { success: false, message: failure } : { success: true };
    });
}

module.exports = { register };
