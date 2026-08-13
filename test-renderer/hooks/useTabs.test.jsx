/**
 * Characterizes useTabs, extracted out of App.jsx: tab and pane CRUD, tab
 * groups, session restore/persist, and connection-result bookkeeping. Not
 * exhaustive over all ~30 handlers - covers the highest-risk logic (pane
 * tree operations, the close cascade, groups, restore from localStorage) and
 * leans on the full app suite (lint/build/launch) for the rest.
 */
import { describe, test, expect, vi, beforeEach } from 'vitest';
import { act, renderHook } from '@testing-library/react';
import useTabs from '../../src/renderer/hooks/useTabs.js';

function makeHost(id, overrides = {}) {
    return { id, name: id, host: `${id}.example.com`, protocol: 'ssh', ...overrides };
}

function harnessProps(overrides = {}) {
    return {
        hosts: [],
        saveHost: vi.fn(async host => host),
        assistantConnects: { current: new Map() },
        onReachedActiveTab: vi.fn(),
        toggleBroadcast: vi.fn(),
        ...overrides,
    };
}

describe('useTabs', () => {
    beforeEach(() => {
        localStorage.clear();
        localStorage.setItem('restoreSessions', 'false'); // don't restore unless a test opts in
        window.api = { ssh: { disconnect: vi.fn(), detectOS: vi.fn(() => Promise.resolve({ os: 'unknown' })) } };
    });

    test('handleNewTab opens a launcher tab and makes it active', () => {
        const { result } = renderHook(() => useTabs(harnessProps()));
        act(() => result.current.handleNewTab());

        expect(result.current.tabs.some(t => t.type === 'launcher')).toBe(true);
        expect(result.current.activeTabId).toBe(result.current.tabs.at(-1).id);
    });

    test('handleConnect creates a terminal tab whose first pane shares the tab id', () => {
        const { result } = renderHook(() => useTabs(harnessProps()));
        const host = makeHost('web-1');

        let outcome;
        act(() => { outcome = result.current.handleConnect(host); });

        expect(outcome.success).toBe(true);
        const tab = result.current.tabs.find(t => t.id === outcome.tabId);
        expect(tab.type).toBe('terminal');
        expect(tab.layout.id).toBe(outcome.tabId);
        expect(tab.layout.host).toBe(host);
        expect(result.current.activeTabId).toBe(outcome.tabId);
    });

    test('handleConnect with intoTabId replaces a launcher tab rather than opening a new one', () => {
        const { result } = renderHook(() => useTabs(harnessProps()));
        act(() => result.current.handleNewTab());
        const launcherId = result.current.tabs.at(-1).id;
        const before = result.current.tabs.length;

        act(() => result.current.handleConnect(makeHost('web-1'), launcherId));

        expect(result.current.tabs.length).toBe(before);
        expect(result.current.tabs.find(t => t.id === launcherId).type).toBe('terminal');
    });

    test('handleSplitPane adds a second pane and focuses it, up to MAX_PANES', () => {
        const { result } = renderHook(() => useTabs(harnessProps()));
        let tabId;
        act(() => { tabId = result.current.handleConnect(makeHost('a')).tabId; });

        act(() => result.current.handleSplitPane(tabId, tabId, 'row'));

        const tab = result.current.tabs.find(t => t.id === tabId);
        expect(tab.layout.kind).toBe('split');
        expect(tab.layout.children).toHaveLength(2);
        expect(tab.focusedPaneId).toBe(tab.layout.children[1].id);
    });

    test('closing the last pane in a tab closes the tab itself and disconnects it', () => {
        const { result } = renderHook(() => useTabs(harnessProps()));
        let tabId;
        act(() => { tabId = result.current.handleConnect(makeHost('a')).tabId; });

        act(() => result.current.handleClosePane(tabId, tabId));

        expect(result.current.tabs.some(t => t.id === tabId)).toBe(false);
        expect(window.api.ssh.disconnect).toHaveBeenCalledWith(tabId);
    });

    test('closing one pane of a split leaves the other and moves focus off the closed one', () => {
        const { result } = renderHook(() => useTabs(harnessProps()));
        let tabId;
        act(() => { tabId = result.current.handleConnect(makeHost('a')).tabId; });
        act(() => result.current.handleSplitPane(tabId, tabId, 'row'));
        const secondPaneId = result.current.tabs.find(t => t.id === tabId).layout.children[1].id;

        act(() => result.current.handleClosePane(tabId, secondPaneId));

        const tab = result.current.tabs.find(t => t.id === tabId);
        expect(tab.layout.kind).toBe('pane');
        expect(tab.layout.id).toBe(tabId);
        expect(tab.focusedPaneId).not.toBe(secondPaneId);
    });

    test('handleToggleZoom sets and clears zoomedPaneId on the same pane', () => {
        const { result } = renderHook(() => useTabs(harnessProps()));
        let tabId;
        act(() => { tabId = result.current.handleConnect(makeHost('a')).tabId; });

        act(() => result.current.handleToggleZoom(tabId, tabId));
        expect(result.current.tabs.find(t => t.id === tabId).zoomedPaneId).toBe(tabId);

        act(() => result.current.handleToggleZoom(tabId, tabId));
        expect(result.current.tabs.find(t => t.id === tabId).zoomedPaneId).toBeNull();
    });

    test('closing the fullscreen tab clears fullscreen state', () => {
        const { result } = renderHook(() => useTabs(harnessProps()));
        let tabId;
        act(() => { tabId = result.current.handleConnect(makeHost('a')).tabId; });
        act(() => result.current.handleToggleFullscreen(tabId));
        expect(result.current.fullscreenTabId).toBe(tabId);

        act(() => result.current.handleCloseTab(tabId));

        expect(result.current.fullscreenTabId).toBeNull();
    });

    test('closing the active tab falls back to the last remaining tab', () => {
        const { result } = renderHook(() => useTabs(harnessProps()));
        let firstId;
        act(() => { firstId = result.current.handleConnect(makeHost('a')).tabId; });
        act(() => result.current.handleConnect(makeHost('b')));

        act(() => result.current.handleCloseTab(firstId));

        expect(result.current.activeTabId).not.toBe(firstId);
        expect(result.current.tabs.some(t => t.id === result.current.activeTabId)).toBe(true);
    });

    test('the home tab cannot be closed', () => {
        const { result } = renderHook(() => useTabs(harnessProps()));
        act(() => result.current.handleCloseTab('home'));
        expect(result.current.tabs.some(t => t.id === 'home')).toBe(true);
    });

    test('handleConnectResult marks the pane connected, resolves an assistant waiter, and remembers the host', async () => {
        const saveHost = vi.fn(async host => host);
        const assistantConnects = { current: new Map() };
        const { result } = renderHook(() => useTabs(harnessProps({ saveHost, assistantConnects })));
        let tabId;
        act(() => { tabId = result.current.handleConnect(makeHost('a')).tabId; });

        const waiter = vi.fn();
        assistantConnects.current.set(tabId, waiter);

        await act(async () => {
            result.current.handleConnectResult(tabId, { success: true });
        });

        expect(result.current.tabs.find(t => t.id === tabId).layout.connected).toBe(true);
        expect(waiter).toHaveBeenCalledWith({ success: true, sessionId: tabId });
        expect(saveHost).toHaveBeenCalledWith(expect.objectContaining({ id: 'a', lastConnectedAt: expect.any(Number) }));
    });

    test('handleConnectResult does not save an ephemeral (quick-connect) host', async () => {
        const saveHost = vi.fn(async host => host);
        const { result } = renderHook(() => useTabs(harnessProps({ saveHost })));
        let tabId;
        act(() => { tabId = result.current.handleConnect(makeHost('a', { ephemeral: true })).tabId; });

        await act(async () => {
            result.current.handleConnectResult(tabId, { success: true });
        });

        expect(saveHost).not.toHaveBeenCalled();
    });

    test('handleDuplicateTab copies a single-pane tab as a fresh session on the same host', () => {
        const { result } = renderHook(() => useTabs(harnessProps()));
        const host = makeHost('a');
        let tabId;
        act(() => { tabId = result.current.handleConnect(host).tabId; });

        const before = result.current.tabs.length;
        act(() => result.current.handleDuplicateTab(tabId));

        expect(result.current.tabs).toHaveLength(before + 1);
        const copy = result.current.tabs.at(-1);
        expect(copy.layout.host).toBe(host);
        expect(copy.id).not.toBe(tabId);
        expect(result.current.activeTabId).toBe(copy.id);
    });

    test('handleNewGroupFromTab creates a group and files the tab under it in one commit', () => {
        const { result } = renderHook(() => useTabs(harnessProps()));
        let tabId;
        act(() => { tabId = result.current.handleConnect(makeHost('a')).tabId; });

        act(() => result.current.handleNewGroupFromTab(tabId));

        expect(result.current.tabGroups).toHaveLength(1);
        const group = result.current.tabGroups[0];
        expect(result.current.tabs.find(t => t.id === tabId).groupId).toBe(group.id);
    });

    test('handleDeleteGroup dissolves the group without closing its tabs', () => {
        const { result } = renderHook(() => useTabs(harnessProps()));
        let tabId;
        act(() => { tabId = result.current.handleConnect(makeHost('a')).tabId; });
        act(() => result.current.handleNewGroupFromTab(tabId));
        const groupId = result.current.tabGroups[0].id;

        act(() => result.current.handleDeleteGroup(groupId));

        expect(result.current.tabGroups).toHaveLength(0);
        expect(result.current.tabs.find(t => t.id === tabId).groupId).toBeNull();
        expect(result.current.tabs.some(t => t.id === tabId)).toBe(true);
    });

    test('handleTabClick on the already-active tab bumps onReachedActiveTab instead of switching', () => {
        const onReachedActiveTab = vi.fn();
        const { result } = renderHook(() => useTabs(harnessProps({ onReachedActiveTab })));

        act(() => result.current.handleTabClick('home'));

        expect(onReachedActiveTab).toHaveBeenCalledTimes(1);
        expect(result.current.activeTabId).toBe('home');
    });

    test('handleTabClick on a different tab switches to it', () => {
        const { result } = renderHook(() => useTabs(harnessProps()));
        let tabId;
        act(() => { tabId = result.current.handleConnect(makeHost('a')).tabId; });
        act(() => result.current.handleTabClick('home'));

        act(() => result.current.handleTabClick(tabId));

        expect(result.current.activeTabId).toBe(tabId);
    });

    test('handleUpdateHost carries an edited host into every open pane on it', async () => {
        const saveHost = vi.fn(async host => ({ ...host, name: 'renamed' }));
        const { result } = renderHook(() => useTabs(harnessProps({ saveHost })));
        const host = makeHost('a');
        let tabId;
        act(() => { tabId = result.current.handleConnect(host).tabId; });

        await act(async () => {
            await result.current.handleUpdateHost({ ...host, name: 'renamed' });
        });

        expect(result.current.tabs.find(t => t.id === tabId).layout.host.name).toBe('renamed');
    });

    test('a saved session with a legacy single-pane record restores once hosts load', () => {
        localStorage.setItem('restoreSessions', 'true');
        localStorage.setItem('session.tabs', JSON.stringify({
            tabs: [{ id: 'restored-1', hostId: 'a' }],
            activeTabId: 'restored-1',
        }));
        const host = makeHost('a');

        const { result, rerender } = renderHook(
            ({ hosts }) => useTabs(harnessProps({ hosts })),
            { initialProps: { hosts: [] } }
        );
        rerender({ hosts: [host] });

        expect(result.current.tabs.some(t => t.id === 'restored-1')).toBe(true);
        expect(result.current.activeTabId).toBe('restored-1');
    });

    test('a restored tab naming a host that no longer exists is dropped, not crashed on', () => {
        localStorage.setItem('restoreSessions', 'true');
        localStorage.setItem('session.tabs', JSON.stringify({
            tabs: [{ id: 'restored-1', hostId: 'deleted-host' }],
            activeTabId: 'restored-1',
        }));

        const { result, rerender } = renderHook(
            ({ hosts }) => useTabs(harnessProps({ hosts })),
            { initialProps: { hosts: [] } }
        );
        rerender({ hosts: [makeHost('a')] });

        expect(result.current.tabs.some(t => t.id === 'restored-1')).toBe(false);
    });
});
