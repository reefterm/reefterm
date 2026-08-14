const { createRegistry } = require('../../plugins/registry');

/**
 * Which agent can run a conversation.
 *
 * The neutral shape every provider file is written against - `start()`, and
 * optionally `listModels()` - is what lets a second one exist as a sibling
 * file and nothing else; this is the registry that shape is checked against
 * and picked out of. `ai/index.js` (the orchestrator) and `ai/settings.js`
 * (validating a stored `provider` value) both need it, so it lives here
 * rather than in either of them - `settings.js` requiring it out of
 * `ai/index.js` directly would be a circular require, since `index.js`
 * already requires `settings.js`.
 *
 * `import.js`'s host-import sources are the app's other instance of this
 * same idea (a registry of named implementations behind one contract, picked
 * by a string key), built on the same `createRegistry` primitive. See
 * src/main/plugins/registry.js.
 */
function validateProvider(impl, id) {
    if (typeof impl?.start !== 'function') {
        throw new Error(`ai.providers: "${id}" must export a start() function`);
    }
    if (impl.listModels !== undefined && typeof impl.listModels !== 'function') {
        throw new Error(`ai.providers: "${id}"'s listModels must be a function if it has one`);
    }
}

const providers = createRegistry('ai.providers', { validate: validateProvider });
providers.register('claude-code', require('./claude-code'), { name: 'Claude Code' });
providers.register('codex', require('./codex'), { name: 'Codex' });
providers.register('opencode', require('./opencode'), { name: 'OpenCode' });

module.exports = providers;
