/**
 * Characterizes useBroadcast, extracted out of App.jsx: which panes a
 * keystroke reaches under each scope, the count shown in the title bar, and
 * the auto-off when there is nothing left to broadcast to.
 */
import { describe, test, expect, vi, beforeEach } from 'vitest';
import { act, renderHook } from '@testing-library/react';
import useBroadcast from '../../src/renderer/hooks/useBroadcast.js';

function pane(id, { connected = true, mode = 'terminal' } = {}) {
    return { kind: 'pane', id, mode, host: { id: `host-${id}` }, title: id, connected };
}

function terminalTab(id, panes) {
    const layout = panes.length === 1
        ? panes[0]
        : { kind: 'split', id: `${id}-split`, direction: 'row', children: panes, sizes: panes.map(() => 1 / panes.length) };
    return { id, type: 'terminal', layout, focusedPaneId: panes[0].id, zoomedPaneId: null };
}

describe('useBroadcast', () => {
    beforeEach(() => {
        window.api = { ssh: { sendInput: vi.fn() } };
    });

    test('scope off sends only to the originating pane', () => {
        const tabs = [terminalTab('t1', [pane('a'), pane('b')])];
        const tabsRef = { current: tabs };
        const { result } = renderHook(() => useBroadcast({ tabs, activeTabId: 't1', tabsRef }));

        act(() => result.current.handlePaneInput('a', 'ls\n'));

        expect(window.api.ssh.sendInput).toHaveBeenCalledTimes(1);
        expect(window.api.ssh.sendInput).toHaveBeenCalledWith('a', 'ls\n');
    });

    test('scope tab reaches every connected pane in the same tab, not other tabs', () => {
        const tabs = [
            terminalTab('t1', [pane('a'), pane('b')]),
            terminalTab('t2', [pane('c')]),
        ];
        const tabsRef = { current: tabs };
        const { result } = renderHook(() => useBroadcast({ tabs, activeTabId: 't1', tabsRef }));

        act(() => result.current.setBroadcast('tab'));
        act(() => result.current.handlePaneInput('a', 'x'));

        const targets = window.api.ssh.sendInput.mock.calls.map(call => call[0]).sort();
        expect(targets).toEqual(['a', 'b']);
    });

    test('scope window reaches every connected pane across every terminal tab', () => {
        const tabs = [
            terminalTab('t1', [pane('a'), pane('b')]),
            terminalTab('t2', [pane('c')]),
        ];
        const tabsRef = { current: tabs };
        const { result } = renderHook(() => useBroadcast({ tabs, activeTabId: 't1', tabsRef }));

        act(() => result.current.setBroadcast('window'));
        act(() => result.current.handlePaneInput('a', 'x'));

        const targets = window.api.ssh.sendInput.mock.calls.map(call => call[0]).sort();
        expect(targets).toEqual(['a', 'b', 'c']);
    });

    test('a disconnected pane is never a target, but the originating pane always is', () => {
        const tabs = [terminalTab('t1', [pane('a', { connected: false }), pane('b', { connected: false })])];
        const tabsRef = { current: tabs };
        const { result } = renderHook(() => useBroadcast({ tabs, activeTabId: 't1', tabsRef }));

        act(() => result.current.setBroadcast('tab'));
        act(() => result.current.handlePaneInput('a', 'x'));

        expect(window.api.ssh.sendInput).toHaveBeenCalledTimes(1);
        expect(window.api.ssh.sendInput).toHaveBeenCalledWith('a', 'x');
    });

    test('broadcastCount counts connected terminal panes in the active tab under tab scope', () => {
        const tabs = [terminalTab('t1', [pane('a'), pane('b'), pane('c', { connected: false })])];
        const { result } = renderHook(() => useBroadcast({ tabs, activeTabId: 't1', tabsRef: { current: tabs } }));

        act(() => result.current.setBroadcast('tab'));
        expect(result.current.broadcastCount).toBe(2);
    });

    test('turning broadcast on with nothing to reach turns it back off', () => {
        const tabs = [terminalTab('t1', [pane('a', { connected: false })])];
        const { result } = renderHook(() => useBroadcast({ tabs, activeTabId: 't1', tabsRef: { current: tabs } }));

        act(() => result.current.setBroadcast('tab'));

        expect(result.current.broadcast).toBe('off');
    });
});
