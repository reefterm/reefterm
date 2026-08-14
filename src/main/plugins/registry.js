/**
 * A named, validated, enable/disable-able collection of implementations,
 * picked by an id string.
 *
 * This is the one primitive every extension point in the app is meant to be
 * built from, rather than each feature growing its own hand-rolled version:
 * before this, the AI providers were a bare object literal keyed by name, and
 * the host importers were an `if (source === 'putty') ... else if (...)`
 * chain. Both were the same idea, written twice, with no way to tell a
 * caller "that name is not registered" apart from "that name is registered
 * but off" and no shared place to enforce that a registered implementation
 * actually has the shape callers assume.
 *
 * Deliberately small. This does not load anything from disk, does not know
 * what a "plugin" is, and does not sandbox anything - it is the bookkeeping
 * a real plugin host would sit on top of, built first because both of the
 * app's existing extension points need exactly this and nothing more yet.
 */

/**
 * @param {string} name - what this registry is for, used in error messages
 *   so a bad registration names the extension point it broke rather than
 *   just "this registry".
 * @param {{ validate?: (impl: unknown, id: string) => void }} [options] -
 *   `validate` is called once, at registration time, and should throw with a
 *   message naming what is missing or wrong. Registration-time rather than
 *   lookup-time: a malformed implementation is a programmer error in code
 *   shipped with the app, and those fail loudly at startup, the same as a
 *   missing `require`, rather than surfacing later as "that provider did
 *   nothing" the first time a user picks it.
 */
function createRegistry(name, { validate } = {}) {
    /** id -> { id, impl, enabled, name, enabledByDefault } */
    const entries = new Map();

    /**
     * @param {string} id - looked up by callers; stable, so removing a
     *   registration is a compatibility break for anything that stored it
     *   (a saved setting naming a provider, for one).
     * @param {unknown} impl - whatever shape this registry's callers expect;
     *   checked by `validate` if the registry was given one.
     * @param {{ name?: string, enabledByDefault?: boolean }} [meta] -
     *   `name` is the label a menu shows; `enabledByDefault` (default true)
     *   is only the registration's own opinion; `setEnabled` is what
     *   actually flips it once a persisted setting exists to drive it from.
     */
    function register(id, impl, meta = {}) {
        if (!id || typeof id !== 'string') {
            throw new Error(`${name}: registration needs a non-empty string id`);
        }
        if (entries.has(id)) {
            throw new Error(`${name}: "${id}" is already registered`);
        }
        if (validate) validate(impl, id);

        entries.set(id, {
            id,
            impl,
            name: meta.name || id,
            enabled: meta.enabledByDefault !== false,
        });
    }

    /** The implementation for `id`, or undefined if it is unregistered or disabled. */
    function get(id) {
        const entry = entries.get(id);
        return entry?.enabled ? entry.impl : undefined;
    }

    /** Whether `id` is registered, regardless of enabled state. */
    function has(id) {
        return entries.has(id);
    }

    /**
     * Every registration, enabled or not - for a settings page or a menu that
     * has to show the disabled ones too, greyed out, rather than making them
     * disappear. Never carries `impl`: this is the shape that is safe to
     * hand to a renderer-facing summary. A main-process caller that needs to
     * actually run every registration, disabled ones included - `detect()`
     * across every import source, say, whether or not it is currently on -
     * wants `entries()` instead.
     */
    function list() {
        return [...entries.values()].map(({ id, name: label, enabled }) => ({ id, name: label, enabled }));
    }

    /** As `list()`, but carrying `impl` too. Not renderer-safe; main process only. */
    function all() {
        return [...entries.values()].map(({ id, impl, name: label, enabled }) => ({ id, impl, name: label, enabled }));
    }

    /** Returns false if `id` was never registered, so a caller can tell "off" from "unknown". */
    function setEnabled(id, enabled) {
        const entry = entries.get(id);
        if (!entry) return false;
        entry.enabled = Boolean(enabled);
        return true;
    }

    return { name, register, get, has, list, all, setEnabled };
}

module.exports = { createRegistry };
