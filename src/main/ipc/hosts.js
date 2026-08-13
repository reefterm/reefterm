const store = require('../store');
const { parseAddress } = require('../address');

function register({ handle }) {
    /* ---------------- Store: hosts ---------------- */

    handle('get-hosts', () => store.getHosts());
    handle('save-host', (event, host) => store.saveHost(host));

    /**
     * An address typed into a picker rather than a host chosen from it.
     *
     * Parsed here rather than taken apart in the renderer, for the reason every
     * other record is built in main: what gets dialled is decided on this side
     * of the bridge. What goes back is an ordinary redacted host, held in
     * memory for this app run only, which the pane then connects by id like any
     * other. See store.openQuickConnect.
     */
    handle('host-quick-connect', (event, address) => {
        const parsed = parseAddress(address);
        const host = parsed.ok ? store.openQuickConnect(parsed) : null;

        return host
            ? { success: true, message: '', host }
            : { success: false, message: 'That is not an address this can dial', host: null };
    });

    handle('delete-host', (event, hostId) => store.deleteHost(hostId));
    handle('duplicate-host', (event, hostId) => store.duplicateHost(hostId));
    // Tagging a selection, in one write. Reads nothing but the tags, so it is
    // not a back door into a host record the way a full save would be.
    handle('tag-hosts', (event, payload) => store.tagHosts(payload));

    /* ---------------- Store: folders ---------------- */

    handle('get-folders', () => store.getFolders());
    handle('save-folder', (event, folder) => store.saveFolder(folder));
    handle('delete-folder', (event, folderId) => store.deleteFolder(folderId));

    /* ---------------- Store: arranging ---------------- */

    // One write for a whole drag: moving a card can renumber every card around it.
    handle('arrange-items', (event, changes) => store.arrangeItems(changes));
}

module.exports = { register };
