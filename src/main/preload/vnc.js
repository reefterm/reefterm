const { ipcRenderer, subscribe } = require('./channel');

// Remote desktop. `open` returns the loopback WebSocket address the viewer
// attaches to; main has already authenticated to the VNC server by then,
// so no credential is ever handed to this side of the bridge.
const vnc = {
    get: (paneId) => ipcRenderer.invoke('vnc-get', paneId),
    open: (paneId, hostId) => ipcRenderer.invoke('vnc-open', { paneId, hostId }),
    close: (paneId, hostId) => ipcRenderer.invoke('vnc-close', { paneId, hostId }),
    // Reported back so the header and the activity log can name the desktop
    // the way the server does.
    reportName: (paneId, name) => ipcRenderer.invoke('vnc-name', { paneId, name }),

    onUpdate: (callback) => subscribe('vnc-update', callback),
};

module.exports = { vnc };
