import { useEffect, useState, useCallback } from 'react';

/**
 * First-party features (see plugins/builtins.js) and whether any differ from
 * what loaded at boot (`pendingRestart`, computed by main). Shared module
 * state like useMonitor.js, not per-instance like usePlugins.js: the
 * settings page and the app-wide restart banner show the same one answer.
 */

let cache = null;
const listeners = new Set();
let settled = false;
let fetching = false;
let version = 0;

function emit() {
    version += 1;
    for (const listener of listeners) listener(version);
}

function publish(next) {
    cache = next;
    settled = true;
    emit();
}

function ensureLoaded() {
    if (!window.api?.plugins?.builtins) {
        // Emit only on the transition: a mount's own setVersion(version)
        // right after this call is a no-op if the value hasn't moved, so a
        // listener already waiting needs telling explicitly.
        if (!settled) { settled = true; emit(); }
        return;
    }
    if (cache || fetching) return;

    fetching = true;
    window.api.plugins.builtins.list()
        .then(publish)
        .catch(() => {})
        .finally(() => {
            fetching = false;
            settled = true;
            emit();
        });
}

/** Test-only: clears the shared cache between tests. */
export function __resetForTests() {
    cache = null;
    listeners.clear();
    settled = false;
    fetching = false;
    version = 0;
}

export default function useBuiltinPlugins() {
    const [, setVersion] = useState(version);

    useEffect(() => {
        listeners.add(setVersion);
        ensureLoaded();
        setVersion(version);

        return () => listeners.delete(setVersion);
    }, []);

    const setEnabled = useCallback(async (id, enabled) => {
        const result = await window.api.plugins.builtins.setEnabled(id, enabled);
        const list = await window.api.plugins.builtins.list();
        publish(list);
        return result;
    }, []);

    const builtins = cache || [];

    return {
        builtins,
        ready: settled,
        needsRestart: builtins.some(builtin => builtin.pendingRestart),
        setEnabled,
    };
}
