const store = require('../store');

function register({ handle }) {
    /* ---------------- Store: snippets ---------------- */

    // Normalised in the store, so a malformed record from the renderer cannot
    // reach the palette or be written to disk in a shape nothing can read.
    handle('get-snippets', () => store.getSnippets());
    handle('save-snippet', (event, snippet) => store.saveSnippet(snippet));
    handle('delete-snippet', (event, snippetId) => store.deleteSnippet(snippetId));
}

module.exports = { register };
