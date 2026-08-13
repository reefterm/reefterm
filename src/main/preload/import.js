const { ipcRenderer } = require('./channel');

const importer = {
    paths: () => ipcRenderer.invoke('import-paths'),
    // Which of the importable apps (OpenSSH, PuTTY, KiTTY, MobaXterm)
    // actually have sessions on this machine.
    detect: () => ipcRenderer.invoke('import-detect'),
    scan: (options) => ipcRenderer.invoke('import-scan', options || {}),
    apply: (options) => ipcRenderer.invoke('import-apply', options || {}),
};

module.exports = { importer };
