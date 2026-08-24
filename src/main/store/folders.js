const { randomUUID } = require('crypto');
const activity = require('../activity');
const core = require('./core');

/* ------------------------------------------------------------------ *
 * Folders
 * ------------------------------------------------------------------ */

function getFolders() {
    return core.load().folders;
}

function saveFolder(folder) {
    const store = core.load();
    const id = folder.id || `folder-${randomUUID()}`;
    const index = store.folders.findIndex(f => f.id === id);
    const existing = index >= 0 ? store.folders[index] : {};
    const record = { ...existing, ...folder, id };

    if (index >= 0) store.folders[index] = record;
    else store.folders.push(record);

    core.persist();

    const changes = activity.diff(existing, record);
    if (index < 0 || changes.length > 0) {
        activity.record({
            category: 'data',
            action: index < 0 ? 'folder.create' : 'folder.update',
            target: record.name || id,
            changes: index < 0 ? [] : changes,
        });
    }

    return record;
}

/** Deleting a folder reparents its contents rather than destroying them. */
function deleteFolder(folderId) {
    const store = core.load();
    const folder = store.folders.find(f => f.id === folderId);
    if (!folder) return false;

    const parentId = folder.parentId || '';

    store.folders = store.folders
        .filter(f => f.id !== folderId)
        .map(f => (f.parentId === folderId ? { ...f, parentId } : f));

    store.hosts = store.hosts.map(h => (h.folderId === folderId ? { ...h, folderId: parentId } : h));

    core.persist();

    activity.record({
        category: 'data',
        action: 'folder.delete',
        target: folder.name || folderId,
        detail: 'Its contents moved up a level',
    });

    return true;
}

/* ------------------------------------------------------------------ *
 * Arranging
 *
 * Where records sit, as opposed to what they are. Dragging a card is the one
 * edit that can touch a hundred records at once (reordering a folder renumbers
 * every card in it), so it gets a path of its own rather than a hundred saves.
 * ------------------------------------------------------------------ */

/** Would filing `folderId` under `parentId` put it inside itself? */
function wouldCycle(folders, folderId, parentId) {
    const seen = new Set();
    let current = parentId || '';

    while (current) {
        if (current === folderId) return true;
        // A loop already in the file would otherwise spin here forever.
        if (seen.has(current)) return true;
        seen.add(current);
        current = folders.find(f => f.id === current)?.parentId || '';
    }

    return false;
}

/**
 * Apply a drag-and-drop rearrangement.
 *
 * Only placement is read from the payload: which folder a record belongs to,
 * and its position within it. Nothing else on the incoming objects is looked
 * at, so a rename or a credential cannot be smuggled through this path even
 * though it accepts a list of records straight from the renderer.
 */
function arrangeItems({ hosts = [], folders = [] } = {}) {
    const store = core.load();
    const foldersById = new Map(store.folders.map(folder => [folder.id, folder]));
    const hostsById = new Map(store.hosts.map(host => [host.id, host]));
    const moves = [];
    let changed = false;

    // Folders first: the cycle guard walks the parent chain, so it has to see
    // the tree as it will be, not as it was.
    for (const change of Array.isArray(folders) ? folders : []) {
        const record = foldersById.get(change?.id);
        if (!record) continue;

        if (change.parentId !== undefined) {
            const parentId = String(change.parentId || '');
            if (parentId && !foldersById.has(parentId)) continue;

            if (wouldCycle(store.folders, record.id, parentId)) {
                console.error(`Refusing to file folder ${record.id} inside itself`);
                continue;
            }

            if ((record.parentId || '') !== parentId) {
                moves.push({
                    action: 'folder.move',
                    target: record.name || record.id,
                    detail: parentId
                        ? `Moved into ${foldersById.get(parentId)?.name || parentId}`
                        : 'Moved to the top level',
                });
            }
            record.parentId = parentId;
        }

        if (Number.isFinite(change.order)) record.order = change.order;
        changed = true;
    }

    for (const change of Array.isArray(hosts) ? hosts : []) {
        const record = hostsById.get(change?.id);
        if (!record) continue;

        if (change.folderId !== undefined) {
            const folderId = String(change.folderId || '');
            if (folderId && !foldersById.has(folderId)) continue;

            if ((record.folderId || '') !== folderId) {
                moves.push({
                    action: 'host.move',
                    target: record.name || record.host || record.id,
                    subject: core.describeAddress(record),
                    hostId: record.id,
                    hostName: record.name || '',
                    detail: folderId
                        ? `Moved into ${foldersById.get(folderId)?.name || folderId}`
                        : 'Moved to the top level',
                });
            }
            record.folderId = folderId;
        }

        if (Number.isFinite(change.order)) record.order = change.order;
        changed = true;
    }

    if (!changed) return true;
    core.persist();

    // Only the moves are logged. A reorder is a preference about a screen, and
    // recording one line per card would bury the edits worth reading.
    for (const move of moves) activity.record({ category: 'data', ...move });

    return true;
}

module.exports = {
    getFolders,
    saveFolder,
    deleteFolder,
    arrangeItems,
};
