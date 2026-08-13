import { useState, useRef, useCallback, useMemo, useEffect } from 'react';
import toast from 'react-hot-toast';
import { toastStyle as getToastStyle } from '../lib/toast';
import { createGroup, joinGroup, nextGroupColor, reorderTabs, suggestGroupName } from '../lib/tabs';
import {
    MAX_PANES,
    cloneLayout,
    collectPanes,
    createPane,
    deserializeLayout,
    equalizeSplit,
    findPane,
    measureLayout,
    neighborPane,
    paneCount,
    removePane,
    resizeSplit,
    serializeLayout,
    splitPane,
    updatePane,
    updatePanes,
} from '../lib/panes';

const SESSION_TABS_KEY = 'session.tabs';
const TAB_GROUPS_KEY = 'session.tabGroups';

const readSavedSession = () => {
    if (localStorage.getItem('restoreSessions') === 'false') return null;
    try {
        const saved = JSON.parse(localStorage.getItem(SESSION_TABS_KEY) || 'null');
        return Array.isArray(saved?.tabs) && saved.tabs.length > 0 ? saved : null;
    } catch {
        return null;
    }
};

const readSavedGroups = () => {
    try {
        const saved = JSON.parse(localStorage.getItem(TAB_GROUPS_KEY) || 'null');
        if (!Array.isArray(saved)) return [];
        return saved
            .filter(group => group?.id && group?.name)
            .map(group => ({
                id: String(group.id),
                name: String(group.name).slice(0, 40),
                color: String(group.color || 'slate'),
            }));
    } catch {
        return [];
    }
};

/**
 * A terminal tab, holding one pane to begin with.
 *
 * The first pane deliberately reuses the tab's own id as its session key: it is
 * the id the main process already knows this connection by, and the id a
 * restored session was saved under.
 */
const createTerminalTab = (id, host, view = null) => ({
    id,
    type: 'terminal',
    layout: createPane({ id, host, title: host.name, view }),
    focusedPaneId: id,
    zoomedPaneId: null,
});

/**
 * Tabs, their panes, and the groups tabs are filed under - the state App.jsx
 * used to hold directly (with `tabsRef`/`activeTabIdRef` hand-mirrored for
 * callbacks that must not re-bind), plus every operation that changes any of
 * it. Tab groups are folded in here rather than a hook of their own: several
 * operations (creating a group from a tab, deleting one) write tabs and
 * groups in the same commit, and splitting them would mean threading `setTabs`
 * across a hook boundary for no real gain.
 *
 * `hosts`/`saveHost`/`assistantConnects` are the assistant's and the host
 * store's, not this hook's - injected rather than imported, the same pattern
 * usePrompts uses, so this hook stays about tabs and panes and nothing else.
 */
