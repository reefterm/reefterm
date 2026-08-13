const { app, shell } = require('electron');
const sftp = require('../sftp');
const transfers = require('../transfers');
const remoteEdit = require('../remote-edit');
const activity = require('../activity');
const ssh = require('../ssh');

/**
 * Every SFTP mutation changes something on a server, which is the half of
 * "who changed what" that happens outside this app's own store. They are
 * logged here rather than inside sftp.js because this is where the user's
 * intent is still legible: one entry per action taken, not one per file a
 * recursive walk happened to touch.
 */
async function logFile(action, tabId, target, detail, run) {
    const result = await run();
    activity.record({
        category: 'files',
        action,
        outcome: result?.success ? 'success' : 'failure',
        target,
        detail,
        message: result?.success ? '' : (result?.message || ''),
        ...ssh.describe(tabId),
    });
    return result;
}

function register({ handle }) {
    /* ---------------- SFTP: browsing ---------------- */

    handle('sftp-init', (event, tabId) => sftp.init(tabId));
    handle('sftp-close', (event, tabId) => sftp.close(tabId));
    handle('sftp-list', (event, { tabId, remotePath }) => sftp.list(tabId, remotePath));
    handle('sftp-home', (event, tabId) => sftp.home(tabId));
    handle('sftp-realpath', (event, { tabId, remotePath }) => sftp.realpath(tabId, remotePath));
    handle('sftp-stat', (event, { tabId, remotePath, follow }) =>
        sftp.stat(tabId, remotePath, { follow }));
    handle('sftp-disk-usage', (event, { tabId, remotePath }) =>
        sftp.diskUsage(tabId, remotePath));

    /* ---------------- SFTP: mutations ---------------- */

    handle('sftp-mkdir', (event, { tabId, remotePath }) =>
        logFile('file.mkdir', tabId, remotePath, 'Folder created', () => sftp.mkdir(tabId, remotePath)));

    handle('sftp-create-file', (event, { tabId, remotePath }) =>
        logFile('file.create', tabId, remotePath, 'File created', () => sftp.createFile(tabId, remotePath)));

    handle('sftp-delete', (event, { tabId, remotePaths }) => {
        const targets = Array.isArray(remotePaths) ? remotePaths : [remotePaths];
        return logFile(
            'file.delete',
            tabId,
            targets[0] || '',
            targets.length > 1 ? `and ${targets.length - 1} more` : '',
            () => sftp.remove(tabId, remotePaths),
        );
    });

    handle('sftp-rename', (event, { tabId, oldPath, newPath }) =>
        logFile('file.rename', tabId, oldPath, `to ${newPath}`, () =>
            sftp.rename(tabId, oldPath, newPath)));

    handle('sftp-chmod', (event, { tabId, remotePath, mode, recursive }) =>
        logFile(
            'file.chmod',
            tabId,
            remotePath,
            `${((mode || 0) & 0o7777).toString(8).padStart(4, '0')}${recursive ? ', recursively' : ''}`,
            () => sftp.chmod(tabId, remotePath, mode, { recursive }),
        ));

    handle('sftp-copy', (event, { tabId, sources, destinationDir, move }) => {
        const list = Array.isArray(sources) ? sources : [sources];
        return logFile(
            move ? 'file.move' : 'file.copy',
            tabId,
            list[0] || '',
            [`to ${destinationDir}`, list.length > 1 ? `and ${list.length - 1} more` : '']
                .filter(Boolean).join(' · '),
            () => sftp.transferRemote(tabId, sources, destinationDir, { move }),
        );
    });

    /* ---------------- SFTP: transfers ---------------- */

    handle('sftp-transfer-enqueue', (event, { tabId, ...options }) =>
        transfers.enqueue(tabId, options));
    handle('sftp-transfer-list', (event, tabId) => transfers.list(tabId));
    handle('sftp-transfer-cancel', (event, id) => transfers.cancel(id));
    handle('sftp-transfer-cancel-all', (event, tabId) => transfers.cancelAll(tabId));
    handle('sftp-transfer-retry', (event, id) => transfers.retry(id));
    handle('sftp-transfer-clear', (event, tabId) => transfers.clearFinished(tabId));
    handle('sftp-conflict-response', (event, { requestId, decision }) =>
        transfers.resolveConflict(requestId, decision));

    /* ---------------- SFTP: local editing ---------------- */

    handle('sftp-edit-open', (event, { tabId, remotePath }) =>
        remoteEdit.open(tabId, remotePath));
    handle('sftp-edit-stop', (event, { tabId, remotePath }) =>
        remoteEdit.stop(tabId, remotePath));
    handle('sftp-edit-list', (event, tabId) => remoteEdit.list(tabId));

    /* ---------------- Local filesystem (SFTP targets only) ---------------- */

    handle('local-home', () => ({ success: true, path: app.getPath('downloads') }));
    handle('local-reveal', (event, localPath) => {
        shell.showItemInFolder(localPath);
        return { success: true };
    });
}

module.exports = { register };
