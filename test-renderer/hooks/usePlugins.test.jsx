/**
 * Characterizes usePlugins: the settings page's window onto
 * plugins/manager.js by way of window.api.plugins. list()/rescan() are the
 * source of truth; the four notify events (log/crash/exit/start-failed) are
 * what keep a row's state from going stale between rescans, and are recorded
 * as a short-lived per-id notice since list() alone says a plugin is
 * "crashed" but not why.
 */
import { describe, test, expect, vi, beforeEach } from 'vitest';
import { act, renderHook, waitFor } from '@testing-library/react';
import usePlugins from '../../src/renderer/hooks/usePlugins.js';

function samplePlugin(overrides = {}) {
    return {
        id: 'com.example.demo',
        name: 'Demo',
        description: '',
        version: '1.0.0',
        capabilities: [],
        state: 'running',
        ...overrides,
    };
}

describe('usePlugins', () => {
    let onCrash;
    let onExit;
    let onStartFailed;

    beforeEach(() => {
        onCrash = null;
        onExit = null;
        onStartFailed = null;

        window.api = {
            plugins: {
                list: vi.fn().mockResolvedValue([samplePlugin()]),
                rescan: vi.fn().mockResolvedValue([samplePlugin({ id: 'com.example.new' })]),
                respondToConsent: vi.fn().mockResolvedValue({ success: true }),
                setEnabled: vi.fn().mockResolvedValue({ success: true }),
                onCrash: vi.fn((cb) => { onCrash = cb; return () => { onCrash = null; }; }),
                onExit: vi.fn((cb) => { onExit = cb; return () => { onExit = null; }; }),
                onStartFailed: vi.fn((cb) => { onStartFailed = cb; return () => { onStartFailed = null; }; }),
            },
        };
    });

    test('with no plugins bridge, settles as ready with an empty list', async () => {
        window.api = {};
        const { result } = renderHook(() => usePlugins());

        await waitFor(() => expect(result.current.ready).toBe(true));
        expect(result.current.plugins).toEqual([]);
    });

    test('loads the initial list on mount', async () => {
        const { result } = renderHook(() => usePlugins());

        await waitFor(() => expect(result.current.ready).toBe(true));
        expect(result.current.plugins).toEqual([samplePlugin()]);
    });

    test('rescan replaces the list', async () => {
        const { result } = renderHook(() => usePlugins());
        await waitFor(() => expect(result.current.ready).toBe(true));

        await act(async () => { await result.current.rescan(); });

        expect(window.api.plugins.rescan).toHaveBeenCalled();
        expect(result.current.plugins).toEqual([samplePlugin({ id: 'com.example.new' })]);
    });

    test('respondToConsent calls the bridge, then refreshes and clears any notice for that id', async () => {
        const { result } = renderHook(() => usePlugins());
        await waitFor(() => expect(result.current.ready).toBe(true));

        act(() => onCrash({ id: 'com.example.demo', message: 'boom' }));
        await waitFor(() => expect(result.current.notices.get('com.example.demo')).toBeTruthy());

        await act(async () => { await result.current.respondToConsent('com.example.demo', true); });

        expect(window.api.plugins.respondToConsent).toHaveBeenCalledWith('com.example.demo', true);
        expect(result.current.notices.has('com.example.demo')).toBe(false);
        // The mocked list() is called again by the refresh; still resolves the
        // same sample plugin, so the list is exactly what refresh() published.
        expect(result.current.plugins).toEqual([samplePlugin()]);
    });

    test('setEnabled calls the bridge and refreshes', async () => {
        const { result } = renderHook(() => usePlugins());
        await waitFor(() => expect(result.current.ready).toBe(true));

        await act(async () => { await result.current.setEnabled('com.example.demo', false); });

        expect(window.api.plugins.setEnabled).toHaveBeenCalledWith('com.example.demo', false);
    });

    test('a crash notification is recorded per plugin id and triggers a refresh', async () => {
        const { result } = renderHook(() => usePlugins());
        await waitFor(() => expect(result.current.ready).toBe(true));
        window.api.plugins.list.mockClear();

        act(() => onCrash({ id: 'com.example.demo', message: 'it fell over' }));

        await waitFor(() => expect(window.api.plugins.list).toHaveBeenCalled());
        expect(result.current.notices.get('com.example.demo')).toEqual({ type: 'crash', message: 'it fell over' });
    });

    test('a deliberate stop (exit, expected) is not recorded as a notice', async () => {
        const { result } = renderHook(() => usePlugins());
        await waitFor(() => expect(result.current.ready).toBe(true));

        act(() => onExit({ id: 'com.example.demo', code: 0, signal: null, expected: true }));

        expect(result.current.notices.has('com.example.demo')).toBe(false);
    });

    test('an unexpected exit is recorded as a notice', async () => {
        const { result } = renderHook(() => usePlugins());
        await waitFor(() => expect(result.current.ready).toBe(true));

        act(() => onExit({ id: 'com.example.demo', code: 1, signal: null, expected: false }));

        await waitFor(() => expect(result.current.notices.get('com.example.demo')?.type).toBe('exit'));
    });

    test('a start failure is recorded as a notice', async () => {
        const { result } = renderHook(() => usePlugins());
        await waitFor(() => expect(result.current.ready).toBe(true));

        act(() => onStartFailed({ id: 'com.example.demo', message: 'no capability' }));

        await waitFor(() => expect(result.current.notices.get('com.example.demo'))
            .toEqual({ type: 'start-failed', message: 'no capability' }));
    });
});
