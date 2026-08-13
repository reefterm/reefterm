const { ipcRenderer, subscribe } = require('./channel');

const store = {
    status: () => ipcRenderer.invoke('store-status'),
};

// Optional password required to open the app. Main refuses everything else
// while locked, so these are the only calls that answer before unlocking.
const appLock = {
    status: () => ipcRenderer.invoke('app-lock-status'),
    unlock: (password) => ipcRenderer.invoke('app-lock-unlock', password),
    set: (password) => ipcRenderer.invoke('app-lock-set', password),
    change: (current, next) => ipcRenderer.invoke('app-lock-change', { current, next }),
    disable: (password) => ipcRenderer.invoke('app-lock-disable', password),
    lock: () => ipcRenderer.invoke('app-lock-lock'),
    // Fired when main re-locks, so the renderer can drop back to the lock
    // screen without being the thing that decided to.
    onLocked: (callback) => subscribe('app-locked', callback),
};

const hostKeys = {
    onPrompt: (callback) => subscribe('host-key-prompt', callback),
    respond: (requestId, accepted) =>
        ipcRenderer.invoke('host-key-response', { requestId, accepted }),
    list: () => ipcRenderer.invoke('known-hosts-list'),
    forget: (host, port) => ipcRenderer.invoke('known-hosts-forget', { host, port }),
    forgetById: (id) => ipcRenderer.invoke('known-hosts-forget-id', id),
    forgetKey: (id, fingerprint) =>
        ipcRenderer.invoke('known-hosts-forget-key', { id, fingerprint }),
};

module.exports = { store, appLock, hostKeys };
