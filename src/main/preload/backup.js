const { ipcRenderer } = require('./channel');

const backup = {
    // Main owns the file dialogs and the decrypted payload; only the
    // passphrase goes in and only counts come back.
    export: (passphrase) => ipcRenderer.invoke('backup-export', { passphrase }),
    inspect: (passphrase, filePath) =>
        ipcRenderer.invoke('backup-inspect', { passphrase, filePath }),
    restore: (token, overwrite) =>
        ipcRenderer.invoke('backup-restore', { token, overwrite }),
    discard: (token) => ipcRenderer.invoke('backup-discard', token),
};

module.exports = { backup };
