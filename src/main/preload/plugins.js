const { ipcRenderer, subscribe } = require('./channel');

const plugins = {
    list: () => ipcRenderer.invoke('plugins-list'),
    rescan: () => ipcRenderer.invoke('plugins-rescan'),
    respondToConsent: (id, approved) => ipcRenderer.invoke('plugins-respond-consent', { id, approved }),
    setEnabled: (id, enabled) => ipcRenderer.invoke('plugins-set-enabled', { id, enabled }),

    // onContributionChange fires per-plugin with that plugin's full current
    // set, so a listener can patch its own copy rather than re-fetch everything.
    listContributions: () => ipcRenderer.invoke('plugins-list-contributions'),
    invokeAction: (id, actionId, args) => ipcRenderer.invoke('plugins-invoke-action', { id, actionId, args }),
    onContributionChange: (callback) => subscribe('plugin-contribution', callback),

    // The credential mapping a settings page reads and edits (see
    // plugins/credentials.js): which saved key or agent, if any, a plugin's
    // host group should connect with. The plugin itself never sees this.
    getCredentialConfig: () => ipcRenderer.invoke('plugins-get-credential-config'),
    setCredentialMapping: (id, group, entry) => ipcRenderer.invoke('plugins-set-credential-mapping', { id, group, entry }),

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
