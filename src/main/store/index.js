const core = require('./core');
const hosts = require('./hosts');
const desktop = require('./desktop');
const monitoring = require('./monitoring');
const proxies = require('./proxies');
const folders = require('./folders');
const keys = require('./keys');
const snippets = require('./snippets');
const backup = require('./backup');

module.exports = {
    load: core.load,
    isEncryptionAvailable: core.isEncryptionAvailable,
    onChanged: core.onChanged,

    exportAll: backup.exportAll,
    importAll: backup.importAll,
    previewImport: backup.previewImport,

    getHosts: hosts.getHosts,
    saveHost: hosts.saveHost,
    deleteHost: hosts.deleteHost,
    duplicateHost: hosts.duplicateHost,
    tagHosts: hosts.tagHosts,
    describeHost: hosts.describeHost,
    openQuickConnect: hosts.openQuickConnect,
    rememberQuickConnect: hosts.rememberQuickConnect,
    forgetQuickConnects: hosts.forgetQuickConnects,
    resolveCredentials: hosts.resolveCredentials,
    resolveChain: hosts.resolveChain,
    MAX_JUMP_HOPS: hosts.MAX_JUMP_HOPS,
    getHostProtocol: hosts.getHostProtocol,
    getHostTunnels: hosts.getHostTunnels,

    resolveDesktop: desktop.resolveDesktop,
    getHostDesktop: desktop.getHostDesktop,
    resolveBmc: desktop.resolveBmc,
    getHostBmc: desktop.getHostBmc,
    trustBmcCert: desktop.trustBmcCert,

    getMonitorTargets: monitoring.getMonitorTargets,
    listMonitoredHosts: monitoring.listMonitoredHosts,

    getProxies: proxies.getProxies,
    saveProxy: proxies.saveProxy,
    deleteProxy: proxies.deleteProxy,
    duplicateProxy: proxies.duplicateProxy,
    resolveProxyChain: proxies.resolveProxyChain,
    resolveTestChain: proxies.resolveTestChain,

    getFolders: folders.getFolders,
    saveFolder: folders.saveFolder,
    deleteFolder: folders.deleteFolder,
    arrangeItems: folders.arrangeItems,

    getKeys: keys.getKeys,
    saveKey: keys.saveKey,
    deleteKey: keys.deleteKey,

    getSnippets: snippets.getSnippets,
    saveSnippet: snippets.saveSnippet,
    deleteSnippet: snippets.deleteSnippet,
};
