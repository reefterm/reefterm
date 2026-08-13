const { ipcRenderer, subscribe } = require('./channel');

const updates = {
    // `status.mode` says which of the two shapes this is. On a build main
    // can get a signature checked for, these move a real installer along.
    // On one it cannot, they are a notice and a link and nothing else, and
    // the renderer has to say so rather than promise an install.
    status: () => ipcRenderer.invoke('updates-status'),
    // The button. Rate limited in main, which is why it answers with a
    // message rather than just a status.
    check: () => ipcRenderer.invoke('updates-check'),
    // The retry. Nothing normally calls it: an available update is already
    // downloading by the time the renderer hears about it.
    download: () => ipcRenderer.invoke('updates-download'),
    // Closes the app. Nothing after this resolves, because there is
    // nothing left to resolve into.
    install: () => ipcRenderer.invoke('updates-install'),
    open: () => ipcRenderer.invoke('updates-open'),
    dismiss: () => ipcRenderer.invoke('updates-dismiss'),
    // The daily check is not one the renderer asked for, a check started
    // from Settings has to reach the bell in the title bar, and download
    // progress is nobody's request at all.
    onState: (callback) => subscribe('updates-state', callback),
};

module.exports = { updates };
