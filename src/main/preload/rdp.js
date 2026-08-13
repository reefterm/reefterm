const { ipcRenderer, subscribe } = require('./channel');

// Remote desktop over RDP. Unlike `vnc`, `open` returns the credentials
// with the address: RDP authenticates with CredSSP inside the WASM client,
// so the handshake cannot be completed in main the way RFB's is. The view
// is written to use them once and not retain them; see src/main/rdp.js.
const rdp = {
    get: (paneId) => ipcRenderer.invoke('rdp-get', paneId),
    open: (paneId, hostId) => ipcRenderer.invoke('rdp-open', { paneId, hostId }),
    close: (paneId, hostId) => ipcRenderer.invoke('rdp-close', { paneId, hostId }),

    // The IronRDP module itself, which a `file://` renderer cannot fetch.
    wasm: () => ipcRenderer.invoke('rdp-wasm'),

    onUpdate: (callback) => subscribe('rdp-update', callback),
};

module.exports = { rdp };
