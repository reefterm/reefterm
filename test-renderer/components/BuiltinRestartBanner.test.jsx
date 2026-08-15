/**
 * Characterizes BuiltinRestartBanner: hidden while nothing is pending,
 * appears the moment a toggle elsewhere makes something pending (it shares
 * useBuiltinPlugins.js's module-level state, so it doesn't need its own
 * fetch to find out), and its button does a real process restart rather
 * than a renderer-only reload.
 *
 * __resetForTests() runs before every test, same reason as
 * PluginsSection.test.jsx: useBuiltinPlugins.js is a shared singleton.
 */
import { describe, test, expect, vi, beforeEach } from 'vitest';
import { render, renderHook, screen, waitFor, act } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import BuiltinRestartBanner from '../../src/renderer/components/BuiltinRestartBanner.jsx';
import useBuiltinPlugins, { __resetForTests } from '../../src/renderer/hooks/useBuiltinPlugins.js';

function builtin(overrides = {}) {
    return {
        id: 'com.reefterm.builtin.ai',
        name: 'AI Assistant',
        description: 'Chat with an AI agent.',
        enabled: true,
        pendingRestart: false,
        ...overrides,
    };
}

describe('BuiltinRestartBanner', () => {
    beforeEach(() => {
        __resetForTests();
        window.api = {
            plugins: {
                builtins: {
                    list: vi.fn().mockResolvedValue([builtin()]),
                    setEnabled: vi.fn().mockResolvedValue({ success: true }),
                },
            },
            window: { restart: vi.fn() },
        };
    });

    test('renders nothing while nothing is pending', async () => {
        render(<BuiltinRestartBanner />);
        await waitFor(() => expect(window.api.plugins.builtins.list).toHaveBeenCalled());
        expect(screen.queryByRole('button', { name: /restart now/i })).not.toBeInTheDocument();
    });

    test('appears once a toggle made elsewhere leaves something pending, with no fetch of its own', async () => {
        window.api.plugins.builtins.list
            .mockResolvedValueOnce([builtin()])
            .mockResolvedValueOnce([builtin({ enabled: false, pendingRestart: true })]);
        render(<BuiltinRestartBanner />);
        await waitFor(() => expect(window.api.plugins.builtins.list).toHaveBeenCalled());
        expect(screen.queryByRole('button', { name: /restart now/i })).not.toBeInTheDocument();

        // Simulates the Plugins page's own hook instance toggling the same
        // shared state - the banner never calls setEnabled itself.
        const { result } = renderHook(() => useBuiltinPlugins());
        await act(async () => { await result.current.setEnabled('com.reefterm.builtin.ai', false); });

        expect(await screen.findByRole('button', { name: /restart now/i })).toBeInTheDocument();
    });

    test('clicking Restart now calls a real process restart, not a window reload', async () => {
        window.api.plugins.builtins.list.mockResolvedValue([builtin({ enabled: false, pendingRestart: true })]);
        const user = userEvent.setup();
        render(<BuiltinRestartBanner />);

        await user.click(await screen.findByRole('button', { name: /restart now/i }));

        expect(window.api.window.restart).toHaveBeenCalled();
    });
});
