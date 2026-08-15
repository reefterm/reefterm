/**
 * Characterizes useBuiltinPlugins: the shared window (mirroring
 * useMonitor.js's shape) onto plugins/builtins.js by way of
 * window.api.plugins.builtins, including `needsRestart` - derived purely
 * from what main reports as pendingRestart per entry, so it has to reflect
 * a toggle immediately and clear itself if the toggle is reversed.
 *
 * The hook holds module-level singleton state (deliberately, so every
 * mounted consumer - the settings page and the app-wide banner - shares one
 * answer). __resetForTests() gives each test a clean slate without the cost
 * of vi.resetModules() + reimporting the whole module graph.
 */
import { describe, test, expect, vi, beforeEach } from 'vitest';
import { act, renderHook, waitFor } from '@testing-library/react';
import useBuiltinPlugins, { __resetForTests } from '../../src/renderer/hooks/useBuiltinPlugins.js';

function sampleBuiltin(overrides = {}) {
    return {
        id: 'com.reefterm.builtin.ai',
        name: 'AI Assistant',
        description: 'Chat with an AI agent.',
        enabled: true,
        pendingRestart: false,
        ...overrides,
    };
}

describe('useBuiltinPlugins', () => {
    beforeEach(() => {
        __resetForTests();
        window.api = {
            plugins: {
                builtins: {
                    list: vi.fn().mockResolvedValue([sampleBuiltin()]),
                    setEnabled: vi.fn().mockResolvedValue({ success: true }),
                },
            },
        };
    });

    test('with no builtins bridge, settles as ready with an empty list', async () => {
        window.api = {};
        const { result } = renderHook(() => useBuiltinPlugins());

        await waitFor(() => expect(result.current.ready).toBe(true));
        expect(result.current.builtins).toEqual([]);
        expect(result.current.needsRestart).toBe(false);
    });

    test('loads the initial list on mount', async () => {
        const { result } = renderHook(() => useBuiltinPlugins());

        await waitFor(() => expect(result.current.ready).toBe(true));
        expect(result.current.builtins).toEqual([sampleBuiltin()]);
    });

    test('needsRestart is false while nothing is pending', async () => {
        const { result } = renderHook(() => useBuiltinPlugins());

        await waitFor(() => expect(result.current.ready).toBe(true));
        expect(result.current.needsRestart).toBe(false);
    });

    test('setEnabled refreshes from the bridge and needsRestart follows pendingRestart', async () => {
        window.api.plugins.builtins.list
            .mockResolvedValueOnce([sampleBuiltin()])
            .mockResolvedValueOnce([sampleBuiltin({ enabled: false, pendingRestart: true })]);
        const { result } = renderHook(() => useBuiltinPlugins());
        await waitFor(() => expect(result.current.ready).toBe(true));

        await act(async () => { await result.current.setEnabled('com.reefterm.builtin.ai', false); });

        expect(window.api.plugins.builtins.setEnabled).toHaveBeenCalledWith('com.reefterm.builtin.ai', false);
        expect(result.current.needsRestart).toBe(true);
    });

    test('toggling back to the original value clears needsRestart again', async () => {
        window.api.plugins.builtins.list
            .mockResolvedValueOnce([sampleBuiltin()])
            .mockResolvedValueOnce([sampleBuiltin({ enabled: false, pendingRestart: true })])
            .mockResolvedValueOnce([sampleBuiltin({ enabled: true, pendingRestart: false })]);
        const { result } = renderHook(() => useBuiltinPlugins());
        await waitFor(() => expect(result.current.ready).toBe(true));

        await act(async () => { await result.current.setEnabled('com.reefterm.builtin.ai', false); });
        expect(result.current.needsRestart).toBe(true);

        await act(async () => { await result.current.setEnabled('com.reefterm.builtin.ai', true); });
        expect(result.current.needsRestart).toBe(false);
    });

    test('two consumers mounted at once share the same answer', async () => {
        window.api.plugins.builtins.list
            .mockResolvedValueOnce([sampleBuiltin()])
            .mockResolvedValueOnce([sampleBuiltin({ enabled: false, pendingRestart: true })]);
        const a = renderHook(() => useBuiltinPlugins());
        const b = renderHook(() => useBuiltinPlugins());
        await waitFor(() => expect(a.result.current.ready).toBe(true));
        await waitFor(() => expect(b.result.current.ready).toBe(true));

        await act(async () => { await a.result.current.setEnabled('com.reefterm.builtin.ai', false); });

        expect(a.result.current.needsRestart).toBe(true);
        expect(b.result.current.needsRestart).toBe(true);
    });
});
