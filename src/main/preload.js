const { contextBridge } = require('electron');

const { hosts, folders, arrange } = require('./preload/hosts');
const { keys } = require('./preload/keys');
const { snippets } = require('./preload/snippets');
const { proxies } = require('./preload/proxies');
const { store, appLock, hostKeys } = require('./preload/lock');
const { ssh, agent, serial, auth } = require('./preload/ssh');
const { tunnels } = require('./preload/tunnels');
const { vnc } = require('./preload/vnc');
const { bmc } = require('./preload/bmc');
const { rdp } = require('./preload/rdp');
const { importer } = require('./preload/import');
const { backup } = require('./preload/backup');
const { syncConnection } = require('./preload/sync');
const { monitor, cloudSnapshot } = require('./preload/monitoring');
const { sftp, transfers, remoteEdit, local } = require('./preload/sftp');
const { activity, sessionLog } = require('./preload/audit');
const {
    appearance, links, system, startup, dialog, clipboard, screenshot, window,
} = require('./preload/os-integration');
const { updates } = require('./preload/updates');
const { ai } = require('./preload/assistant');

contextBridge.exposeInMainWorld('api', {
    hosts,
    folders,
    arrange,
    keys,
    snippets,
    proxies,
    store,
    activity,
    sessionLog,
    appLock,
    ssh,
    agent,
    serial,
    auth,
    hostKeys,
    sftp,
    transfers,
    tunnels,
    vnc,
    rdp,
    bmc,
    appearance,
    importer,
    backup,
    syncConnection,
    monitor,
    cloudSnapshot,
    remoteEdit,
    local,
    links,
    system,
    startup,
    dialog,
    clipboard,
    screenshot,
    updates,
    ai,

    // Which OS this is, for the handful of places the interface has to differ:
    // macOS draws its own window controls, and Pageant and the registry
    // importers only exist on Windows. Read once at load; it cannot change.
    platform: process.platform,

    window,
});
