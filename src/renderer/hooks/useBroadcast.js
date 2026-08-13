import { useState, useRef, useCallback, useMemo, useEffect } from 'react';
import { collectPanes, findPane } from '../lib/panes';

/* -------------------------------------------------------------- *
 * Broadcast input
 * -------------------------------------------------------------- */

/**
 * Where a keystroke goes: the focused pane alone, every pane in the tab, or
 * every pane in the window. Owns the routing and the count shown in the
 * title bar; the tab/pane tree itself is App.jsx's (via useTabs), read here
 * only to find targets.
 */
export default function useBroadcast({ tabs, activeTabId, tabsRef }) {
    // Where typing goes: 'off' | 'tab' | 'window'.
    const [broadcast, setBroadcast] = useState('off');

    // Read on every keystroke by a callback that must never re-bind: rebuilding
    // it would mean re-registering xterm's data handler in every open pane.
    const broadcastRef = useRef(broadcast);
    broadcastRef.current = broadcast;

    /**
     * Which sessions a keystroke from `paneId` reaches.
     *
     * The originating pane is always included, even if its own session has
     * dropped: it is where the keys were typed, and swallowing them would look
     * like the keyboard had stopped working. Everything else has to be live:
     * writing to a dead session queues bytes that arrive on the next reconnect,
     * which is exactly the wrong time for half a command to show up.
     */
    const broadcastTargets = useCallback((paneId, scope) => {
        if (scope === 'off') return [paneId];

        const source = scope === 'window'
            ? tabsRef.current.filter(tab => tab.type === 'terminal')
            : tabsRef.current.filter(tab => tab.type === 'terminal' && findPane(tab.layout, paneId));

        const targets = new Set([paneId]);
        for (const tab of source) {
            for (const pane of collectPanes(tab.layout)) {
                if (pane.mode === 'terminal' && pane.connected) targets.add(pane.id);
            }
        }
        return [...targets];
    }, [tabsRef]);

    /**
     * Every keystroke, paste and snippet from a pane comes through here.
     *
     * Panes used to write straight to their own session. Routing it centrally is
     * what makes broadcasting possible at all: the pane cannot know what else is
     * open, and the alternative (each pane subscribing to every other) is the
     * same fan-out with more places to get it wrong.
     */
    const handlePaneInput = useCallback((paneId, data) => {
        const scope = broadcastRef.current;
        if (scope === 'off') {
            window.api.ssh.sendInput(paneId, data);
            return;
        }
        for (const target of broadcastTargets(paneId, scope)) {
            window.api.ssh.sendInput(target, data);
        }
    }, [broadcastTargets, broadcastRef]);

    /**
     * How many sessions the keyboard currently reaches, for the warning in the
     * title bar. Counted from the focused tab, which is the one being typed in.
     */
    const broadcastCount = useMemo(() => {
        if (broadcast === 'off') return 0;
        const tab = tabs.find(item => item.id === activeTabId);
        const scope = broadcast === 'window'
            ? tabs.filter(item => item.type === 'terminal')
            : (tab?.type === 'terminal' ? [tab] : []);

        let count = 0;
        for (const item of scope) {
            for (const pane of collectPanes(item.layout)) {
                if (pane.mode === 'terminal' && pane.connected) count += 1;
            }
        }
        return count;
    }, [broadcast, tabs, activeTabId]);

    // Leaving broadcast on with nothing to broadcast to is a trap: the next tab
    // opened would silently join a mode the user has forgotten about.
    useEffect(() => {
        if (broadcast !== 'off' && broadcastCount === 0) setBroadcast('off');
    }, [broadcast, broadcastCount]);

    return { broadcast, setBroadcast, broadcastCount, handlePaneInput };
}
