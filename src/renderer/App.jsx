import { useState, useEffect, useCallback, useMemo, useRef } from 'react';
import toast from 'react-hot-toast';
import { toastStyle as getToastStyle } from './lib/toast';
import TitleBar from './components/TitleBar';
import Sidebar from './components/Sidebar';
import HomeView from './components/HomeView';
import TerminalView from './components/TerminalView';
import HostModal from './components/HostModal';
import NewTabView from './components/NewTabView';
import FolderModal from './components/FolderModal';
import SessionScreen from './components/ui/SessionScreen';
import SplitLayout from './components/panes/SplitLayout';
import PanePicker from './components/panes/PanePicker';
import PanelDock from './components/PanelDock';
import QuickAccessGutter, { TOOL_IDS } from './components/QuickAccessGutter';
import BuiltinRestartBanner from './components/BuiltinRestartBanner';
import { useTheme } from './hooks/useTheme';
import { useSessions } from './hooks/useSessions';
import { useTerminalTheme } from './hooks/useTerminalTheme';
import { useTerminalSettings } from './hooks/useTerminalSettings';
import { useKeychain } from './hooks/useKeychain';
import useSettingsSnapshot from './hooks/useSettingsSnapshot';
import usePrompts from './hooks/usePrompts';
import useTabs from './hooks/useTabs';
import useBroadcast from './hooks/useBroadcast';
import { APP_GUTTER } from './lib/layout';
import { hostOs } from './lib/os-icons';
import { tagCounts } from './lib/tags';
import { numberSessions } from './lib/tabs';
import { MAX_PANES, collectPanes, findPane, paneCount } from './lib/panes';

/** Alt+arrow moves between panes; these are the directions it can mean. */
const ARROW_DIRECTIONS = {
    ArrowLeft: 'left',
    ArrowRight: 'right',
    ArrowUp: 'up',
    ArrowDown: 'down',
};

