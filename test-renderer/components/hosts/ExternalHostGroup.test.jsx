/**
 * Characterizes ExternalHostGroup: the Hosts screen's labelled, collapsible
 * group for a plugin's own hosts (plugins/ui-extensions.js's
 * `hosts.externalHost` point). Nothing here is a saved host, so this never
 * touches the vault - it only has to show the group, say which plugin it
 * came from, and hand back the node a click was about.
 */
import { describe, test, expect, vi, beforeEach } from 'vitest';
import { render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import ExternalHostGroup from '../../../src/renderer/components/hosts/ExternalHostGroup.jsx';

const HOSTS = [
    { id: 'db-1', node: { type: 'host', label: 'db-1', host: '10.0.0.5', port: 2222, username: 'deploy', tags: ['prod'] } },
    { id: 'db-2', node: { type: 'host', label: 'db-2', host: '10.0.0.6' } },
];

describe('ExternalHostGroup', () => {
    test('renders nothing for an empty host list', () => {
        const { container } = render(<ExternalHostGroup pluginName="Warpgate" hosts={[]} onConnect={vi.fn()} />);
        expect(container).toBeEmptyDOMElement();
    });

    test('shows the plugin name, a count, and a card per host', () => {
        render(<ExternalHostGroup pluginName="Warpgate" hosts={HOSTS} onConnect={vi.fn()} />);
        expect(screen.getByText('Warpgate')).toBeInTheDocument();
        expect(screen.getByText('2')).toBeInTheDocument();
        expect(screen.getByText('db-1')).toBeInTheDocument();
        expect(screen.getByText('db-2')).toBeInTheDocument();
        expect(screen.getByText('deploy@10.0.0.5:2222')).toBeInTheDocument();
    });

    test('the eyebrow names the plugin, for a reader who wants to know why these are here', () => {
        render(<ExternalHostGroup pluginName="Warpgate" hosts={HOSTS} onConnect={vi.fn()} />);
        expect(screen.getByTitle('Shown by Warpgate')).toBeInTheDocument();
    });

    test('collapsing the group hides its cards without unmounting the eyebrow', async () => {
        const user = userEvent.setup();
        render(<ExternalHostGroup pluginName="Warpgate" hosts={HOSTS} onConnect={vi.fn()} />);

        await user.click(screen.getByTitle('Shown by Warpgate'));
        expect(screen.queryByText('db-1')).not.toBeInTheDocument();
        expect(screen.getByText('Warpgate')).toBeInTheDocument();

        await user.click(screen.getByTitle('Shown by Warpgate'));
        expect(screen.getByText('db-1')).toBeInTheDocument();
    });

    test('clicking a card connects with that host\'s own node, not another one\'s', async () => {
        const user = userEvent.setup();
        const onConnect = vi.fn();
        render(<ExternalHostGroup pluginName="Warpgate" hosts={HOSTS} onConnect={onConnect} />);

        await user.click(screen.getByText('db-2'));
        expect(onConnect).toHaveBeenCalledTimes(1);
        expect(onConnect).toHaveBeenCalledWith(HOSTS[1].node);
    });

    describe('right-click menu', () => {
        beforeEach(() => {
            vi.spyOn(navigator.clipboard, 'writeText').mockResolvedValue(undefined);
        });

        test('right-clicking a card offers exactly Connect, Copy address and Save as host', async () => {
            const user = userEvent.setup();
            render(<ExternalHostGroup pluginName="Warpgate" hosts={HOSTS} onConnect={vi.fn()} onSaveAsHost={vi.fn()} />);

            await user.pointer({ keys: '[MouseRight]', target: screen.getByText('db-1') });

            expect(screen.getByRole('menuitem', { name: 'Connect' })).toBeInTheDocument();
            expect(screen.getByRole('menuitem', { name: 'Copy address' })).toBeInTheDocument();
            expect(screen.getByRole('menuitem', { name: 'Save as host…' })).toBeInTheDocument();
        });

        test('Connect from the menu acts on the right-clicked host, not the first one', async () => {
            const user = userEvent.setup();
            const onConnect = vi.fn();
            render(<ExternalHostGroup pluginName="Warpgate" hosts={HOSTS} onConnect={onConnect} onSaveAsHost={vi.fn()} />);

            await user.pointer({ keys: '[MouseRight]', target: screen.getByText('db-2') });
            await user.click(screen.getByRole('menuitem', { name: 'Connect' }));

            expect(onConnect).toHaveBeenCalledWith(HOSTS[1].node);
        });

        test('Copy address puts the same address the connect path would dial on the clipboard', async () => {
            const user = userEvent.setup();
            render(<ExternalHostGroup pluginName="Warpgate" hosts={HOSTS} onConnect={vi.fn()} onSaveAsHost={vi.fn()} />);

            await user.pointer({ keys: '[MouseRight]', target: screen.getByText('db-1') });
            await user.click(screen.getByRole('menuitem', { name: 'Copy address' }));

            expect(navigator.clipboard.writeText).toHaveBeenCalledWith('deploy@10.0.0.5:2222');
        });

        test('Save as host hands back the right-clicked node, for the caller to prefill the editor from', async () => {
            const user = userEvent.setup();
            const onSaveAsHost = vi.fn();
            render(<ExternalHostGroup pluginName="Warpgate" hosts={HOSTS} onConnect={vi.fn()} onSaveAsHost={onSaveAsHost} />);

            await user.pointer({ keys: '[MouseRight]', target: screen.getByText('db-2') });
            await user.click(screen.getByRole('menuitem', { name: 'Save as host…' }));

            expect(onSaveAsHost).toHaveBeenCalledWith(HOSTS[1].node);
        });
    });
});
