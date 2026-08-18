const { load, save } = require('./grants');

/**
 * What connects a plugin's own hosts to a credential, without the plugin
 * ever being told which one.
 *
 * A plugin like Warpgate or Consul already groups its own targets (target
 * groups, service labels); `hosts.externalHost` nodes carry that as an
 * optional `group` string (see ui-extensions.js), and this is the mapping
 * from `(pluginId, group)` to how to authenticate - picked by the user, in
 * Plugin settings, never by the plugin. `resolve()` is the one thing the
 * connect path (ipc/hosts.js) actually calls; everything else here is what
 * a settings page needs to read and edit that mapping.
 *
 * Persisted format, one file for every plugin:
 *   { [pluginId]: { default: Entry, groups: { [group]: Entry } } }
 * where an Entry is { method: 'prompt' | 'agent' | 'key', keyId?: string }.
 *
 * `load`/`save` are reused as-is from grants.js: both files are just a JSON
 * object keyed by plugin id, written atomically, and duplicating that would
 * only be two copies of the same disk-safety logic to keep in sync.
 */

const METHODS = new Set(['prompt', 'agent', 'key']);

/** Whatever was read back off disk (or handed in by a settings page), made safe to act on. */
function normalizeEntry(entry) {
    const method = METHODS.has(entry?.method) ? entry.method : 'prompt';
    if (method !== 'key') return { method };

    // A "key" entry with nothing actually picked is not a mapping - falling
    // back to prompt is the only reading of that which cannot silently try
    // to connect with no credential at all.
    const keyId = typeof entry.keyId === 'string' ? entry.keyId.trim() : '';
    return keyId ? { method, keyId } : { method: 'prompt' };
}

/**
 * How `(pluginId, group)` should authenticate. A group with its own mapping
 * wins; otherwise the plugin's own default; otherwise the safe answer,
 * which is the same "ask" behaviour every quick connect has always had.
 */
function resolve(data, pluginId, group) {
    const plugin = data?.[pluginId];
    if (!plugin) return { method: 'prompt' };

    const groupName = String(group || '').trim();
    if (groupName && plugin.groups?.[groupName]) return normalizeEntry(plugin.groups[groupName]);

    return normalizeEntry(plugin.default);
}

/** Sets one mapping (a named group, or the plugin's own default when `group` is empty) and returns the new state. */
function setMapping(data, pluginId, group, entry) {
    const next = { ...data };
    const groupName = String(group || '').trim();
    const plugin = { default: { method: 'prompt' }, groups: {}, ...next[pluginId] };

    if (groupName) {
        plugin.groups = { ...plugin.groups, [groupName]: normalizeEntry(entry) };
    } else {
        plugin.default = normalizeEntry(entry);
    }

    next[pluginId] = plugin;
    return next;
}

module.exports = { load, save, resolve, setMapping, normalizeEntry };
