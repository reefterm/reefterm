/**
 * Characterizes PluginsSection + PluginConsentDialog end to end: a plugin
 * list rendered from window.api.plugins, an invalid plugin shown with its
 * error and no toggle, and the consent flow (Review -> approve/deny) driving
 * the real IPC calls plugins/manager.js expects.
 *
 * useBuiltinPlugins.js holds module-level singleton state (see its own
 * header), so its __resetForTests() runs before every test here - without
 * it, a builtins.list() mock set in one test's beforeEach would be
 * shadowed by whatever the previous test already cached.
 */
import { describe, test, expect, vi, beforeEach } from 'vitest';
import { render, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import PluginsSection from '../../../src/renderer/components/settings/PluginsSection.jsx';
import { __resetForTests } from '../../../src/renderer/hooks/useBuiltinPlugins.js';

function plugin(overrides = {}) {
    return {
        id: 'com.example.demo',
        name: 'Demo Plugin',
        description: 'Does a demo thing.',
        version: '1.0.0',
        capabilities: [],
        state: 'running',
        ...overrides,
    };
}

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

describe('PluginsSection', () => {
    beforeEach(() => {
        __resetForTests();
        window.api = {
            plugins: {
                list: vi.fn().mockResolvedValue([]),
                rescan: vi.fn().mockResolvedValue([]),
                respondToConsent: vi.fn().mockResolvedValue({ success: true }),
                setEnabled: vi.fn().mockResolvedValue({ success: true }),
                onCrash: vi.fn(() => () => {}),
                onExit: vi.fn(() => () => {}),
                onStartFailed: vi.fn(() => () => {}),
                builtins: {
                    list: vi.fn().mockResolvedValue([]),
                    setEnabled: vi.fn().mockResolvedValue({ success: true }),
                },
            },
            window: {
                restart: vi.fn(),
            },
        };
    });

    test('an empty plugins folder says so, not nothing', async () => {
        render(<PluginsSection />);
        expect(await screen.findByText(/nothing found in the plugins folder/i)).toBeInTheDocument();
    });

    test('lists a running plugin with its id and an enabled toggle', async () => {
        window.api.plugins.list.mockResolvedValue([plugin()]);
        render(<PluginsSection />);

        expect(await screen.findByText('Demo Plugin')).toBeInTheDocument();
        expect(screen.getByText('com.example.demo')).toBeInTheDocument();
        expect(screen.getByRole('switch', { name: /enable demo plugin/i })).toHaveAttribute('aria-checked', 'true');
    });

    test('an invalid plugin shows its error and gets no toggle', async () => {
        window.api.plugins.list.mockResolvedValue([{
            id: 'com.example.broken',
            state: 'invalid',
            error: 'plugin.json is missing a "entry" string',
            name: 'com.example.broken',
            capabilities: [],
        }]);
        render(<PluginsSection />);

        expect(await screen.findByText(/plugin\.json is missing/i)).toBeInTheDocument();
        expect(screen.queryByRole('switch')).not.toBeInTheDocument();
    });

    test('turning a running plugin off calls setEnabled(false)', async () => {
        window.api.plugins.list.mockResolvedValue([plugin()]);
        const user = userEvent.setup();
        render(<PluginsSection />);

        const toggle = await screen.findByRole('switch', { name: /enable demo plugin/i });
        await user.click(toggle);

        expect(window.api.plugins.setEnabled).toHaveBeenCalledWith('com.example.demo', false);
    });

    test('rescan asks the bridge and redraws the list it returns', async () => {
        window.api.plugins.list.mockResolvedValue([]);
        window.api.plugins.rescan.mockResolvedValue([plugin({ id: 'com.example.found' })]);
        const user = userEvent.setup();
        render(<PluginsSection />);

        await screen.findByText(/nothing found/i);
        await user.click(screen.getByRole('button', { name: /rescan/i }));

        expect(await screen.findByText('com.example.found')).toBeInTheDocument();
    });

    test('a pending-consent plugin can be reviewed, and approving asks for exactly what it requested', async () => {
        window.api.plugins.list.mockResolvedValue([plugin({
            state: 'pending-consent',
            pendingCapabilities: ['hosts.list'],
            capabilities: [
                { name: 'hosts.list', description: 'Read the saved host list, with secrets stripped.', granted: false },
            ],
        })]);
        const user = userEvent.setup();
        render(<PluginsSection />);

        await user.click(await screen.findByRole('button', { name: /review/i }));

        const dialog = await screen.findByRole('dialog', { name: /allow demo plugin/i });
        expect(within(dialog).getByText('hosts.list')).toBeInTheDocument();
        expect(within(dialog).getByText(/read the saved host list/i)).toBeInTheDocument();

        await user.click(within(dialog).getByRole('button', { name: /^approve$/i }));

        expect(window.api.plugins.respondToConsent).toHaveBeenCalledWith('com.example.demo', true);
        await waitFor(() => expect(screen.queryByRole('dialog')).not.toBeInTheDocument());
    });

    test('denying consent turns the plugin off instead of leaving it pending', async () => {
        window.api.plugins.list.mockResolvedValue([plugin({
            state: 'pending-consent',
            capabilities: [
                { name: 'hosts.list', description: 'Read the saved host list, with secrets stripped.', granted: false },
            ],
        })]);
        const user = userEvent.setup();
        render(<PluginsSection />);

        await user.click(await screen.findByRole('button', { name: /review/i }));
        await user.click(await screen.findByRole('button', { name: /^deny$/i }));

        expect(window.api.plugins.respondToConsent).toHaveBeenCalledWith('com.example.demo', false);
    });

    test('the Builtin section renders above Installed, with a restart note', async () => {
        window.api.plugins.builtins.list.mockResolvedValue([builtin()]);
        window.api.plugins.list.mockResolvedValue([plugin()]);
        render(<PluginsSection />);

        const builtinHeading = await screen.findByText('Built-in');
        const installedHeading = await screen.findByText('Installed');
        expect(screen.getByText('AI Assistant')).toBeInTheDocument();
        expect(screen.getByText(/restart reefterm/i)).toBeInTheDocument();
        // DOCUMENT_POSITION_FOLLOWING: installedHeading comes after builtinHeading.
        expect(builtinHeading.compareDocumentPosition(installedHeading) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
    });

    test('with no builtins, the Builtin section is not rendered at all', async () => {
        window.api.plugins.builtins.list.mockResolvedValue([]);
        render(<PluginsSection />);

        await screen.findByText(/nothing found in the plugins folder/i);
        expect(screen.queryByText('Built-in')).not.toBeInTheDocument();
    });

    test('toggling a builtin off calls plugins.builtins.setEnabled', async () => {
        window.api.plugins.builtins.list.mockResolvedValue([builtin()]);
        const user = userEvent.setup();
        render(<PluginsSection />);

        const toggle = await screen.findByRole('switch', { name: /enable ai assistant/i });
        await user.click(toggle);

        expect(window.api.plugins.builtins.setEnabled).toHaveBeenCalledWith('com.reefterm.builtin.ai', false);
    });

    test('a builtin with nothing pending shows no "Pending restart" label', async () => {
        window.api.plugins.builtins.list.mockResolvedValue([builtin()]);
        render(<PluginsSection />);

        await screen.findByText('AI Assistant');
        expect(screen.queryByText(/pending restart/i)).not.toBeInTheDocument();
    });

    test('a successful toggle that leaves the builtin pending shows the label, sourced from main', async () => {
        window.api.plugins.builtins.list
            .mockResolvedValueOnce([builtin()])
            .mockResolvedValueOnce([builtin({ enabled: false, pendingRestart: true })]);
        const user = userEvent.setup();
        render(<PluginsSection />);

        await user.click(await screen.findByRole('switch', { name: /enable ai assistant/i }));

        expect(await screen.findByText(/pending restart/i)).toBeInTheDocument();
    });

    test('toggling back to the original value makes the label disappear again', async () => {
        window.api.plugins.builtins.list
            .mockResolvedValueOnce([builtin()])
            .mockResolvedValueOnce([builtin({ enabled: false, pendingRestart: true })])
            .mockResolvedValueOnce([builtin({ enabled: true, pendingRestart: false })]);
        const user = userEvent.setup();
        render(<PluginsSection />);

        await user.click(await screen.findByRole('switch', { name: /enable ai assistant/i }));
        await screen.findByText(/pending restart/i);

        await user.click(await screen.findByRole('switch', { name: /enable ai assistant/i }));

        await waitFor(() => expect(screen.queryByText(/pending restart/i)).not.toBeInTheDocument());
    });
});
