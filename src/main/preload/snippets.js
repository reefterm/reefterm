const { ipcRenderer } = require('./channel');

const snippets = {
    list: () => ipcRenderer.invoke('get-snippets'),
    save: (snippet) => ipcRenderer.invoke('save-snippet', snippet),
    remove: (snippetId) => ipcRenderer.invoke('delete-snippet', snippetId),
};

module.exports = { snippets };
