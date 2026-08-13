const { ipcRenderer } = require('./channel');

/**
 * Saved proxies: SOCKS5, SOCKS4 and HTTP CONNECT servers a host can be
 * dialled through, whatever it speaks once it is connected.
 *
 * A proxy's password comes back only as `hasPassword`, like every other
 * stored secret. It goes the other way when it is first typed, which is the
 * only direction a secret ever travels, and `test` may carry one for the same
 * reason: checking settings that have not been saved yet is most of what
 * checking is for.
 */
const proxies = {
    list: () => ipcRenderer.invoke('get-proxies'),
    save: (record) => ipcRenderer.invoke('save-proxy', record),
    remove: (proxyId) => ipcRenderer.invoke('delete-proxy', proxyId),
    duplicate: (proxyId) => ipcRenderer.invoke('duplicate-proxy', proxyId),
    // `{ proxyId }` for a saved record, `{ proxy }` for a draft.
    test: (payload) => ipcRenderer.invoke('proxies-test', payload || {}),
};

module.exports = { proxies };