function App() {
    // Theme management
    const {
        theme, setTheme,
        darkTint, setDarkTint,
        lightTint, setLightTint,
        appColors, setAppColors,
        lightAppColors, setLightAppColors,
        resolvedDark,
        showLogo, setShowLogo,
        logoImage, setLogoImage,
        logoSide, setLogoSide,
        quickThemeSwitcherEnabled, setQuickThemeSwitcherEnabled,
    } = useTheme();
    const { terminalTheme, setTerminalTheme, customTerminalTheme, setCustomTerminalTheme } = useTerminalTheme();
    const {
        terminalSettings,
        setTerminalSettings,
        resetTerminalSettings,
        fonts: terminalFonts,
    } = useTerminalSettings();

    // Navigation state
    const [activeNav, setActiveNav] = useState('hosts');

    const activeNavRef = useRef(activeNav);
    activeNavRef.current = activeNav;

    /**
     * Bumped when the chrome is used to ask for a page that is already up: the
     * sidebar item you are standing on, the Home tab while Home is showing.
     *
     * That click has nothing to change, so on its own it does nothing at all,
     * and an editor sitting over the page stays there. But asking for a page
     * you can see is a way of asking for it back, which means what is over it
     * goes: this is the only signal that says so, since neither the section nor
     * the tab has moved. Real navigation is not routed through here: leaving a
     * page takes its sheet with it further down, and instantly, because that
     * sheet belongs to a page you are no longer looking at.
     */
    const [reachedForPage, setReachedForPage] = useState(0);

    const handleNavChange = useCallback((nav) => {
        if (nav === activeNavRef.current) setReachedForPage(count => count + 1);
        else setActiveNav(nav);
    }, []);

    // Read once at boot (plugins/builtins.js); optimistic default since a
    // toggle only takes effect on next launch, not live.
    const [aiEnabled, setAiEnabled] = useState(true);
    useEffect(() => {
        window.api.plugins?.builtins?.list().then((list) => {
            const entry = list?.find(item => item.id === 'com.reefterm.builtin.ai');
            if (entry) setAiEnabled(entry.enabled);
        });
    }, []);

    // The assistant column's width. Remembered because it is the kind of
    // thing someone sets once to suit their screen and never touches again.
    const [assistantWidth, setAssistantWidth] = useState(() => {
        const stored = Number(window.localStorage.getItem('assistant.width'));
        return Number.isFinite(stored) && stored >= 320 ? stored : 400;
    });

    // Which tool's panel PanelDock is showing, if any - one flag, not one
    // per tool, since QuickAccessGutter only ever wants at most one open.
    const [activePanel, setActivePanel] = useState(null);

    // If the tool behind the open panel gets disabled out from under it,
    // there is no rail button left to close it with.
    useEffect(() => {
        if (activePanel === TOOL_IDS.ASSISTANT && !aiEnabled) setActivePanel(null);
        if (activePanel === TOOL_IDS.THEME_SWITCHER && !quickThemeSwitcherEnabled) setActivePanel(null);
    }, [activePanel, aiEnabled, quickThemeSwitcherEnabled]);

    // The changing half of QuickAccessGutter's contents; the fixed half
    // (icon, title, hint) lives with the component itself, keyed by the same
    // id. Not memoized: cheap enough to rebuild every render.
    const quickAccessToolState = {
        [TOOL_IDS.ASSISTANT]: {
            enabled: aiEnabled,
            open: activePanel === TOOL_IDS.ASSISTANT,
            onToggle: () => setActivePanel(current => (current === TOOL_IDS.ASSISTANT ? null : TOOL_IDS.ASSISTANT)),
        },
        [TOOL_IDS.THEME_SWITCHER]: {
            enabled: quickThemeSwitcherEnabled,
            open: activePanel === TOOL_IDS.THEME_SWITCHER,
            onToggle: () => setActivePanel(current => (current === TOOL_IDS.THEME_SWITCHER ? null : TOOL_IDS.THEME_SWITCHER)),
        },
    };

    // paneId -> resolve, for a connection the assistant asked for and is
    // waiting on. Opening a tab is not the same as being connected, and the
    // tool cannot hand back a session id until it is.
    const assistantConnects = useRef(new Map());

    // Data management
    const {
        hosts,
        folders,
        saveHost,
        deleteHost,
        duplicateHost,
        saveFolder,
        deleteFolder,
        deleteMany,
        arrangeItems,
        tagHosts,
        loadData,
    } = useSessions();
    const { keys, loadData: loadKeys, saveKey, deleteKey, generateKey } = useKeychain();
    const [currentFolderId, setCurrentFolderId] = useState('');

    // Modal state
    const [hostModalOpen, setHostModalOpen] = useState(false);
    const [folderModalOpen, setFolderModalOpen] = useState(false);
    const [editingHost, setEditingHost] = useState(null);
    const [editingFolder, setEditingFolder] = useState(null);

    // Load data on mount
    useEffect(() => {
        loadData();
    }, [loadData]);

    // Warn once if the OS keystore is unavailable, so the user knows their
    // credentials are only obfuscated on disk rather than encrypted.
    useEffect(() => {
        window.api.store.status().then(({ encryptionAvailable }) => {
            if (!encryptionAvailable) {
                toast.error(
                    'OS keystore unavailable: stored credentials are not encrypted on this machine.',
                    { style: getToastStyle() }
                );
            }
        }).catch(() => {});
    }, []);

    // Tabs, panes, and the groups they are filed under - state, session
    // restore/persist, and every operation that changes any of it.
    const {
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
    } = useTabs({
        hosts,
        saveHost,
        assistantConnects,
        onReachedActiveTab: () => setReachedForPage(count => count + 1),
    });

    /**
     * An address typed into a picker rather than a host chosen from one - or
     * a plugin's own contributed host, via `source: { pluginId, group }` (see
     * HostsPanel's onQuickConnect), which tells main which credential
     * mapping to resolve instead of always prompting.
     *
     * Main parses it and hands back a host record that lives for this app run
     * only; from there it is an ordinary connection, opened by id like any
     * other, and the pane asks for the login while it dials. Answers null when
     * the address will not do, having said so.
     */
    const openAddress = useCallback(async (address, source) => {
        const result = await window.api.hosts.quickConnect(address, source);
        if (result?.success && result.host) return result.host;

        toast.error(result?.message || 'Could not read that address', { style: getToastStyle() });
        return null;
    }, []);

    // Where typing goes: 'off' | 'tab' | 'window'.
    const { broadcast, setBroadcast, broadcastCount, handlePaneInput } = useBroadcast({ tabs, activeTabId, tabsRef });

    // The queue of host-key confirmations and keyboard-interactive rounds
    // raised mid-handshake, and where each one is answered. See usePrompts
    // for `routePrompt`'s reasoning: the same tab-in-front, fallback-pane
    // logic this used to be, unchanged.
    const {
        hostKeyPrompts,
        authPrompts,
        handleHostKeyResponse,
        handleAuthPromptResponse,
        hostKeyPromptFor,
        authPromptFor,
    } = usePrompts({ locatePane, tabsRef, activeTabIdRef, setActiveTabId });

    /**
     * A question with no pane left to ask it in.
     *
     * It should not happen: every dial names the pane it is for. But a pane can
     * be closed while its handshake is still mid-flight, and a prompt nobody
     * can answer holds the main process open waiting for a reply. So the same
     * screen is put over the window instead, which is the one case where any of
     * this is not part of a pane.
     */
    const strayHostKeyPrompt = hostKeyPrompts.find(prompt => !paneIds.has(prompt.tabId)) || null;
    const strayAuthPrompt = strayHostKeyPrompt
        ? null
        : authPrompts.find(prompt => !paneIds.has(prompt.tabId)) || null;

    /**
     * Pane shortcuts, following Windows Terminal so they are already in the
     * fingers of anyone who splits terminals. Taken in the capture phase, since
     * xterm would otherwise forward them to the remote shell.
     *
     * Lives here rather than inside useTabs: the broadcast chord needs
     * useBroadcast's setter, and useBroadcast needs useTabs's tabs/tabsRef, so
     * composing both only works one level up from either.
     */
    useEffect(() => {
        const handler = (event) => {
            const tab = tabsRef.current.find(t => t.id === activeTabIdRef.current);
            if (tab?.type !== 'terminal') return;

            const paneId = tab.focusedPaneId;
            const split = paneCount(tab.layout) > 1;

            const claim = () => {
                event.preventDefault();
                event.stopPropagation();
            };

            // Broadcast is a two-state chord on purpose: it toggles the scope
            // people actually want, this tab, and the window-wide scope is
            // left to the menu, where it can say how many sessions it means.
            if (event.ctrlKey && event.shiftKey && !event.altKey && event.code === 'KeyB') {
                claim();
                setBroadcast(current => (current === 'off' ? 'tab' : 'off'));
                return;
            }

            if (event.altKey && event.shiftKey && !event.ctrlKey && !event.metaKey) {
                if (event.code === 'Equal' || event.code === 'NumpadAdd') {
                    claim();
                    handleSplitPane(tab.id, paneId, 'row');
                    return;
                }
                if (event.code === 'Minus' || event.code === 'NumpadSubtract') {
                    claim();
                    handleSplitPane(tab.id, paneId, 'column');
                    return;
                }
                if (event.code === 'KeyZ' && split) {
                    claim();
                    handleToggleZoom(tab.id, paneId);
                    return;
                }
            }

            // Everything below only means anything once a tab is split, so an
            // unsplit tab keeps handing these to the shell.
            if (!split) return;

            if (event.ctrlKey && event.shiftKey && !event.altKey && event.code === 'KeyW') {
                claim();
                handleClosePane(tab.id, paneId);
                return;
            }

            if (event.altKey && !event.shiftKey && !event.ctrlKey && ARROW_DIRECTIONS[event.key]) {
                claim();
                handleFocusNeighbor(tab.id, ARROW_DIRECTIONS[event.key]);
            }
        };

        document.addEventListener('keydown', handler, true);
        return () => document.removeEventListener('keydown', handler, true);
    }, [handleSplitPane, handleToggleZoom, handleClosePane, handleFocusNeighbor, tabsRef, activeTabIdRef, setBroadcast]);

    /**
     * The assistant, toggled from anywhere.
     *
     * Registered separately from the pane chords above, which bail out unless a
     * terminal tab is in front. This one has to work on the Hosts page too,
     * where "connect to the box that is paging me" is a perfectly good opening
     * line.
     */
    useEffect(() => {
        if (!aiEnabled) return undefined;
        const handler = (event) => {
            if (event.ctrlKey && event.shiftKey && !event.altKey && event.code === 'KeyA') {
                event.preventDefault();
                event.stopPropagation();
                setActivePanel(current => (current === TOOL_IDS.ASSISTANT ? null : TOOL_IDS.ASSISTANT));
            }
        };
        document.addEventListener('keydown', handler, true);
        return () => document.removeEventListener('keydown', handler, true);
    }, [aiEnabled]);

    useEffect(() => {
        window.localStorage.setItem('assistant.width', String(assistantWidth));
    }, [assistantWidth]);

    /**
     * Jump from the panel to its settings.
     *
     * The category is written before navigating because that is where the
     * settings shell reads it from, so this lands on the Assistant page rather
     * than on whichever one was open last.
     */
    const handleOpenAssistantSettings = useCallback(() => {
        window.localStorage.setItem('settings.category', 'assistant');
        setActiveTabId('home');
        setActiveNav('settings');
        setReachedForPage(count => count + 1);
    }, [setActiveTabId]);

    /**
     * The things the assistant cannot do for itself.
     *
     * Opening a session means creating a tab, and tabs live here. So the main
     * process asks, this answers, and the tool on the other side is held until
     * it does. Connecting is the interesting one: a tab existing is not the
     * same as a connection working, so the reply waits for the pane to report
     * back rather than claiming success the moment the tab appears.
     */
    useEffect(() => {
        if (!aiEnabled) return undefined;
        return window.api.ai.onAction(async ({ requestId, action, hostId, sessionId, data }) => {
            const respond = (result) => window.api.ai.respondToAction(requestId, result);

            try {
                if (action === 'connect') {
                    const host = hosts.find(entry => entry.id === hostId);
                    if (!host) {
                        respond({ success: false, message: 'That host is no longer saved' });
                        return;
                    }

                    const opened = handleConnect(host);
                    if (!opened?.tabId) {
                        respond({ success: false, message: 'The session could not be opened' });
                        return;
                    }

                    const result = await new Promise((resolve) => {
                        assistantConnects.current.set(opened.tabId, resolve);
                        setTimeout(() => {
                            if (assistantConnects.current.delete(opened.tabId)) {
                                resolve({ success: false, message: 'The connection did not complete in time' });
                            }
                        }, 60000);
                    });
                    respond(result);
                    return;
                }

                if (action === 'disconnect') {
                    const controls = paneConnections.current.get(sessionId);
                    if (!controls) {
                        respond({ success: false, message: 'That session is not open here' });
                        return;
                    }
                    controls.disconnect();
                    respond({ success: true });
                    return;
                }

                if (action === 'input') {
                    // Straight to the one session, deliberately not through
                    // handlePaneInput: a tool that names a session must not be
                    // multiplied across every pane by whatever broadcast mode
                    // happens to be on.
                    window.api.ssh.sendInput(sessionId, data);
                    respond({ success: true });
                    return;
                }

                respond({ success: false, message: `Unknown action "${action}"` });
            } catch (error) {
                respond({ success: false, message: error.message });
            }
        });
    }, [hosts, handleConnect, paneConnections, aiEnabled]);

    /**
     * A sheet belongs to the page it was opened from. Leaving that page (to
     * another section of Home, or out to a terminal tab) has to take it with
     * you. Home stays mounted behind a terminal tab rather than unmounting, so
     * without this an open editor would sit over the shell you switched to.
     *
     * Nothing is animated here on purpose: the page the sheet was over is no
     * longer the page on screen, and sliding it away over its replacement puts
     * the motion somewhere it does not belong. Being reached for is the case
     * that does animate, and the sheet handles that itself.
     */
    useEffect(() => {
        setHostModalOpen(false);
        setFolderModalOpen(false);
    }, [activeNav, activeTabId]);

    const handleNewHost = useCallback(() => {
        setEditingHost(null);
        setHostModalOpen(true);
    }, []);

    const handleEditHost = useCallback((host) => {
        setEditingHost(host);
        setHostModalOpen(true);
    }, []);

    /**
     * The tags already in use anywhere in the collection, most used first.
     *
     * Resolved here rather than in the editor because the editor only ever sees
     * one host, and the whole point of offering them is that a tag is shared:
     * you should be able to see that "staging" exists before typing "stage".
     */
    const allTags = useMemo(() => tagCounts(hosts).map(entry => entry.tag), [hosts]);

    const handleSaveHost = useCallback(async (hostData) => {
        const isEditing = !!hostData.id;
        // A new host is filed where you are standing. An edited one keeps the
        // folder it is already in: the editor can be opened from a search
        // result belonging to another one, and saving is not a move.
        await saveHost(isEditing ? hostData : { ...hostData, folderId: currentFolderId });
        // Closing is the sheet's job: it animates out and then unmounts itself
        // through onClose. Clearing the flag here would cut that short.
        toast.success(isEditing ? `Host "${hostData.name}" updated` : `Host "${hostData.name}" created`, { style: getToastStyle() });
    }, [saveHost, currentFolderId]);

    const handleDeleteHost = useCallback(async (hostId) => {
        await deleteHost(hostId);
    }, [deleteHost]);

    // Copied in the main process, where the credentials are; the renderer has
    // only ever seen the redacted record.
    const handleDuplicateHost = useCallback(async (host) => {
        await duplicateHost(host.id);
    }, [duplicateHost]);

    /** An import writes hosts and keys straight to the store, behind our state. */
    const handleDataImported = useCallback(() => {
        loadData();
        loadKeys();
    }, [loadData, loadKeys]);

    // A setup pulled down from another device adds hosts and keys without the
    // renderer asking for anything, so the sidebar has to be told rather than
    // left showing whatever it loaded at startup.
    useEffect(() => window.api.cloudSnapshot.onState((state) => {
        if (state?.pulled && state.added > 0) {
            loadData();
            loadKeys();
        }
    }), [loadData, loadKeys]);

    // Carries terminal settings to and from the snapshot; they live in
    // localStorage, which main cannot reach.
    useSettingsSnapshot();

    // Folder modal handlers
    const handleNewFolder = useCallback(() => {
        setEditingFolder(null);
        setFolderModalOpen(true);
    }, []);

    const handleEditFolder = useCallback((folder) => {
        setEditingFolder(folder);
        setFolderModalOpen(true);
    }, []);

    const handleSaveFolder = useCallback(async (folderData) => {
        // Same rule as a host: only a new folder is filed where you are
        // standing. Renaming one must not also move it.
        await saveFolder(folderData.id ? folderData : { ...folderData, parentId: currentFolderId });
        // The sheet closes itself once it has finished animating out.
    }, [saveFolder, currentFolderId]);

    const handleDeleteFolder = useCallback(async (folderId) => {
        await deleteFolder(folderId);
    }, [deleteFolder]);

    /**
     * Make a folder without opening the editor, and hand it back.
     *
     * The Hosts page gathers a selection into a new folder, which needs the
     * record (its id, specifically) before it can move anything into it. The
     * sheet is a form; this is one step of a larger action.
     */
    const handleCreateFolder = useCallback((folder) => saveFolder(folder), [saveFolder]);

    const handleDeleteMany = useCallback(async (selection) => {
        await deleteMany(selection);
    }, [deleteMany]);

    const handleNavigateFolder = useCallback((folderId) => {
        setCurrentFolderId(folderId);
    }, []);

    /**
     * Which session is which, when several of them are on the same host.
     *
     * Computed once here rather than in each of the two places that show a
     * session, because the whole value of the number is that the tab and the
     * assistant's scope menu agree on it. Two lists counting separately would
     * be worse than no numbers at all: they would look authoritative and point
     * at different terminals.
     *
     * Every terminal pane is counted, connected or not, so a session dropping
     * does not silently renumber the ones beside it.
     */
    const sessionOrdinals = useMemo(() => {
        const entries = [];
        for (const tab of tabs) {
            if (tab.type !== 'terminal') continue;
            for (const pane of collectPanes(tab.layout)) {
                if (pane.mode !== 'terminal') continue;
                entries.push({ id: pane.id, key: pane.host?.id || pane.title || '' });
            }
        }
        return numberSessions(entries);
    }, [tabs]);

    /**
     * What the tab strip needs to know, which is about the tab's focused pane
     * rather than the tab. Derived rather than mirrored into the tab, so a
     * split can never leave the strip describing a pane that is gone.
     */
    const stripTabs = useMemo(() => tabs.map((tab) => {
        if (tab.type !== 'terminal') return tab;

        const panes = collectPanes(tab.layout);
        const focused = panes.find(pane => pane.id === tab.focusedPaneId) || panes[0];
        const sessions = panes.filter(pane => pane.mode === 'terminal');

        return {
            ...tab,
            // A name the user typed wins over the pane's, and keeps winning
            // after a split changes which pane is focused.
            title: tab.customTitle || focused?.title || 'Session',
            renamed: Boolean(tab.customTitle),
            // Which `web-01` this one is, when it is not the only one open. A
            // tab the user has named is already telling them apart, so it is
            // left alone: a number on a name somebody chose says nothing.
            ordinal: tab.customTitle ? 0 : (sessionOrdinals.get(focused?.id) || 0),
            host: focused?.host,
            // One pane still dialling, or dropped, is worth showing on the tab.
            connected: sessions.length > 0 && sessions.every(pane => pane.connected),
            paneCount: panes.length,
            // What the strip's own menu offers: there is nothing to disconnect
            // with none of them up, and nothing to reconnect with all of them.
            sessionCount: sessions.length,
            liveCount: sessions.filter(pane => pane.connected).length,
        };
    }), [tabs, sessionOrdinals]);

    // Filter hosts and folders for current view
    const currentHosts = hosts.filter(h => (h.folderId || '') === currentFolderId);
    const currentFolders = folders.filter(f => (f.parentId || '') === currentFolderId);

    /**
     * Hosts with a session open somewhere in the window, so the Hosts page can
     * mark them. Derived from the tabs rather than tracked alongside them: a
     * mirrored set would be one more thing to keep in step every time a pane
     * opens, drops or closes.
     */
    const connectedHostIds = useMemo(() => {
        const ids = new Set();
        for (const tab of tabs) {
            if (tab.type !== 'terminal') continue;
            for (const pane of collectPanes(tab.layout)) {
                if (pane.mode === 'terminal' && pane.connected && pane.host?.id) ids.add(pane.host.id);
            }
        }
        return ids;
    }, [tabs]);

    /**
     * The sessions the assistant can be pointed at, and which one is in front.
     *
     * Derived from the tab tree rather than asked for over IPC: the tree is
     * the model of what is open, and a second list that could disagree with it
     * is a bug waiting to happen.
     */
    const assistantSessions = useMemo(() => {
        const sessions = [];
        for (const tab of tabs) {
            if (tab.type !== 'terminal') continue;
            for (const pane of collectPanes(tab.layout)) {
                if (pane.mode !== 'terminal' || !pane.connected) continue;
                sessions.push({
                    sessionId: pane.id,
                    // The saved host this terminal came from, when it came from
                    // one. It is what lets the scope menu say a host already
                    // has sessions open, and what lets pinning that host cover
                    // them without naming each one.
                    hostId: pane.host?.id || '',
                    hostName: pane.host?.name || pane.title || '',
                    address: pane.host?.host || '',
                    // The same pair the tab strip draws this session's icon
                    // from, so a row in the assistant's picker and the tab it
                    // refers to are recognisably the same machine.
                    os: hostOs(pane.host),
                    distro: pane.host?.distro || '',
                    // The same number the tab strip is showing, so "the second
                    // web-01" means one terminal rather than two.
                    ordinal: sessionOrdinals.get(pane.id) || 0,
                });
            }
        }
        return sessions;
    }, [tabs, sessionOrdinals]);

    const activeSessionId = useMemo(() => {
        const tab = tabs.find(entry => entry.id === activeTabId);
        if (tab?.type !== 'terminal') return '';
        const pane = findPane(tab.layout, tab.focusedPaneId);
        return pane?.mode === 'terminal' && pane.connected ? pane.id : '';
    }, [tabs, activeTabId]);

    return (
        // `app-drag` turns the gutter around the shell into a window frame you
        // can drag; `#app-layout` below opts back out for the content.
        <div
            className="h-full flex flex-col bg-surface-base text-gray-900 dark:text-gray-100 font-inter overflow-hidden app-drag selection:bg-yellow-500/30 selection:text-yellow-600 dark:selection:text-yellow-400"
            style={{
                // A single gutter around the shell, and the same value between
                // the title bar and the content below it. Fullscreen drops it
                // so the terminal reaches the window edges.
                padding: fullscreenTabId ? 0 : APP_GUTTER,
                gap: fullscreenTabId ? 0 : APP_GUTTER,
            }}
        >
            {!fullscreenTabId && (
                <TitleBar
                    tabs={stripTabs}
                    activeTabId={activeTabId}
                    onTabClick={handleTabClick}
                    onTabClose={handleCloseTab}
                    onTabCloseOthers={handleCloseOtherTabs}
                    onTabCloseRight={handleCloseTabsToRight}
                    onTabDuplicate={handleDuplicateTab}
                    onTabDisconnect={handleDisconnectTab}
                    onTabReconnect={handleReconnectTab}
                    onTabRename={handleRenameTab}
                    onTabColor={handleColorTab}
                    onTabGroup={handleGroupTab}
                    onTabUngroup={handleUngroupTab}
                    onTabNewGroup={handleNewGroupFromTab}
                    onTabReorder={handleReorderTabs}
                    onGroupRename={handleRenameGroup}
                    onGroupColor={handleColorGroup}
                    onGroupDelete={handleDeleteGroup}
                    groups={tabGroups}
                    showLogo={showLogo}
                    logoImage={logoImage}
                    logoSide={logoSide}
                    broadcast={broadcast}
                    broadcastCount={broadcastCount}
                    onBroadcastChange={setBroadcast}
                    onNewSession={handleNewTab}
                />
            )}

            {!fullscreenTabId && <BuiltinRestartBanner />}

            <div className="flex flex-1 min-h-0 app-no-drag" id="app-layout">
                <Sidebar
                    activeNav={activeNav}
                    onNavChange={handleNavChange}
                    isTerminalView={activeTabId !== 'home'}
                />

                <main className="flex-1 relative overflow-hidden flex flex-col" id="main-content">
                    {/* Home view - show when home tab is active */}
                    <div style={{
                        visibility: activeTabId === 'home' ? 'visible' : 'hidden',
                        position: activeTabId === 'home' ? 'relative' : 'absolute',
                        top: 0,
                        left: 0,
                        right: 0,
                        bottom: 0,
                        zIndex: activeTabId === 'home' ? 10 : 0,
                        display: 'flex',
                        flexDirection: 'column',
                        flex: 1
                    }}>
                        <HomeView
                            activeNav={activeNav}
                            isActive={activeTabId === 'home'}
                            reachedForPage={reachedForPage}
                            hosts={currentHosts}
                            folders={currentFolders}
                            allHosts={hosts}
                            allFolders={folders}
                            currentFolderId={currentFolderId}
                            connectedHostIds={connectedHostIds}
                            theme={theme}
                            darkTint={darkTint}
                            lightTint={lightTint}
                            appColors={appColors}
                            lightAppColors={lightAppColors}
                            resolvedDark={resolvedDark}
                            showLogo={showLogo}
                            logoImage={logoImage}
                            logoSide={logoSide}
                            terminalTheme={terminalTheme}
                            customTerminalTheme={customTerminalTheme}
                            terminalSettings={terminalSettings}
                            terminalFonts={terminalFonts}
                            onThemeChange={setTheme}
                            onDarkTintChange={setDarkTint}
                            onLightTintChange={setLightTint}
                            onAppColorsChange={setAppColors}
                            onLightAppColorsChange={setLightAppColors}
                            onShowLogoChange={setShowLogo}
                            onLogoImageChange={setLogoImage}
                            onLogoSideChange={setLogoSide}
                            quickThemeSwitcherEnabled={quickThemeSwitcherEnabled}
                            onQuickThemeSwitcherEnabledChange={setQuickThemeSwitcherEnabled}
                            onTerminalThemeChange={setTerminalTheme}
                            onCustomTerminalThemeChange={setCustomTerminalTheme}
                            onTerminalSettingsChange={setTerminalSettings}
                            onTerminalSettingsReset={resetTerminalSettings}
                            onDataImported={handleDataImported}
                            aiEnabled={aiEnabled}
                            onNewHost={handleNewHost}
                            onEditHost={handleEditHost}
                            onDuplicateHost={handleDuplicateHost}
                            onDeleteHost={handleDeleteHost}
                            onConnect={handleConnect}
                            onQuickConnect={async (address, source) => {
                                const host = await openAddress(address, source);
                                if (host) handleConnect(host);
                            }}
                            onNewFolder={handleNewFolder}
                            onCreateFolder={handleCreateFolder}
                            onEditFolder={handleEditFolder}
                            onDeleteFolder={handleDeleteFolder}
                            onDeleteMany={handleDeleteMany}
                            onNavigateFolder={handleNavigateFolder}
                            onArrange={arrangeItems}
                            onTagHosts={tagHosts}
                            // Keychain props
                            keys={keys}
                            onLoadKeys={loadKeys}
                            onSaveKey={saveKey}
                            onDeleteKey={deleteKey}
                            onGenerateKey={generateKey}
                        />
                    </div>

                    {/* Launcher tabs - the host picker lives in the tab itself */}
                    {tabs.filter(t => t.type === 'launcher').map(tab => (
                        <div
                            key={tab.id}
                            style={{
                                visibility: activeTabId === tab.id ? 'visible' : 'hidden',
                                position: 'absolute',
                                top: 0,
                                left: 0,
                                right: 0,
                                bottom: 0,
                                zIndex: activeTabId === tab.id ? 10 : 0,
                                display: 'flex',
                                flexDirection: 'column',
                            }}
                        >
                            <NewTabView
                                hosts={hosts}
                                folders={folders}
                                isActive={activeTabId === tab.id}
                                onConnect={(host) => handleConnect(host, tab.id)}
                                onQuickConnect={async (address) => {
                                    const host = await openAddress(address);
                                    if (host) handleConnect(host, tab.id);
                                }}
                                onNewHost={handleNewHost}
                                onClose={() => handleCloseTab(tab.id)}
                            />
                        </div>
                    ))}

                    {/* Render ALL terminal tabs - use visibility to show/hide */}
                    {tabs.filter(t => t.type === 'terminal').map((tab) => {
                        const isActiveTab = activeTabId === tab.id;
                        const split = paneCount(tab.layout) > 1;

                        return (
                            <div
                                key={tab.id}
                                data-tab-panes={tab.id}
                                style={{
                                    visibility: isActiveTab ? 'visible' : 'hidden',
                                    position: 'absolute',
                                    top: 0,
                                    left: 0,
                                    right: 0,
                                    bottom: 0,
                                    zIndex: isActiveTab ? 10 : 0,
                                }}
                            >
                                <SplitLayout
                                    layout={tab.layout}
                                    focusedPaneId={tab.focusedPaneId}
                                    zoomedPaneId={tab.zoomedPaneId}
                                    onResizeSplit={(splitId, sizes) => handleResizeSplit(tab.id, splitId, sizes)}
                                    onEqualizeSplit={(splitId) => handleEqualizeSplit(tab.id, splitId)}
                                    renderPane={(pane, { focused }) => (
                                        pane.mode === 'picker' ? (
                                            <PanePicker
                                                hosts={hosts}
                                                isActive={isActiveTab && focused}
                                                onPick={(host) => handlePanePick(tab.id, pane.id, host)}
                                                onQuickConnect={async (address) => {
                                                    const host = await openAddress(address);
                                                    if (host) handlePanePick(tab.id, pane.id, host);
                                                }}
                                                onCancel={() => handleClosePane(tab.id, pane.id)}
                                            />
                                        ) : (
                                            <TerminalView
                                                pane={pane}
                                                ordinal={sessionOrdinals.get(pane.id) || 0}
                                                terminalTheme={terminalTheme}
                                                customTerminalTheme={customTerminalTheme}
                                                terminalSettings={terminalSettings}
                                                broadcast={broadcast}
                                                // Under 'tab' scope only the tab
                                                // in front is in range, which is
                                                // the tab the keys are typed in.
                                                isBroadcastTarget={
                                                    broadcast === 'window'
                                                    || (broadcast === 'tab' && isActiveTab)
                                                }
                                                broadcastCount={broadcastCount}
                                                onBroadcastChange={setBroadcast}
                                                onInput={handlePaneInput}
                                                isActive={isActiveTab}
                                                isFocused={focused}
                                                isSplit={split}
                                                isZoomed={tab.zoomedPaneId === pane.id}
                                                canSplit={paneCount(tab.layout) < MAX_PANES}
                                                isFullscreen={fullscreenTabId === tab.id}
                                                onToggleFullscreen={() => handleToggleFullscreen(tab.id)}
                                                onFocus={() => handleFocusPane(tab.id, pane.id)}
                                                onSplit={(direction, source) => handleSplitPane(tab.id, pane.id, direction, source)}
                                                onToggleZoom={() => handleToggleZoom(tab.id, pane.id)}
                                                onClosePane={() => handleClosePane(tab.id, pane.id)}
                                                onConnectResult={handleConnectResult}
                                                onConnectionChange={handleConnectionChange}
                                                onRegisterConnection={registerPaneConnection}
                                                onUpdateHost={handleUpdateHost}
                                                hostKeyPrompt={hostKeyPromptFor(pane.id)}
                                                onHostKeyRespond={handleHostKeyResponse}
                                                authPrompt={authPromptFor(pane.id)}
                                                onAuthRespond={handleAuthPromptResponse}
                                            />
                                        )
                                    )}
                                />
                            </div>
                        );
                    })}
                </main>

                {/* Gated on either tool being enabled, matching QuickAccessGutter's
                    own hide-itself-when-empty rule - a build with both off
                    contributes no gutter at all. */}
                {(aiEnabled || quickThemeSwitcherEnabled) && (
                    <PanelDock
                        activePanel={activePanel}
                        onClose={() => setActivePanel(null)}
                        assistantSessions={assistantSessions}
                        assistantHosts={hosts}
                        activeSessionId={activeSessionId}
                        assistantWidth={assistantWidth}
                        onAssistantWidthChange={setAssistantWidth}
                        onOpenAssistantSettings={handleOpenAssistantSettings}
                        theme={theme}
                        darkTint={darkTint}
                        lightTint={lightTint}
                        appColors={appColors}
                        lightAppColors={lightAppColors}
                        resolvedDark={resolvedDark}
                        onThemeChange={setTheme}
                        onDarkTintChange={setDarkTint}
                        onLightTintChange={setLightTint}
                        terminalTheme={terminalTheme}
                        customTerminalTheme={customTerminalTheme}
                        onTerminalThemeChange={setTerminalTheme}
                    />
                )}

                <QuickAccessGutter toolState={quickAccessToolState} />
            </div>

            {/* Mounted only while open. The sheet animates itself out and calls
                onClose when it has finished, so there is no half-open state to
                track here. */}
            {hostModalOpen && (
                <HostModal
                    host={editingHost}
                    dismiss={reachedForPage}
                    onClose={() => { setHostModalOpen(false); setEditingHost(null); }}
                    onSave={handleSaveHost}
                    keys={keys}
                    // For the jump host picker: a host is reached through
                    // another saved host, so the editor has to see the rest.
                    hosts={hosts}
                    allTags={allTags}
                />
            )}

            {folderModalOpen && (
                <FolderModal
                    folder={editingFolder}
                    dismiss={reachedForPage}
                    onClose={() => { setFolderModalOpen(false); setEditingFolder(null); }}
                    onSave={handleSaveFolder}
                />
            )}

            {/* Host keys and authentication rounds are asked on the screen of
                the pane that is dialling. This is only for the ones that name
                no pane: the same screen, over the window, so a question can
                never end up with nowhere to be asked. */}
            {(strayHostKeyPrompt || strayAuthPrompt) && (
                <div className="fixed inset-0 z-[200] bg-surface-base text-gray-900 dark:text-white">
                    <SessionScreen
                        state={strayHostKeyPrompt ? 'hostkey' : 'auth'}
                        address={
                            strayHostKeyPrompt
                                ? `${strayHostKeyPrompt.host}:${strayHostKeyPrompt.port}`
                                : [strayAuthPrompt.username, strayAuthPrompt.host]
                                    .filter(Boolean).join('@')
                        }
                        hostKeyPrompt={strayHostKeyPrompt}
                        onHostKeyRespond={handleHostKeyResponse}
                        authPrompt={strayAuthPrompt}
                        onAuthRespond={handleAuthPromptResponse}
                    />
                </div>
            )}
        </div>
    );
}

export default App;
