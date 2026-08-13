const { ipcRenderer } = require('./channel');

const keys = {
    list: () => ipcRenderer.invoke('get-keys'),
    save: (key) => ipcRenderer.invoke('save-key', key),
    remove: (keyId) => ipcRenderer.invoke('delete-key', keyId),
    generate: (options) => ipcRenderer.invoke('generate-key', options),
    // Pick a key file. Main reads it and keeps the private half, so what
    // comes back is an id to claim it with plus the public halves.
    importFile: (options) => ipcRenderer.invoke('import-key-file', options),
    // Whether this machine can hold a key in its TPM behind Windows Hello,
    // and the enrolment that puts one there.
    helloSupported: () => ipcRenderer.invoke('hello-supported'),
    createHello: (options) => ipcRenderer.invoke('create-hello-key', options),
};

module.exports = { keys };
