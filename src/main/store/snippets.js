const { normalizeSnippet, normalizeSnippets } = require('../snippet-config');
const activity = require('../activity');
const core = require('./core');

/* ------------------------------------------------------------------ *
 * Snippets
 *
 * Global rather than hung off a host: a snippet is a command you know, and it
 * is worth having on every box that has the tool. `hostIds` narrows one down
 * when it really is specific to a few.
 *
 * Deleting a host deliberately leaves snippets alone. An id that matches no
 * host simply never matches, so the snippet stops offering itself rather than
 * quietly widening to every host, and it is still listed in the library where
 * its scope can be seen and fixed.
 * ------------------------------------------------------------------ */

function getSnippets() {
    return normalizeSnippets(core.load().snippets);
}

function saveSnippet(snippet) {
    const store = core.load();
    const record = normalizeSnippet(snippet);
    const index = store.snippets.findIndex(entry => entry.id === record.id);
    const existing = index >= 0 ? store.snippets[index] : {};

    if (index >= 0) store.snippets[index] = record;
    else store.snippets.push(record);

    core.persist();

    const changes = activity.diff(existing, record);
    if (index < 0 || changes.length > 0) {
        activity.record({
            category: 'data',
            action: index < 0 ? 'snippet.create' : 'snippet.update',
            target: record.name || record.id,
            changes: index < 0 ? [] : changes,
        });
    }

    return record;
}

function deleteSnippet(snippetId) {
    const store = core.load();
    const removed = store.snippets.find(entry => entry.id === snippetId);
    store.snippets = store.snippets.filter(entry => entry.id !== snippetId);
    core.persist();

    if (removed) {
        activity.record({
            category: 'data',
            action: 'snippet.delete',
            target: removed.name || snippetId,
        });
    }

    return true;
}

module.exports = {
    getSnippets,
    saveSnippet,
    deleteSnippet,
};
