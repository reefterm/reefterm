const store = require('../store');
const tools = require('../ai/tools');

/**
 * What a plugin may ask an app-trusted process to do on its behalf, and the
 * human-readable line the consent screen shows for each one.
 *
 * This is deliberately the same shape and the same instinct as
 * ai/tools.js's catalog: a fixed, named, described set of operations,
 * mediated by trusted code, rather than a plugin (or a model) ever holding
 * a credential or a direct reference to the store. `hosts.list` reuses
 * ai/tools.js's own `publicHost` to strip secrets, rather than growing a
 * second copy of that rule that could quietly drift from the first.
 *
 * plugins/host.js does not know any of this exists - it only knows about
 * whatever `registerCapability` calls this file makes. Adding a capability
 * here never means touching the sandbox mechanism itself.
 */

/** name -> { description, handler } */
const CATALOG = new Map();

function define(name, description, handler) {
    CATALOG.set(name, { description, handler });
}

define(
    'hosts.list',
    'See your saved hosts (name, address, tags - never a password or key)',
    async () => {
        const hosts = await store.getHosts();
        return hosts.map(tools.publicHost);
    }
);

/** Registers every capability in this catalog on a plugin host instance. */
function registerAll(pluginHost) {
    for (const [name, { handler }] of CATALOG) {
        pluginHost.registerCapability(name, handler);
    }
}

function has(name) {
    return CATALOG.has(name);
}

function describe(name) {
    return CATALOG.get(name)?.description || '';
}

/** Every capability a plugin could request, for a consent screen or a manifest validator. */
function list() {
    return [...CATALOG.entries()].map(([name, { description }]) => ({ name, description }));
}

module.exports = { registerAll, has, describe, list };
