const { ipcRenderer, subscribe } = require('./channel');

/**
 * Watching whether hosts are still answering.
 *
 * Everything here is main's: it owns the timer, the states and the Windows
 * notifications, because a renderer that was reloading would be a renderer
 * not noticing a server go down. This side reads the states and changes the
 * settings, and never learns an address it did not already have from the
 * host list.
 *
 * There is no list of past alerts to read. A host crossing between states
 * raises a notification and writes an activity entry, and the activity log
 * is where it stays; keeping a second copy in memory for a panel to show
 * would be two records of one thing.
 */
const monitor = {
    status: () => ipcRenderer.invoke('monitor-status'),
    configure: (patch) => ipcRenderer.invoke('monitor-configure', patch || {}),
    // Sweeps now, at the next opportunity rather than the next interval.
    checkNow: () => ipcRenderer.invoke('monitor-check-now'),

    // Every sweep and every state change. Nothing in the renderer asked for
    // these, which is the point: the host cards and the bell keep up with a
    // timer they do not own.
    onState: (callback) => subscribe('monitor-state', callback),
};

const cloudSnapshot = {
    status: () => ipcRenderer.invoke('cloud-snapshot-status'),
    setEnabled: (enabled) => ipcRenderer.invoke('cloud-snapshot-set-enabled', enabled),
    push: () => ipcRenderer.invoke('cloud-snapshot-push'),
    pull: () => ipcRenderer.invoke('cloud-snapshot-pull'),
    // Terminal settings live in localStorage, so the renderer is the only
    // side that can see them change.
    reportSettings: (settings) => ipcRenderer.invoke('cloud-snapshot-settings', settings),
    onState: (callback) => subscribe('cloud-snapshot-state', callback),
    // A pull brought settings down from another device.
    onSettings: (callback) => subscribe('cloud-snapshot-settings', callback),
};

module.exports = { monitor, cloudSnapshot };
