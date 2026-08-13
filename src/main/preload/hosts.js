const { ipcRenderer } = require('./channel');

const hosts = {
    list: () => ipcRenderer.invoke('get-hosts'),
    save: (host) => ipcRenderer.invoke('save-host', host),
    remove: (hostId) => ipcRenderer.invoke('delete-host', hostId),
    // Copied in main, where the credentials are: a copy made by saving the
    // redacted record back would come out unable to log in.
    duplicate: (hostId) => ipcRenderer.invoke('duplicate-host', hostId),
    /**
     * Add and remove tags across several hosts at once:
     * `{ hostIds, add, remove }`. One call however many were selected, so
     * tagging a dozen is a single write rather than a dozen saves.
     */
    tag: (edit) => ipcRenderer.invoke('tag-hosts', edit),

    /**
     * Dial an address that was typed rather than saved: `10.0.0.5`,
     * `root@10.0.0.5:2222`, `box.example.com`.
     *
     * Main parses it and answers `{ success, message, host }`, where the
     * host is an ordinary redacted record that exists for this app run
     * only. Connect it by id like any other; nothing is written to disk,
     * and the login is asked for on the pane while it dials.
     */
    quickConnect: (address) => ipcRenderer.invoke('host-quick-connect', String(address || '')),
};

const folders = {
    list: () => ipcRenderer.invoke('get-folders'),
    save: (folder) => ipcRenderer.invoke('save-folder', folder),
    remove: (folderId) => ipcRenderer.invoke('delete-folder', folderId),
};

/**
 * Where records sit: which folder they belong to and in what order. Spans
 * both collections because one drag can move a folder and renumber the
 * hosts it landed among, and that should be a single write.
 */
const arrange = {
    apply: (changes) => ipcRenderer.invoke('arrange-items', changes),
};

module.exports = { hosts, folders, arrange };
