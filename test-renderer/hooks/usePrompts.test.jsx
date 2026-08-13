/**
 * Characterizes usePrompts, extracted out of App.jsx: routing a host-key or
 * keyboard-interactive prompt to the pane that raised it (or a fallback pane
 * when none was named), answering it, and finding what a given pane is
 * waiting on.
 */
import { describe, test, expect, vi, beforeEach } from 'vitest';
import { act, renderHook } from '@testing-library/react';
import usePrompts from '../../src/renderer/hooks/usePrompts.js';

function makePane(id) {
    return { id, type: 'leaf', hostId: id };
}

function makeTerminalTab(id, focusedPaneId = id) {
    return { id, type: 'terminal', layout: makePane(id), focusedPaneId };
}

/** A stand-in for App.jsx's tabsRef/activeTabIdRef/setActiveTabId trio. */
function makeHarness(initialTabs, initialActiveTabId) {
    const tabsRef = { current: initialTabs };
    const activeTabIdRef = { current: initialActiveTabId };
    const setActiveTabId = vi.fn((id) => { activeTabIdRef.current = id; });
    const locatePane = vi.fn((paneId) => {
        for (const tab of tabsRef.current) {
            if (tab.type !== 'terminal') continue;
            if (tab.layout.id === paneId) return { tab, pane: tab.layout };
        }
        return null;
    });
    return { tabsRef, activeTabIdRef, setActiveTabId, locatePane };
}

describe('usePrompts', () => {
    let onHostKeyPrompt;
    let onAuthPrompt;

    beforeEach(() => {
        onHostKeyPrompt = null;
        onAuthPrompt = null;
        window.api = {
            hostKeys: {
                onPrompt: vi.fn((cb) => { onHostKeyPrompt = cb; return () => { onHostKeyPrompt = null; }; }),
                respond: vi.fn(),
            },
            auth: {
                onPrompt: vi.fn((cb) => { onAuthPrompt = cb; return () => { onAuthPrompt = null; }; }),
                respond: vi.fn(),
            },
        };
    });

    test('a prompt naming a live pane is queued against that pane, and switches to its tab', () => {
        const harness = makeHarness([makeTerminalTab('a'), makeTerminalTab('b')], 'a');
        const { result } = renderHook(() => usePrompts(harness));

        act(() => onHostKeyPrompt({ requestId: 'r1', tabId: 'b', fingerprint: 'aa:bb' }));

        expect(harness.setActiveTabId).toHaveBeenCalledWith('b');
        expect(result.current.hostKeyPromptFor('b')).toMatchObject({ requestId: 'r1' });
        expect(result.current.hostKeyPromptFor('a')).toBeNull();
    });

    test('a prompt naming no pane falls back to the focused pane of the active tab', () => {
        const harness = makeHarness([makeTerminalTab('a'), makeTerminalTab('b')], 'b');
        const { result } = renderHook(() => usePrompts(harness));

        act(() => onHostKeyPrompt({ requestId: 'r1' }));

        expect(result.current.hostKeyPromptFor('b')).toMatchObject({ requestId: 'r1' });
    });

    test('a prompt naming a pane that no longer exists falls back the same way', () => {
        const harness = makeHarness([makeTerminalTab('a')], 'a');
        const { result } = renderHook(() => usePrompts(harness));

        act(() => onHostKeyPrompt({ requestId: 'r1', tabId: 'closed-pane' }));

        expect(result.current.hostKeyPromptFor('a')).toMatchObject({ requestId: 'r1' });
    });

    test('responding sends the answer over the bridge and drops the prompt from the queue', () => {
        const harness = makeHarness([makeTerminalTab('a')], 'a');
        const { result } = renderHook(() => usePrompts(harness));

        act(() => onHostKeyPrompt({ requestId: 'r1', tabId: 'a' }));
        expect(result.current.hostKeyPromptFor('a')).not.toBeNull();

        act(() => result.current.handleHostKeyResponse('r1', true));

        expect(window.api.hostKeys.respond).toHaveBeenCalledWith('r1', true);
        expect(result.current.hostKeyPromptFor('a')).toBeNull();
    });

    test('an auth prompt responds and clears the same way', () => {
        const harness = makeHarness([makeTerminalTab('a')], 'a');
        const { result } = renderHook(() => usePrompts(harness));

        act(() => onAuthPrompt({ requestId: 'k1', tabId: 'a' }));
        expect(result.current.authPromptFor('a')).toMatchObject({ requestId: 'k1' });

        act(() => result.current.handleAuthPromptResponse('k1', ['123456']));

        expect(window.api.auth.respond).toHaveBeenCalledWith('k1', ['123456']);
        expect(result.current.authPromptFor('a')).toBeNull();
    });

    test('a host-key prompt on a pane holds off its keyboard-interactive prompt', () => {
        const harness = makeHarness([makeTerminalTab('a')], 'a');
        const { result } = renderHook(() => usePrompts(harness));

        act(() => onHostKeyPrompt({ requestId: 'r1', tabId: 'a' }));
        act(() => onAuthPrompt({ requestId: 'k1', tabId: 'a' }));

        // The host key question comes first; the auth round is queued but not
        // surfaced for this pane until the host key is answered.
        expect(result.current.hostKeyPromptFor('a')).toMatchObject({ requestId: 'r1' });
        expect(result.current.authPromptFor('a')).toBeNull();

        act(() => result.current.handleHostKeyResponse('r1', true));

        expect(result.current.authPromptFor('a')).toMatchObject({ requestId: 'k1' });
    });
});
