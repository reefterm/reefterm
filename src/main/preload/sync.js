const { ipcRenderer, subscribe } = require('./channel');

// A connection to a self-hosted sync server -- optional, and not an
// account this app manages. No secret ever crosses this bridge: main
// holds the passphrase, the recovery code and the session token; the
// renderer only learns the connection's status.
const syncConnection = {
    status: () => ipcRenderer.invoke('sync-connection-status'),
    configure: (serverUrl) => ipcRenderer.invoke('sync-connection-configure', serverUrl),
    register: (email, passphrase) => ipcRenderer.invoke('sync-connection-register', { email, passphrase }),
    login: (email, passphrase) => ipcRenderer.invoke('sync-connection-login', { email, passphrase }),
    logout: () => ipcRenderer.invoke('sync-connection-logout'),
    refresh: () => ipcRenderer.invoke('sync-connection-refresh'),
    unlockWithRecoveryCode: (recoveryCode) =>
        ipcRenderer.invoke('sync-connection-unlock-with-recovery-code', recoveryCode),
    changePassphrase: (currentPassphrase, newPassphrase) =>
        ipcRenderer.invoke('sync-connection-change-passphrase', { currentPassphrase, newPassphrase }),
    // Recovering with no session at all: an emailed token plus the
    // account's recovery code, required together.
    recoverStart: (email) => ipcRenderer.invoke('sync-connection-recover-start', email),
    recoverComplete: (email, token, recoveryCode, newPassphrase) => ipcRenderer.invoke(
        'sync-connection-recover-complete', { email, token, recoveryCode, newPassphrase },
    ),
    // Connecting or disconnecting from Settings has to reach the sidebar,
    // which did not ask for it.
    onState: (callback) => subscribe('sync-connection-state', callback),
};

module.exports = { syncConnection };
