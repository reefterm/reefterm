import { memo, useCallback, useState } from 'react';
import toast from 'react-hot-toast';
import {
    ArrowDown01Icon, ArrowUp01Icon, CloudServerIcon, Copy01Icon, PlusSignIcon, PuzzleIcon,
} from 'hugeicons-react';
import IconTile from './IconTile';
import Tag from '../ui/Tag';
import ContextMenu from '../ui/ContextMenu';
import { formatAddress } from '../../lib/address';
import { toastOptions } from '../../lib/toast';
import { CARD_GRID } from '../../lib/layout';

/**
 * A plugin's own hosts (see plugins/capabilities `hosts.registerExternal`'s
 * sibling extension point, `hosts.externalHost`), shown apart from the user's
 * saved hosts rather than mixed into that grid.
 *
 * Two things that distinction buys: a DMZ a plugin lists thirty of does not
 * bury the hosts the user actually filed, and the eyebrow (with a tooltip
 * naming the plugin) keeps it obvious these were never something the user
 * saved - connecting one goes through the same ephemeral quick-connect path a
 * typed address does, and asks for credentials the same way.
 */
function ExternalHostGroup({ pluginName, hosts, onConnect, onSaveAsHost }) {
    const [collapsed, setCollapsed] = useState(false);
    /** `{ x, y, node }` for whichever card was right-clicked, or null. */
    const [menu, setMenu] = useState(null);

    const openMenu = useCallback((node, event) => {
        event.preventDefault();
        setMenu({ x: event.clientX, y: event.clientY, node });
    }, []);

    const copyAddress = useCallback(async (node) => {
        const text = formatAddress({ username: node.username, host: node.host, port: node.port });
        try {
            await navigator.clipboard.writeText(text);
            toast.success('Address copied', toastOptions({ duration: 1400 }));
        } catch {
            toast.error('Could not copy that', toastOptions());
        }
    }, []);

    if (hosts.length === 0) return null;

    const menuItems = menu ? [
        { label: 'Connect', icon: <CloudServerIcon size={15} strokeWidth={2} />, onClick: () => onConnect(menu.node) },
        { label: 'Copy address', icon: <Copy01Icon size={15} strokeWidth={2} />, onClick: () => copyAddress(menu.node) },
        {
            label: 'Save as host…',
            icon: <PlusSignIcon size={15} strokeWidth={2} />,
            // A deliberate, user-driven write into the vault - the plugin
            // never triggers this itself, and everything it prefills (name,
            // address, username) is exactly what the card already shows, not
            // anything the plugin could not already put in front of the user.
            onClick: () => onSaveAsHost(menu.node),
        },
    ] : [];

    return (
        <div className="flex flex-col gap-2">
            <button
                type="button"
                onClick={() => setCollapsed(value => !value)}
                title={`Shown by ${pluginName}`}
                className="flex items-center gap-1.5 self-start text-gray-500 dark:text-gray-400
                    hover:text-gray-700 dark:hover:text-gray-200 transition-colors"
            >
                <PuzzleIcon size={13} strokeWidth={2} />
                <span className="uppercase tracking-wide text-[11px] font-semibold">{pluginName}</span>
                <span className="text-[11px] tabular-nums opacity-70">{hosts.length}</span>
                {collapsed
                    ? <ArrowDown01Icon size={13} strokeWidth={2} />
                    : <ArrowUp01Icon size={13} strokeWidth={2} />}
            </button>

            {!collapsed && (
                <div className={CARD_GRID}>
                    {hosts.map(({ id, node }) => (
                        <ExternalHostCard
                            key={id}
                            node={node}
                            onConnect={() => onConnect(node)}
                            onContextMenu={(event) => openMenu(node, event)}
                        />
                    ))}
                </div>
            )}

            {menu && (
                <ContextMenu x={menu.x} y={menu.y} items={menuItems} onClose={() => setMenu(null)} />
            )}
        </div>
    );
}

function ExternalHostCard({ node, onConnect, onContextMenu }) {
    const address = `${node.host}${node.port ? `:${node.port}` : ''}`;
    const tags = node.tags || [];

    return (
        <div
            className="host-card org-card group relative cursor-pointer rounded-2xl p-2.5"
            role="button"
            tabIndex={0}
            onClick={onConnect}
            onContextMenu={onContextMenu}
            onKeyDown={(event) => {
                if (event.key === 'Enter' || event.key === ' ') { event.preventDefault(); onConnect(); }
            }}
        >
            <div className="flex items-center gap-2.5">
                <IconTile size="md">
                    <CloudServerIcon className="w-[22px] h-[22px]" />
                </IconTile>

                <div className="min-w-0 flex-1">
                    <h3 className="font-semibold text-gray-900 dark:text-white text-sm truncate leading-tight">
                        {node.label}
                    </h3>
                    <div className="flex items-center gap-1.5 min-w-0 mt-0.5">
                        <p
                            title={address}
                            className="flex-1 min-w-0 text-[11px] text-gray-500 dark:text-gray-400 truncate leading-tight font-mono"
                        >
                            {node.username ? `${node.username}@${address}` : address}
                        </p>
                        {tags.length > 0 && (
                            <span className="shrink-0 flex items-center gap-1">
                                {tags.slice(0, 2).map(tag => <Tag key={tag} tag={tag} size="xs" />)}
                            </span>
                        )}
                    </div>
                </div>
            </div>
        </div>
    );
}

export default memo(ExternalHostGroup);
