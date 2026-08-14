import { useCallback, useEffect, useState } from 'react';

/**
 * The installed plugin list, and the three actions a settings page needs:
 * answer a consent request, flip a plugin on or off, and rescan the plugins
 * folder for anything dropped in since the app started.
 *
 * `list()` is a snapshot from the last rescan, not a push subscription — a
 * plugin's *own* state (crashed, exited, failed to start) can change between
 * rescans, so those four main-process events (see plugins/manager.js and
 * host.js) both refresh the list and are kept around as a short-lived notice
 * per plugin id, since `list()` on its own says a plugin is "crashed" but not
 * why.
 */
export default function usePlugins() {
    const [plugins, setPlugins] = useState([]);
    const [ready, setReady] = useState(false);
    const [notices, setNotices] = useState(() => new Map());

    const refresh = useCallback(async () => {
        if (!window.api?.plugins) {
            setReady(true);
            return [];
        }
        try {
            const list = await window.api.plugins.list();
            setPlugins(list || []);
            return list || [];
        } finally {
            setReady(true);
        }
    }, []);

    useEffect(() => {
        refresh();

        if (!window.api?.plugins) return undefined;

        const note = (id, type, message) => {
            setNotices(prev => new Map(prev).set(id, { type, message }));
        };

        const unsubscribe = [
            window.api.plugins.onCrash(({ id, message }) => {
                note(id, 'crash', message);
                refresh();
            }),
            window.api.plugins.onExit(({ id, code, signal, expected }) => {
                if (expected) return; // A deliberate stop(); nothing to explain.
                note(id, 'exit', `code ${code ?? '?'}${signal ? `, signal ${signal}` : ''}`);
                refresh();
            }),
            window.api.plugins.onStartFailed(({ id, message }) => {
                note(id, 'start-failed', message);
                refresh();
            }),
        ];

        return () => unsubscribe.forEach(unsub => unsub?.());
    }, [refresh]);

    const rescan = useCallback(async () => {
        if (!window.api?.plugins) return [];
        const list = await window.api.plugins.rescan();
        setPlugins(list || []);
        return list || [];
    }, []);

    const respondToConsent = useCallback(async (id, approved) => {
        const result = await window.api.plugins.respondToConsent(id, approved);
        // A fresh decision supersedes whatever the last crash/exit said.
        setNotices(prev => {
            const next = new Map(prev);
            next.delete(id);
            return next;
        });
        await refresh();
        return result;
    }, [refresh]);

    const setEnabled = useCallback(async (id, enabled) => {
        const result = await window.api.plugins.setEnabled(id, enabled);
        await refresh();
        return result;
    }, [refresh]);

    return { plugins, ready, notices, refresh, rescan, respondToConsent, setEnabled };
}
