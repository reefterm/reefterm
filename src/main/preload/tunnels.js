const { ipcRenderer, subscribe } = require('./channel');

const tunnels = {
    list: (tabId) => ipcRenderer.invoke('tunnels-list', tabId),
    sync: (tabId, hostId) => ipcRenderer.invoke('tunnels-sync', { tabId, hostId }),
    start: (tabId, tunnelId) => ipcRenderer.invoke('tunnels-start', { tabId, tunnelId }),
    stop: (tabId, tunnelId) => ipcRenderer.invoke('tunnels-stop', { tabId, tunnelId }),
    startAll: (tabId) => ipcRenderer.invoke('tunnels-start-all', tabId),
    stopAll: (tabId) => ipcRenderer.invoke('tunnels-stop-all', tabId),

    onUpdate: (callback) => subscribe('tunnels-update', callback),
};

module.exports = { tunnels };
