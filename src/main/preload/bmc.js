const { ipcRenderer, subscribe } = require('./channel');

// A service processor's own web interface, in a `<webview>`.
//
// `open` returns a URL and a session partition and nothing else: unlike
// `rdp`, no credential crosses here at all. Main logs the guest page in
// itself, either by filling the vendor's form through the guest's own
// webContents or by answering an HTTP Basic challenge, so the BMC password
// never reaches this side of the bridge. See src/main/bmc.js.
//
// `attach` is the one call that goes the other way: the `<webview>` element
// lives here, so its webContents id has to be handed to main before main
// can drive it.
const bmc = {
    get: (paneId) => ipcRenderer.invoke('bmc-get', paneId),
    open: (paneId, hostId) => ipcRenderer.invoke('bmc-open', { paneId, hostId }),
    attach: (paneId, webContentsId) =>
        ipcRenderer.invoke('bmc-attach', { paneId, webContentsId }),
    login: (paneId) => ipcRenderer.invoke('bmc-login', paneId),
    close: (paneId, hostId) => ipcRenderer.invoke('bmc-close', { paneId, hostId }),

    // Trust on first use for the board's self-signed certificate, in the
    // shape `hostKeys` uses for an SSH host key.
    onCertPrompt: (callback) => subscribe('bmc-cert-prompt', callback),
    respondCert: (requestId, accepted) =>
        ipcRenderer.invoke('bmc-cert-response', { requestId, accepted }),

    onUpdate: (callback) => subscribe('bmc-update', callback),
};

module.exports = { bmc };
