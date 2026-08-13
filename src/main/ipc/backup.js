const { dialog } = require('electron');
const store = require('../store');
const knownHosts = require('../known-hosts');
const backup = require('../backup');
const activity = require('../activity');

// token -> decrypted backup payload, awaiting a restore decision. Held here so
// the credentials inside a backup never have to cross the bridge to be counted.
const pendingBackups = new Map();
let pendingCounter = 0;

function register({ handle, getWindow }) {
    /* ---------------- Backup ----------------
     *
     * The decrypted payload never crosses the bridge. `inspect` holds it here
     * under a token and hands back counts, exactly as a freshly generated key
     * is claimed by reference, so the renderer can show what a file contains
     * and offer a merge choice without ever holding the credentials in it.
     */

    handle('backup-export', async (event, { passphrase } = {}) => {
        const problem = backup.validatePassphrase(passphrase);
        if (problem) return { success: false, message: problem };

        // Before the dialog: a locked vault would export blanks, and finding
        // that out after picking a filename is a worse way to learn it.
        let payload;
        try {
            payload = { ...store.exportAll(), knownHosts: knownHosts.exportAll() };
        } catch (error) {
            return { success: false, message: error.message };
        }

        const stamp = new Date().toISOString().slice(0, 10);
        const { canceled, filePath } = await dialog.showSaveDialog(getWindow(), {
            title: 'Save encrypted backup',
            defaultPath: `reefterm-backup-${stamp}.reefbackup`,
            filters: [{ name: 'Reef Terminal backup', extensions: ['reefbackup'] }],
        });
        if (canceled || !filePath) return { success: false, canceled: true };

        try {
            backup.writeFile(filePath, backup.seal(payload, passphrase));
        } catch (error) {
            activity.record({
                category: 'security',
                action: 'backup.export',
                outcome: 'failure',
                target: filePath,
                message: error.message,
            });
            return { success: false, message: `Could not write the backup: ${error.message}` };
        }

        // Worth a line precisely because it is the one operation that takes
        // every stored credential off this machine in a single file.
        activity.record({
            category: 'security',
            action: 'backup.export',
            target: filePath,
            detail: `${payload.hosts.length} host(s), ${payload.keys.length} key(s)`,
        });

        return {
            success: true,
            path: filePath,
            counts: {
                hosts: payload.hosts.length,
                folders: payload.folders.length,
                keys: payload.keys.length,
                snippets: payload.snippets.length,
                proxies: payload.proxies.length,
                knownHosts: Object.keys(payload.knownHosts).length,
            },
        };
    });

    handle('backup-inspect', async (event, { passphrase, filePath } = {}) => {
        let target = filePath;
        if (!target) {
            const { canceled, filePaths } = await dialog.showOpenDialog(getWindow(), {
                title: 'Open encrypted backup',
                properties: ['openFile'],
                filters: [
                    { name: 'Reef Terminal backup', extensions: ['reefbackup'] },
                    { name: 'All Files', extensions: ['*'] },
                ],
            });
            if (canceled || filePaths.length === 0) return { success: false, canceled: true };
            target = filePaths[0];
        }

        let envelope;
        try {
            envelope = backup.readFile(target);
        } catch (error) {
            return { success: false, message: error.message };
        }

        let payload;
        try {
            payload = backup.unseal(envelope, passphrase);
        } catch (error) {
            return { success: false, message: error.message };
        }
        if (!payload) {
            return { success: false, message: 'Wrong passphrase, or the file has been altered' };
        }

        const token = `backup-${++pendingCounter}`;
        pendingBackups.set(token, payload);

        return {
            success: true,
            token,
            path: target,
            createdAt: envelope.createdAt || '',
            appVersion: envelope.app || '',
            summary: store.previewImport(payload),
            knownHosts: Object.keys(payload.knownHosts || {}).length,
        };
    });

    handle('backup-restore', (event, { token, overwrite } = {}) => {
        const payload = pendingBackups.get(token);
        if (!payload) {
            return { success: false, message: 'That backup is no longer open. Choose the file again.' };
        }
        pendingBackups.delete(token);

        try {
            const result = store.importAll(payload, { overwrite: Boolean(overwrite) });
            const hostKeys = knownHosts.importAll(payload.knownHosts, {
                overwrite: Boolean(overwrite),
            });

            // A restore writes records straight into the store rather than
            // through saveHost, so nothing else would report it.
            activity.record({
                category: 'security',
                action: 'backup.restore',
                target: 'Encrypted backup',
                detail: [
                    `${result.hosts.added} host(s) added`,
                    result.hosts.replaced ? `${result.hosts.replaced} replaced` : '',
                    `${result.keys.added} key(s) added`,
                    overwrite ? 'existing records overwritten' : 'existing records kept',
                ].filter(Boolean).join(' · '),
            });

            return { success: true, ...result, knownHosts: hostKeys };
        } catch (error) {
            activity.record({
                category: 'security',
                action: 'backup.restore',
                outcome: 'failure',
                target: 'Encrypted backup',
                message: error.message,
            });
            return { success: false, message: error.message };
        }
    });

    /** Drop a payload the user decided not to restore, rather than holding it. */
    handle('backup-discard', (event, token) => {
        pendingBackups.delete(token);
        return true;
    });
}

/** Drop any decrypted backup nobody is going to restore now. */
function clearPending() {
    pendingBackups.clear();
}

module.exports = { register, clearPending };
