const { ipcRenderer, subscribe } = require('./channel');

const plugins = {
    list: () => ipcRenderer.invoke('plugins-list'),
    rescan: () => ipcRenderer.invoke('plugins-rescan'),
    respondToConsent: (id, approved) => ipcRenderer.invoke('plugins-respond-consent', { id, approved }),
    setEnabled: (id, enabled) => ipcRenderer.invoke('plugins-set-enabled', { id, enabled }),

    // First-party features (see plugins/builtins.js). setEnabled here takes
    // effect on next launch, not immediately, unlike setEnabled above.
    builtins: {
        list: () => ipcRenderer.invoke('plugins-list-builtins'),
        setEnabled: (id, enabled) => ipcRenderer.invoke('plugins-set-builtin-enabled', { id, enabled }),
    },

    // A plugin's own stdout/stderr, already labelled and persisted to its
    // logs/plugin.log by the main process - this is only for a settings
    // page to tail it live, not the source of truth.
    onLog: (callback) => subscribe('plugin-log', callback),
    onCrash: (callback) => subscribe('plugin-crash', callback),
    onExit: (callback) => subscribe('plugin-exit', callback),
    onStartFailed: (callback) => subscribe('plugin-start-failed', callback),
};

module.exports = { plugins };
