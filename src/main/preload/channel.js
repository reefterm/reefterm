const { ipcRenderer } = require('electron');

/** Subscribe to a main-process event, returning an unsubscribe function. */
function subscribe(channel, callback) {
    const listener = (event, payload) => callback(payload);
    ipcRenderer.on(channel, listener);
    return () => ipcRenderer.removeListener(channel, listener);
}

module.exports = { ipcRenderer, subscribe };
