const { ipcRenderer, subscribe } = require('./channel');

const appearance = {
    // Main owns the picker and the reading; the renderer gets a data URL
    // for an image the user chose, or a reason it could not have one.
    chooseLogo: () => ipcRenderer.invoke('choose-logo-image'),
};

const links = {
    // Main allowlists the scheme; a link out of a terminal is untrusted input.
    open: (url) => ipcRenderer.invoke('open-external', url),
};

const system = {
    // Machine woke from sleep or the screen was unlocked.
    onResume: (callback) => subscribe('system-resume', callback),
};

/**
 * Whether the app launches itself when the machine starts.
 *
 * The system holds the answer (a Run key entry on Windows, a login item on
 * macOS), so `status` asks it rather than reading a setting of ours, and
 * both calls answer with `supported` and a reason: a development run and a
 * platform with no login items are both switches that cannot be offered.
 */
const startup = {
    status: () => ipcRenderer.invoke('startup-status'),
    setEnabled: (enabled) => ipcRenderer.invoke('startup-set-enabled', enabled),
};

const devtools = {
    status: () => ipcRenderer.invoke('devtools-status'),
};

const dialog = {
    save: (options) => ipcRenderer.invoke('show-save-dialog', options || {}),
    open: (options) => ipcRenderer.invoke('show-open-dialog', options || {}),
};

const clipboard = {
    readText: () => ipcRenderer.invoke('clipboard-read-text'),
    writeText: (text) => ipcRenderer.invoke('clipboard-write-text', text),
};

const screenshot = {
    capture: (options) => ipcRenderer.invoke('screenshot-capture', options),
    get: (id) => ipcRenderer.invoke('screenshot-get', id),
    copy: (id) => ipcRenderer.invoke('screenshot-copy', id),
    save: (id) => ipcRenderer.invoke('screenshot-save', id),
    reveal: (filePath) => ipcRenderer.invoke('screenshot-reveal', filePath),
    close: () => ipcRenderer.invoke('screenshot-close'),
};

const windowControls = {
    minimize: () => ipcRenderer.send('window-minimize'),
    maximize: () => ipcRenderer.send('window-maximize'),
    close: () => ipcRenderer.send('window-close'),
    reload: () => ipcRenderer.send('reload-window'),
    toggleDevTools: () => ipcRenderer.send('open-devtools'),
    quit: () => ipcRenderer.send('force-quit'),
    // A full process restart, not a renderer reload.
    restart: () => ipcRenderer.send('app-restart'),
};

module.exports = { appearance, links, system, startup, devtools, dialog, clipboard, screenshot, window: windowControls };
