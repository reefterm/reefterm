const fs = require('fs');
const path = require('path');
const { isInsideLocal } = require('../local-path');

/**
 * What a plugin declares about itself, and the rules that keep the
 * declaration honest.
 *
 * The one rule everything else here exists to enforce: a plugin's identity
 * is its *folder name*, never something read out of its own manifest.
 * `plugins/manager.js` persists granted capabilities keyed by plugin id, so
 * if the manifest's own `id` field were trusted, a brand new plugin could
 * simply declare the id of one a person already approved and inherit its
 * capabilities with no fresh consent at all. The folder name is the one
 * thing here that is not the plugin's own content - it is decided at
 * install time by whoever puts the directory there - so it is what
 * `manager.js` actually keys anything on. The manifest's `id` field still
 * has to be present and has to match, but only so a mismatch is a loud,
 * specific failure ("this manifest disagrees with where it was found")
 * rather than something to quietly paper over.
 */

/**
 * Reverse-DNS, lowercase, at least two dot-separated segments, hyphens
 * allowed within a segment. This string becomes a literal directory name,
 * so it is validated before it is ever used as one: no `..`, no path
 * separator, no leading or trailing dot, nothing this regex does not
 * explicitly allow.
 */
const ID_PATTERN = /^[a-z0-9]+(-[a-z0-9]+)*(\.[a-z0-9]+(-[a-z0-9]+)*)+$/;

/** Reserved on Windows even as part of a longer name; see local-path.js's WINDOWS_RESERVED. */
const RESERVED_SEGMENT = /^(con|prn|aux|nul|com[1-9]|lpt[1-9])$/i;

/** Held for the app's own eventual built-in-as-plugin work; a drop-in plugin may not claim it. */
const RESERVED_NAMESPACE = 'com.reefterm';

/** Every plugin gets exactly these, created if missing rather than merely required. */
const STRUCTURE = ['config', 'data', 'logs'];

function isValidId(id) {
    if (typeof id !== 'string' || !ID_PATTERN.test(id)) return false;
    return !id.split('.').some(segment => RESERVED_SEGMENT.test(segment));
}

function isReservedNamespace(id) {
    return id === RESERVED_NAMESPACE || id.startsWith(`${RESERVED_NAMESPACE}.`);
}

/**
 * Read and validate one plugin's manifest.
 *
 * `pluginDir`'s own basename is taken as the plugin's id; nothing here ever
 * trusts the id the manifest itself claims beyond checking that the two
 * agree. Returns `{ ok: true, manifest }` or `{ ok: false, error }` -
 * never throws, so one malformed plugin cannot stop a scan of the rest of
 * them from completing.
 *
 * `allowReservedNamespace` exists for the app's own future built-in-as-plugin
 * loading, which is not this path: a plugin found by scanning the user's own
 * plugins directory is a drop-in by definition, and defaults to refusing the
 * reserved namespace.
 */
function readManifest(pluginDir, { allowReservedNamespace = false } = {}) {
    const id = path.basename(pluginDir);

    if (!isValidId(id)) {
        return { ok: false, error: `"${id}" is not a valid plugin id (expected reverse-DNS, e.g. "com.example.myplugin")` };
    }
    if (isReservedNamespace(id) && !allowReservedNamespace) {
        return { ok: false, error: `"${id}" uses the "${RESERVED_NAMESPACE}" namespace, which is reserved` };
    }

    let raw;
    try {
        raw = JSON.parse(fs.readFileSync(path.join(pluginDir, 'plugin.json'), 'utf8'));
    } catch (error) {
        return { ok: false, error: `Could not read plugin.json: ${error.message}` };
    }

    for (const field of ['id', 'name', 'version', 'entry']) {
        if (typeof raw[field] !== 'string' || !raw[field]) {
            return { ok: false, error: `plugin.json is missing a "${field}" string` };
        }
    }
    if (!Array.isArray(raw.capabilities) || raw.capabilities.some(name => typeof name !== 'string' || !name)) {
        return { ok: false, error: 'plugin.json\'s "capabilities" must be an array of non-empty strings' };
    }
    if (raw.id !== id) {
        return { ok: false, error: `plugin.json declares id "${raw.id}", but is installed as "${id}"` };
    }

    const entryPath = path.resolve(pluginDir, raw.entry);
    if (!isInsideLocal(pluginDir, entryPath)) {
        return { ok: false, error: `"entry" must point inside the plugin's own directory, not "${raw.entry}"` };
    }

    return {
        ok: true,
        manifest: {
            id,
            name: raw.name,
            version: raw.version,
            description: typeof raw.description === 'string' ? raw.description : '',
            entryPath,
            capabilities: [...new Set(raw.capabilities)],
        },
    };
}

/** Creates config/, data/ and logs/ under a plugin's directory if they are not already there. */
function ensureStructure(pluginDir) {
    for (const sub of STRUCTURE) {
        fs.mkdirSync(path.join(pluginDir, sub), { recursive: true });
    }
}

module.exports = {
    ID_PATTERN,
    STRUCTURE,
    RESERVED_NAMESPACE,
    isValidId,
    isReservedNamespace,
    readManifest,
    ensureStructure,
};
