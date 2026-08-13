const { ipcRenderer, subscribe } = require('./channel');
const { webUtils } = require('electron');

const sftp = {
    init: (tabId) => ipcRenderer.invoke('sftp-init', tabId),
    close: (tabId) => ipcRenderer.invoke('sftp-close', tabId),

    list: (tabId, remotePath) => ipcRenderer.invoke('sftp-list', { tabId, remotePath }),
    home: (tabId) => ipcRenderer.invoke('sftp-home', tabId),
    realpath: (tabId, remotePath) => ipcRenderer.invoke('sftp-realpath', { tabId, remotePath }),
    stat: (tabId, remotePath, follow = true) =>
        ipcRenderer.invoke('sftp-stat', { tabId, remotePath, follow }),
    diskUsage: (tabId, remotePath) => ipcRenderer.invoke('sftp-disk-usage', { tabId, remotePath }),

    mkdir: (tabId, remotePath) => ipcRenderer.invoke('sftp-mkdir', { tabId, remotePath }),
    createFile: (tabId, remotePath) => ipcRenderer.invoke('sftp-create-file', { tabId, remotePath }),
    remove: (tabId, remotePaths) => ipcRenderer.invoke('sftp-delete', { tabId, remotePaths }),
    rename: (tabId, oldPath, newPath) =>
        ipcRenderer.invoke('sftp-rename', { tabId, oldPath, newPath }),
    chmod: (tabId, remotePath, mode, recursive = false) =>
        ipcRenderer.invoke('sftp-chmod', { tabId, remotePath, mode, recursive }),
    copy: (tabId, sources, destinationDir, move = false) =>
        ipcRenderer.invoke('sftp-copy', { tabId, sources, destinationDir, move }),

    // Fired when a completed transfer may have changed the remote tree.
    onChanged: (callback) => subscribe('sftp-changed', callback),
};

const transfers = {
    enqueue: (tabId, options) => ipcRenderer.invoke('sftp-transfer-enqueue', { tabId, ...options }),
    list: (tabId) => ipcRenderer.invoke('sftp-transfer-list', tabId),
    cancel: (id) => ipcRenderer.invoke('sftp-transfer-cancel', id),
    cancelAll: (tabId) => ipcRenderer.invoke('sftp-transfer-cancel-all', tabId),
    retry: (id) => ipcRenderer.invoke('sftp-transfer-retry', id),
    clearFinished: (tabId) => ipcRenderer.invoke('sftp-transfer-clear', tabId),

    respondToConflict: (requestId, decision) =>
        ipcRenderer.invoke('sftp-conflict-response', { requestId, decision }),

    onUpdate: (callback) => subscribe('sftp-transfers', callback),
    onConflict: (callback) => subscribe('sftp-conflict', callback),
    onConflictResolved: (callback) => subscribe('sftp-conflict-resolved', callback),
};

const remoteEdit = {
    open: (tabId, remotePath) => ipcRenderer.invoke('sftp-edit-open', { tabId, remotePath }),
    stop: (tabId, remotePath) => ipcRenderer.invoke('sftp-edit-stop', { tabId, remotePath }),
    list: (tabId) => ipcRenderer.invoke('sftp-edit-list', tabId),
    onStatus: (callback) => subscribe('sftp-edit-status', callback),
};

const local = {
    downloadsDir: () => ipcRenderer.invoke('local-home'),
    reveal: (localPath) => ipcRenderer.invoke('local-reveal', localPath),

    // Where a dropped File actually lives on disk. `File.path` used to
    // carry this and was removed in Electron 32, because a renderer that
    // can read it learns real filesystem paths from any drop. It is a
    // preload-only API now, so the path is resolved on this side of the
    // bridge and the renderer only ever sees the string it asked for.
    pathForFile: (file) => {
        try {
            return webUtils.getPathForFile(file);
        } catch {
            // Not a real File (or one with no backing path, e.g. dragged
            // out of another app's virtual folder). Callers filter these.
            return '';
        }
    },
};

module.exports = { sftp, transfers, remoteEdit, local };