export default function useTabs({ hosts, saveHost, assistantConnects, onReachedActiveTab }) {
    const [tabs, setTabs] = useState([{ id: 'home', type: 'home', title: 'Home' }]);
    const [activeTabId, setActiveTabId] = useState('home');
    const [tabGroups, setTabGroups] = useState(readSavedGroups);

    // Fullscreen state - which tab is currently fullscreen (null if none)
    const [fullscreenTabId, setFullscreenTabId] = useState(null);

    // Mirrors for callbacks that must not re-bind on every tab change.
    const tabsRef = useRef(tabs);
    tabsRef.current = tabs;

    const activeTabIdRef = useRef(activeTabId);
    activeTabIdRef.current = activeTabId;

    const tabCounter = useRef(0);

    // Read once, on first render. The persist effect below would otherwise
    // overwrite the record with the tab-less startup state before the restore
    // effect gets to read it.
    const savedSessionRef = useRef(undefined);
    if (savedSessionRef.current === undefined) savedSessionRef.current = readSavedSession();

    // Reopen the terminal tabs from the last run once the host list is in.
    // Hosts deleted since then are skipped. Every restored pane keeps its old
    // id on purpose: connecting under the same id makes the main process
    // replace any orphaned session (left by a reload) instead of stacking a
    // second one.
    useEffect(() => {
        const saved = savedSessionRef.current;
        if (!saved || hosts.length === 0) return;
        savedSessionRef.current = null;

        const hostsById = Object.fromEntries(hosts.map(host => [host.id, host]));

        const restored = saved.tabs
            .map((entry) => {
                if (!entry?.id) return null;

                // What the user called the tab, what colour they gave it and
                // which group it sat in are theirs, not the session's, so they
                // come back whether or not the layout does.
                const identity = {
                    customTitle: entry.customTitle || null,
                    color: entry.color || null,
                    groupId: entry.groupId || null,
                };

                // Written before tabs could split: one host, one pane.
                if (!entry.layout) {
                    const host = hostsById[entry.hostId];
                    return host ? { ...createTerminalTab(entry.id, host), ...identity } : null;
                }

                const layout = deserializeLayout(entry.layout, hostsById);
                if (!layout) return null;

                const panes = collectPanes(layout);
                const focused = panes.some(pane => pane.id === entry.focusedPaneId)
                    ? entry.focusedPaneId
                    : panes[0].id;

                return {
                    id: entry.id,
                    type: 'terminal',
                    layout,
                    focusedPaneId: focused,
                    zoomedPaneId: null,
                    ...identity,
                };
            })
            .filter(Boolean);
        if (restored.length === 0) return;

        setTabs(prev => [...prev, ...restored.filter(t => !prev.some(p => p.id === t.id))]);
        if (restored.some(t => t.id === saved.activeTabId)) {
            setActiveTabId(saved.activeTabId);
        }
    }, [hosts]);

    // Remember which terminal tabs are open, and how each one is laid out.
    // Held back until the restore effect has consumed the previous record, or
    // startup would wipe it.
    useEffect(() => {
        if (savedSessionRef.current) return;
        const openTabs = tabs
            .filter(tab => tab.type === 'terminal')
            .map(tab => ({
                id: tab.id,
                layout: serializeLayout(tab.layout),
                focusedPaneId: tab.focusedPaneId,
                customTitle: tab.customTitle || null,
                color: tab.color || null,
                groupId: tab.groupId || null,
            }))
            .filter(entry => entry.layout);
        localStorage.setItem(SESSION_TABS_KEY, JSON.stringify({ tabs: openTabs, activeTabId }));
    }, [tabs, activeTabId]);

    // Groups are saved separately, and are not gated on the restore having run:
    // they are not sessions, so an empty one is still worth keeping.
    useEffect(() => {
        localStorage.setItem(TAB_GROUPS_KEY, JSON.stringify(tabGroups));
    }, [tabGroups]);

    /** The tab holding a pane, and the pane itself. */
    const locatePane = useCallback((paneId) => {
        for (const tab of tabsRef.current) {
            if (tab.type !== 'terminal') continue;
            const pane = findPane(tab.layout, paneId);
            if (pane) return { tab, pane };
        }
        return null;
    }, []);

    /** Every pane on screen right now, whichever tab it is in. */
    const paneIds = useMemo(() => {
        const ids = new Set();
        for (const tab of tabs) {
            if (tab.type !== 'terminal') continue;
            for (const pane of collectPanes(tab.layout)) ids.add(pane.id);
        }
        return ids;
    }, [tabs]);

    /**
     * Rewrite one tab, leaving every other one untouched.
     *
     * Returning the previous array when `fn` changed nothing makes React drop
     * the update entirely. That matters: focus is claimed on every mousedown,
     * so without it a click inside a terminal would re-render every pane in
     * the window.
     */
    const patchTab = useCallback((tabId, fn) => {
        setTabs((prev) => {
            let changed = false;
            const next = prev.map((tab) => {
                if (tab.id !== tabId || tab.type !== 'terminal') return tab;
                const updated = fn(tab) || tab;
                if (updated !== tab) changed = true;
                return updated;
            });
            return changed ? next : prev;
        });
    }, []);

    // Open an empty launcher tab; picking a host inside it fills this same tab.
    const handleNewTab = useCallback(() => {
        tabCounter.current += 1;
        const tabId = `new-${Date.now()}-${tabCounter.current}`;

        setTabs(prev => [...prev, { id: tabId, type: 'launcher', title: 'New Tab' }]);
        setActiveTabId(tabId);
    }, []);

    // Opening a tab is all the renderer does. TerminalView dials once it has
    // measured itself, so the PTY is created with the real geometry.
    // `intoTabId` turns an existing launcher tab into the session rather than
    // stacking an empty tab next to it. `view` is which view the session should
    // open on, for a "Connect via SFTP" or a "Connect via RDP" that asked for
    // something other than the shell.
    const handleConnect = useCallback((host, intoTabId, view = null) => {
        if (intoTabId) {
            setTabs(prev => prev.map(tab => tab.id === intoTabId
                ? createTerminalTab(intoTabId, host, view)
                : tab));
            setActiveTabId(intoTabId);
            return { success: true, tabId: intoTabId };
        }

        tabCounter.current += 1;
        const tabId = `term-${Date.now()}-${tabCounter.current}`;

        setTabs(prev => [...prev, createTerminalTab(tabId, host, view)]);
        setActiveTabId(tabId);

        // The first pane of a new tab takes the tab's own id, so this doubles
        // as the session id every other part of the app knows it by.
        return { success: true, tabId };
    }, []);

    const handleConnectResult = useCallback((paneId, result, { reconnect = false } = {}) => {
        // Anything the assistant is waiting on is answered first, whichever way
        // it went. A tool blocked on a connection that failed should be told
        // that, not left to time out.
        const waiter = assistantConnects.current.get(paneId);
        if (waiter) {
            assistantConnects.current.delete(paneId);
            waiter(result.success
                ? { success: true, sessionId: paneId }
                : { success: false, message: result.message || 'The connection failed' });
        }

        const found = locatePane(paneId);
        if (!found) return;

        patchTab(found.tab.id, current => ({
            ...current,
            layout: updatePane(current.layout, paneId, pane => (
                pane.connected === result.success ? pane : { ...pane, connected: result.success }
            )),
        }));

        const host = found.pane.host;

        if (!result.success) {
            toast.error(
                reconnect
                    ? `Lost connection to ${host?.name || 'host'}: ${result.message}`
                    : `Failed to connect: ${result.message}`,
                { style: getToastStyle() }
            );
            return;
        }

        toast.success(
            reconnect ? `Reconnected to ${host?.name || 'host'}` : `Connected to ${host?.name || 'host'}`,
            { style: getToastStyle() }
        );

        // An address dialled from a picker is not a saved record and is not
        // going to become one: there is no `lastConnectedAt` to write on it and
        // nowhere to keep the OS it reports, and Recent is a list of the hosts
        // someone chose to keep. Main refuses the save as well; this is so it
        // is never asked for. See store.openQuickConnect.
        if (host?.ephemeral) return;

        // The OS cannot have changed under a reconnect, and re-detecting it
        // would fire an exec on every wake from sleep.
        if (reconnect) {
            if (host) saveHost({ ...host, lastConnectedAt: Date.now() });
            return;
        }

        // Remember when we last reached this host so the launcher can surface
        // it under "Recent".
        if (host) saveHost({ ...host, lastConnectedAt: Date.now() });

        // Detection runs a command over an SSH exec channel, which is a thing
        // only an SSH session has. A serial console would be sent `cat
        // /etc/os-release` at whatever it happens to be showing.
        if ((host?.protocol || 'ssh') !== 'ssh') return;

        // Detect remote OS in the background and remember it on the host
        window.api.ssh.detectOS(paneId).then(({ os, distro }) => {
            if (host && os && os !== 'unknown' && (os !== host.os || distro !== host.distro)) {
                saveHost({ ...host, os, distro });
            }
        }).catch(() => {});
    }, [saveHost, locatePane, patchTab, assistantConnects]);

    // The connection hook inside TerminalView owns the session state; this
    // keeps the pane record in step so the tab strip dims a dropped session
    // and the saved-session record stays honest.
    const handleConnectionChange = useCallback((paneId, connected) => {
        setTabs((prev) => {
            let changed = false;
            const next = prev.map((tab) => {
                if (tab.type !== 'terminal') return tab;
                const layout = updatePane(tab.layout, paneId, pane => (
                    pane.connected === connected ? pane : { ...pane, connected }
                ));
                if (layout === tab.layout) return tab;
                changed = true;
                return { ...tab, layout };
            });
            return changed ? next : prev;
        });
    }, []);

    /**
     * Live connection controls, one entry per open terminal pane, registered by
     * the pane itself.
     *
     * A session's state belongs to the hook inside its pane, and only that hook
     * may end it: going straight to the main process from out here would look
     * like a drop from in there, and the pane would dial it back.
     */
    const paneConnections = useRef(new Map());

    const registerPaneConnection = useCallback((paneId, controls) => {
        if (controls) paneConnections.current.set(paneId, controls);
        else paneConnections.current.delete(paneId);
    }, []);

    /** A tab-level action means every session in the tab, split or not. */
    const eachPaneConnection = useCallback((tabId, fn) => {
        const tab = tabsRef.current.find(t => t.id === tabId);
        if (tab?.type !== 'terminal') return;

        for (const pane of collectPanes(tab.layout)) {
            const controls = paneConnections.current.get(pane.id);
            if (controls) fn(controls);
        }
    }, []);

    const handleDisconnectTab = useCallback((tabId) => {
        eachPaneConnection(tabId, controls => controls.disconnect());
    }, [eachPaneConnection]);

    const handleReconnectTab = useCallback((tabId) => {
        eachPaneConnection(tabId, controls => controls.reconnect());
    }, [eachPaneConnection]);

    /**
     * The same tab again, opened next to the one it came from.
     *
     * A split tab is copied whole, same hosts and same geometry, but the copies
     * are new sessions rather than the same ones, which is what duplicating a
     * terminal has always meant.
     */
    const handleDuplicateTab = useCallback((tabId) => {
        const tab = tabsRef.current.find(t => t.id === tabId);
        if (tab?.type !== 'terminal') return;

        tabCounter.current += 1;
        const newTabId = `term-${Date.now()}-${tabCounter.current}`;

        const panes = collectPanes(tab.layout);
        // One pane keeps the convention that a tab's first session is filed
        // under the tab's own id; there is no such id to reuse for the rest.
        const copy = panes.length === 1 && panes[0].host
            ? createTerminalTab(newTabId, panes[0].host)
            : (() => {
                const layout = cloneLayout(tab.layout);
                return {
                    id: newTabId,
                    type: 'terminal',
                    layout,
                    focusedPaneId: collectPanes(layout)[0]?.id || null,
                    zoomedPaneId: null,
                };
            })();

        setTabs((prev) => {
            const at = prev.findIndex(t => t.id === tabId);
            const next = [...prev];
            next.splice(at === -1 ? prev.length : at + 1, 0, copy);
            return next;
        });
        setActiveTabId(newTabId);
    }, []);

    /**
     * Close a batch of tabs at once.
     *
     * Not a loop over the single-tab close: every call in that loop would work
     * from the tab list as it stood before the batch, and which tab was left
     * focused would come down to whichever call happened to run last.
     */
    const closeTabs = useCallback((doomed, keepId) => {
        if (doomed.length === 0) return;

        for (const tab of doomed) {
            if (tab.type !== 'terminal') continue;
            for (const pane of collectPanes(tab.layout)) {
                if (pane.mode === 'terminal') window.api.ssh.disconnect(pane.id);
            }
        }

        const gone = new Set(doomed.map(tab => tab.id));
        setFullscreenTabId(prev => (prev && gone.has(prev) ? null : prev));
        setTabs(prev => prev.filter(tab => !gone.has(tab.id)));
        setActiveTabId(prev => (gone.has(prev) ? keepId : prev));
    }, []);

    const handleCloseOtherTabs = useCallback((tabId) => {
        closeTabs(tabsRef.current.filter(tab => tab.type !== 'home' && tab.id !== tabId), tabId);
    }, [closeTabs]);

    const handleCloseTabsToRight = useCallback((tabId) => {
        const at = tabsRef.current.findIndex(tab => tab.id === tabId);
        if (at === -1) return;
        closeTabs(tabsRef.current.slice(at + 1).filter(tab => tab.type !== 'home'), tabId);
    }, [closeTabs]);

    const handleCloseTab = useCallback((tabId) => {
        if (tabId === 'home') return;

        // Only terminal tabs hold sessions, one per pane. `invoke`, not `send`,
        // because the handler is registered with ipcMain.handle, so a `send`
        // would be dropped and leak the session.
        const closing = tabsRef.current.find(tab => tab.id === tabId);
        if (closing?.type === 'terminal') {
            for (const pane of collectPanes(closing.layout)) {
                if (pane.mode === 'terminal') window.api.ssh.disconnect(pane.id);
            }
        }

        // Otherwise the shell stays in fullscreen with no title bar to leave it.
        setFullscreenTabId(prev => (prev === tabId ? null : prev));

        setTabs(prev => {
            const newTabs = prev.filter(tab => tab.id !== tabId);
            if (activeTabIdRef.current === tabId) {
                setActiveTabId(newTabs[newTabs.length - 1]?.id || 'home');
            }
            return newTabs;
        });
    }, []);

    /* -------------------------------------------------------------- *
     * Tab identity: name, colour, group
     *
     * None of this touches a session. A tab is a place the user put something,
     * and what they called it and where they filed it is theirs to keep, which
     * is why it survives a reconnect, a restore, and the host being renamed
     * underneath it.
     * -------------------------------------------------------------- */

    /** An empty name clears the override, so the host's name comes back. */
    const handleRenameTab = useCallback((tabId, title) => {
        const trimmed = String(title || '').trim().slice(0, 60);
        setTabs(prev => prev.map(tab => (
            tab.id === tabId ? { ...tab, customTitle: trimmed || null } : tab
        )));
    }, []);

    const handleColorTab = useCallback((tabId, color) => {
        setTabs(prev => prev.map(tab => (
            tab.id === tabId ? { ...tab, color: color || null } : tab
        )));
    }, []);

    /**
     * Put a tab in a group, moving it next to the group's other members so the
     * bracket the strip draws has nothing foreign inside it.
     */
    const handleGroupTab = useCallback((tabId, groupId) => {
        setTabs(prev => joinGroup(prev, tabId, groupId));
    }, []);

    /**
     * The strip, rearranged by hand.
     *
     * Order and group arrive together because the drop decided both: a tab let
     * go of inside an outline is filed there, and one let go of outside every
     * outline is loose, which is exactly what the strip was showing while it
     * was being carried. The new order is what the next launch restores, since
     * the session record is written from the tabs in the order they are held.
     */
    const handleReorderTabs = useCallback((orderedIds, tabId, groupId) => {
        setTabs(prev => reorderTabs(prev, orderedIds, tabId, groupId));
    }, []);

    const handleUngroupTab = useCallback((tabId) => {
        setTabs(prev => prev.map(tab => (
            tab.id === tabId ? { ...tab, groupId: null } : tab
        )));
    }, []);

    const handleNewGroupFromTab = useCallback((tabId) => {
        setTabGroups((groups) => {
            const group = createGroup(suggestGroupName(groups), nextGroupColor(groups));
            // Assigning inside the groups updater keeps the two writes in one
            // commit, so the strip never renders a tab pointing at a group that
            // does not exist yet.
            setTabs(prev => prev.map(tab => (tab.id === tabId ? { ...tab, groupId: group.id } : tab)));
            return [...groups, group];
        });
    }, []);

    const handleRenameGroup = useCallback((groupId, name) => {
        const trimmed = String(name || '').trim().slice(0, 40);
        if (!trimmed) return;
        setTabGroups(groups => groups.map(group => (
            group.id === groupId ? { ...group, name: trimmed } : group
        )));
    }, []);

    const handleColorGroup = useCallback((groupId, color) => {
        setTabGroups(groups => groups.map(group => (
            group.id === groupId ? { ...group, color } : group
        )));
    }, []);

    /** Dissolve the group; its tabs stay open and stay where they are. */
    const handleDeleteGroup = useCallback((groupId) => {
        setTabs(prev => prev.map(tab => (tab.groupId === groupId ? { ...tab, groupId: null } : tab)));
        setTabGroups(groups => groups.filter(group => group.id !== groupId));
    }, []);

    /* -------------------------------------------------------------- *
     * Panes
     * -------------------------------------------------------------- */

    /**
     * Put a second session beside this one.
     *
     * `source` is 'duplicate' to open the same host again, which is what a
     * split usually means, or 'pick' to drop a host chooser into the new pane.
     */
    const handleSplitPane = useCallback((tabId, paneId, direction, source = 'duplicate') => {
        const tab = tabsRef.current.find(t => t.id === tabId);
        if (tab?.type !== 'terminal') return;

        const target = findPane(tab.layout, paneId);
        if (!target) return;

        if (paneCount(tab.layout) >= MAX_PANES) {
            toast.error(`A tab holds at most ${MAX_PANES} panes.`, { style: getToastStyle() });
            return;
        }

        const addition = source === 'duplicate' && target.host
            ? createPane({ host: target.host, title: target.title })
            : createPane({ mode: 'picker' });

        patchTab(tabId, current => ({
            ...current,
            layout: splitPane(current.layout, paneId, direction, addition),
            focusedPaneId: addition.id,
            // A new pane you cannot see is not much use.
            zoomedPaneId: null,
        }));
    }, [patchTab]);

    const handleClosePane = useCallback((tabId, paneId) => {
        const tab = tabsRef.current.find(t => t.id === tabId);
        if (tab?.type !== 'terminal') return;

        const target = findPane(tab.layout, paneId);
        if (!target) return;

        const layout = removePane(tab.layout, paneId);
        if (!layout) {
            // That was the last pane, so the tab goes with it, and closing the
            // tab is what ends the session.
            handleCloseTab(tabId);
            return;
        }

        if (target.mode === 'terminal') window.api.ssh.disconnect(paneId);

        // Focus lands where the closed pane was, or on its neighbour if it was
        // the last one, rather than jumping back to the start of the tab.
        const position = collectPanes(tab.layout).findIndex(pane => pane.id === paneId);
        const remaining = collectPanes(layout);
        const focused = remaining.some(pane => pane.id === tab.focusedPaneId) && tab.focusedPaneId !== paneId
            ? tab.focusedPaneId
            : remaining[Math.min(Math.max(position, 0), remaining.length - 1)].id;

        patchTab(tabId, current => ({
            ...current,
            layout,
            focusedPaneId: focused,
            zoomedPaneId: current.zoomedPaneId === paneId ? null : current.zoomedPaneId,
        }));
    }, [handleCloseTab, patchTab]);

    const handleFocusPane = useCallback((tabId, paneId) => {
        patchTab(tabId, current => (
            current.focusedPaneId === paneId ? current : { ...current, focusedPaneId: paneId }
        ));
    }, [patchTab]);

    /** Fill the tab with one pane, without disturbing the others' geometry. */
    const handleToggleZoom = useCallback((tabId, paneId) => {
        patchTab(tabId, current => ({
            ...current,
            focusedPaneId: paneId,
            zoomedPaneId: current.zoomedPaneId === paneId ? null : paneId,
        }));
    }, [patchTab]);

    const handleResizeSplit = useCallback((tabId, splitId, sizes) => {
        patchTab(tabId, current => ({ ...current, layout: resizeSplit(current.layout, splitId, sizes) }));
    }, [patchTab]);

    const handleEqualizeSplit = useCallback((tabId, splitId) => {
        patchTab(tabId, current => ({ ...current, layout: equalizeSplit(current.layout, splitId) }));
    }, [patchTab]);

    /** A picker pane became a session. Same pane, same id, now with a host. */
    const handlePanePick = useCallback((tabId, paneId, host) => {
        patchTab(tabId, current => ({
            ...current,
            layout: updatePane(current.layout, paneId, {
                mode: 'terminal',
                host,
                title: host.name,
                connected: false,
            }),
            focusedPaneId: paneId,
        }));
    }, [patchTab]);

    /**
     * Move focus to whichever pane sits in that direction.
     *
     * Worked out from the layout's own geometry rather than from the tree: what
     * looks like "the pane below" is a question about the screen, and it is
     * still the right answer while another pane is zoomed over the top of it.
     */
    const handleFocusNeighbor = useCallback((tabId, direction) => {
        const tab = tabsRef.current.find(t => t.id === tabId);
        if (tab?.type !== 'terminal') return;

        const surface = document.querySelector(`[data-tab-panes="${tabId}"]`);
        const bounds = surface?.getBoundingClientRect();
        if (!bounds) return;

        const rects = measureLayout(tab.layout).panes.map(({ id, box }) => {
            const left = box.fracX * bounds.width + box.pxX;
            const top = box.fracY * bounds.height + box.pxY;
            return {
                id,
                left,
                top,
                right: left + box.fracW * bounds.width + box.pxW,
                bottom: top + box.fracH * bounds.height + box.pxH,
            };
        });

        const next = neighborPane(rects, tab.focusedPaneId, direction);
        if (!next) return;

        patchTab(tabId, current => ({
            ...current,
            focusedPaneId: next,
            // Zoomed, the move carries the zoom along with it: the alternative
            // is focusing a pane the user cannot see.
            zoomedPaneId: current.zoomedPaneId ? next : null,
        }));
    }, [patchTab]);

    /** Clicking the tab you are on is the same gesture. See `reachedForPage` in App.jsx. */
    const handleTabClick = useCallback((tabId) => {
        if (tabId === activeTabIdRef.current) onReachedActiveTab();
        else setActiveTabId(tabId);
    }, [onReachedActiveTab]);

    const handleToggleFullscreen = useCallback((tabId) => {
        setFullscreenTabId(prev => prev === tabId ? null : tabId);
    }, []);

    /**
     * Persist a host edited from inside a live session, currently its port
     * forwards. Panes carry a snapshot of the host they opened with, so every
     * pane pointing at it is refreshed too, or the next edit would be made
     * against a stale copy and silently undo this one.
     */
    const handleUpdateHost = useCallback(async (hostData) => {
        const saved = await saveHost(hostData);
        setTabs(prev => prev.map((tab) => {
            if (tab.type !== 'terminal') return tab;
            const layout = updatePanes(tab.layout, pane => (
                pane.host?.id === saved.id ? { ...pane, host: { ...pane.host, ...saved } } : pane
            ));
            return layout === tab.layout ? tab : { ...tab, layout };
        }));
        // A host edit is rare enough that a wasted array is not worth guarding.
        return saved;
    }, [saveHost]);

    return {
        tabs,
        activeTabId,
        setActiveTabId,
        tabGroups,
        tabsRef,
        activeTabIdRef,
        fullscreenTabId,
        locatePane,
        paneIds,
        paneConnections,
        registerPaneConnection,
        handleNewTab,
        handleConnect,
        handleConnectResult,
        handleConnectionChange,
        handleDisconnectTab,
        handleReconnectTab,
        handleDuplicateTab,
        handleCloseOtherTabs,
        handleCloseTabsToRight,
        handleCloseTab,
        handleRenameTab,
        handleColorTab,
        handleGroupTab,
        handleReorderTabs,
        handleUngroupTab,
        handleNewGroupFromTab,
        handleRenameGroup,
        handleColorGroup,
        handleDeleteGroup,
        handleSplitPane,
        handleClosePane,
        handleFocusPane,
        handleToggleZoom,
        handleResizeSplit,
        handleEqualizeSplit,
        handlePanePick,
        handleFocusNeighbor,
        handleTabClick,
        handleToggleFullscreen,
        handleUpdateHost,
    };
}
