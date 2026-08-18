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

/** A host in its public shape, minus the folderId - redundant once it is the thing being nested under. */
function publicHostInFolder(host) {
    const { folderId: _folderId, ...rest } = tools.publicHost(host);
    return rest;
}

/**
 * Every host and folder under `parentId`, recursively - the same tree the
 * sidebar itself draws from `folderId`/`parentId`, so a plugin sees the
 * user's own filing rather than a flat dump it has to regroup itself.
 */
function buildFolderNode(parentId, folders, hostsByFolder) {
    return {
        hosts: (hostsByFolder.get(parentId) || []).map(publicHostInFolder),
        folders: folders
            .filter(folder => (folder.parentId || '') === parentId)
            .map(folder => ({
                id: folder.id,
                name: folder.name,
                ...buildFolderNode(folder.id, folders, hostsByFolder),
            })),
    };
}

define(
    'hosts.list',
    'See your saved hosts (name, address, tags - never a password or key), '
        + 'nested by folder, or pass a folder id for just that folder\'s contents',
    async (folderId) => {
        const hosts = await store.getHosts();
        const folders = await store.getFolders();

        const hostsByFolder = new Map();
        for (const host of hosts) {
            const key = host.folderId || '';
            if (!hostsByFolder.has(key)) hostsByFolder.set(key, []);
            hostsByFolder.get(key).push(host);
        }

        const requested = String(folderId || '').trim();
        if (!requested) return buildFolderNode('', folders, hostsByFolder);

        const folder = folders.find(f => f.id === requested);
        if (!folder) throw new Error(`No folder with id "${requested}"`);
        return { id: folder.id, name: folder.name, ...buildFolderNode(folder.id, folders, hostsByFolder) };
    }
);

define(
    'hosts.tags',
    'See the distinct tags used across your saved hosts',
    async () => {
        const hosts = await store.getHosts();
        const tags = new Set();
        for (const host of hosts) {
            for (const tag of host.tags || []) tags.add(tag);
        }
        return [...tags].sort();
    }
);

define(
    'snippets.list',
    'See your saved command snippets (name, commands, tags - snippets never hold secrets)',
    async () => {
        const snippets = await store.getSnippets();
        return snippets.map(({ id, name, kind, steps, chain, command, description, tags, hostIds, runImmediately }) => (
            { id, name, kind, steps, chain, command, description, tags, hostIds, runImmediately }
        ));
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
