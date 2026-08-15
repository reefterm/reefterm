const { contextBridge } = require('electron');

const { hosts, folders, arrange } = require('./hosts');
const { keys } = require('./keys');
const { snippets } = require('./snippets');
const { proxies } = require('./proxies');
const { store, appLock, hostKeys } = require('./lock');
const { ssh, agent, serial, auth } = require('./ssh');
const { tunnels } = require('./tunnels');
const { vnc } = require('./vnc');
const { bmc } = require('./bmc');
const { rdp } = require('./rdp');
const { importer } = require('./import');
const { backup } = require('./backup');
const { syncConnection } = require('./sync');
const { monitor, cloudSnapshot } = require('./monitoring');
const { sftp, transfers, remoteEdit, local } = require('./sftp');
const { activity, sessionLog } = require('./audit');
const {
    appearance, links, system, startup, devtools, dialog, clipboard, screenshot, window,
} = require('./os-integration');
const { updates } = require('./updates');
const { ai } = require('./assistant');
const { plugins } = require('./plugins');

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
    devtools,
    dialog,
    clipboard,
    screenshot,
    updates,
    ai,
    plugins,

    // Which OS this is, for the handful of places the interface has to differ:
    // macOS draws its own window controls, and Pageant and the registry
    // importers only exist on Windows. Read once at load; it cannot change.
    platform: process.platform,

    window,
});
