const { ipcRenderer, subscribe } = require('./channel');

// The audit trail: connections made, records edited, remote files touched.
// Read-only from here apart from clearing it: entries are written by the
// main process at the point the thing actually happened, never by the
// renderer asking for a line to be added.
const activity = {
    list: (options) => ipcRenderer.invoke('activity-list', options || {}),
    summary: () => ipcRenderer.invoke('activity-summary'),
    clear: () => ipcRenderer.invoke('activity-clear'),
    export: () => ipcRenderer.invoke('activity-export'),

    onAppend: (callback) => subscribe('activity-append', callback),
    onCleared: (callback) => subscribe('activity-cleared', callback),
};

/**
 * Session transcripts: what the server printed, written to a file.
 *
 * Write-only from here in the sense that matters: the renderer can turn
 * recording on, off and find the files, but the transcript never travels
 * back across the bridge. It is captured in main, where the bytes arrive,
 * so a reload cannot punch a hole in it.
 */
const sessionLog = {
    config: () => ipcRenderer.invoke('session-log-config'),
    configure: (patch) => ipcRenderer.invoke('session-log-configure', patch || {}),
    chooseDirectory: () => ipcRenderer.invoke('session-log-choose-directory'),
    resetDirectory: () => ipcRenderer.invoke('session-log-reset-directory'),
    openFolder: () => ipcRenderer.invoke('session-log-open-folder'),

    status: (tabId) => ipcRenderer.invoke('session-log-status', tabId),
    start: (tabId) => ipcRenderer.invoke('session-log-start', tabId),
    stop: (tabId) => ipcRenderer.invoke('session-log-stop', tabId),

    list: (options) => ipcRenderer.invoke('session-log-list', options || {}),
    reveal: (filePath) => ipcRenderer.invoke('session-log-reveal', filePath),
};

module.exports = { activity, sessionLog };
