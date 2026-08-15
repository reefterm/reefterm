const fs = require('fs');
const path = require('path');
const { createRegistry } = require('./registry');

/**
 * First-party features toggleable from Settings > Plugins, gated at the
 * require() boundary rather than sandboxed (this is trusted code - see
 * manager.js/host.js for the community path that needs a process boundary).
 *
 * Reverse-DNS ids like community plugins, with a `builtin.` segment so one
 * reads distinctly from an installed plugin's id at a glance.
 */
const AI_BUILTIN_ID = 'com.reefterm.builtin.ai';

const BUILTINS = [
    {
        id: AI_BUILTIN_ID,
        name: 'AI Assistant',
        description: 'Chat with an AI agent that can inspect and act on your connected sessions.',
    },
];

/** id -> boolean */
function load(filePath) {
    try {
        const raw = JSON.parse(fs.readFileSync(filePath, 'utf8'));
        return raw && typeof raw === 'object' && !Array.isArray(raw) ? raw : {};
    } catch {
        return {};
    }
}

/** Atomic temp+fsync+rename, same pattern as grants.js/vault.js. */
function save(filePath, state) {
    const tmp = `${filePath}.${process.pid}.tmp`;
    fs.mkdirSync(path.dirname(filePath), { recursive: true });
    const fd = fs.openSync(tmp, 'w');
    try {
        fs.writeFileSync(fd, JSON.stringify(state, null, 2), 'utf8');
        fs.fsyncSync(fd);
    } finally {
        fs.closeSync(fd);
    }
    fs.renameSync(tmp, filePath);
}

function createBuiltinsManager({ definitions = BUILTINS, stateFile }) {
    const registry = createRegistry('builtins');
    const definitionById = new Map(definitions.map(def => [def.id, def]));

    // No real implementation to register - the point is that a disabled
    // builtin's module is never require()'d, so only a description goes in.
    for (const def of definitions) {
        registry.register(def.id, {}, { name: def.name });
    }

    // Synchronous, not inside init(): isEnabled() must already be correct
    // the instant require('../plugins') resolves, before ipc/index.js's
    // register() runs.
    const persisted = load(stateFile);
    for (const [id, enabled] of Object.entries(persisted)) {
        registry.setEnabled(id, enabled);
    }

    // What register() actually saw and acted on - pendingRestart is measured
    // against this, not a renderer-side guess, so toggling back to this
    // value clears it on its own.
    const bootState = new Map(registry.list().map(entry => [entry.id, entry.enabled]));

    function persist() {
        const state = {};
        for (const entry of registry.list()) state[entry.id] = entry.enabled;
        save(stateFile, state);
    }

    function list() {
        return registry.list().map(entry => ({
            ...entry,
            description: definitionById.get(entry.id)?.description || '',
            pendingRestart: entry.enabled !== bootState.get(entry.id),
        }));
    }

    function isEnabled(id) {
        return Boolean(registry.get(id));
    }

    function setEnabled(id, enabled) {
        if (!registry.setEnabled(id, enabled)) {
            return { success: false, message: 'That built-in feature is not known' };
        }
        persist();
        return { success: true };
    }

    // Everything already loaded synchronously above; kept only for call-site
    // symmetry with the community-plugin manager's init().
    function init() {
        return list();
    }

    return { init, list, isEnabled, setEnabled };
}

module.exports = { createBuiltinsManager, BUILTINS, AI_BUILTIN_ID };
