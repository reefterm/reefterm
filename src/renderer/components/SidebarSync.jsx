import { memo, useCallback, useEffect, useState } from 'react';
import { RefreshIcon } from 'hugeicons-react';

/**
 * The sync connection, at the foot of the sidebar.
 *
 * Clicking it goes to Settings → Sync rather than opening a menu of its own:
 * everything you would want to do from here already lives on that page, and a
 * second place to disconnect is a second place to keep in step.
 *
 * This is a connection to an optional, self-hosted sync server, not an
 * account this app manages -- the label below says "connected", never
 * "signed in", to keep that distinction visible where the user sees it most.
 */

const initial = (email) => (email || '').trim().charAt(0).toUpperCase() || '?';

function SidebarSync({ onNavChange }) {
    const [status, setStatus] = useState(null);

    useEffect(() => {
        window.api.syncConnection.status().then(setStatus);
    }, []);

    // Connecting happens on the settings page, not here.
    useEffect(() => window.api.syncConnection.onState(setStatus), []);

    const open = useCallback(() => {
        // The settings panel picks its page up from here when it mounts.
        localStorage.setItem('settings.category', 'sync');
        onNavChange('settings');
    }, [onNavChange]);

    if (!status) return null;

    const connected = status.connected && status.unlocked;
    const label = connected ? (status.email || 'Sync connected') : 'Set up sync';
    const sub = connected ? status.email : 'Optional -- sync your setup to a server you trust';

    return (
        <button
            type="button"
            onClick={open}
            title={connected ? `Sync connected as ${status.email}` : 'Set up sync'}
            className="mt-auto shrink-0 flex items-center gap-2.5 w-full px-2.5 py-2 rounded-xl text-left
                outline-none transition-colors
                text-gray-600 dark:text-gray-400
                hover:bg-surface-raised
                focus-visible:ring-2 focus-visible:ring-gray-900/20 dark:focus-visible:ring-white/25"
        >
            {connected ? (
                <span
                    aria-hidden="true"
                    className="w-7 h-7 shrink-0 rounded-full flex items-center justify-center
                        text-xs font-semibold bg-gray-900 text-white dark:bg-white dark:text-gray-900"
                >
                    {initial(status.email)}
                </span>
            ) : (
                <RefreshIcon size={26} strokeWidth={1.5} className="shrink-0" />
            )}

            <span className="min-w-0 flex-1">
                <span className="block text-sm truncate text-gray-900 dark:text-white">{label}</span>
                {sub && (
                    <span className="block text-[11px] leading-tight truncate text-gray-500 dark:text-gray-500">
                        {sub}
                    </span>
                )}
            </span>
        </button>
    );
}

export default memo(SidebarSync);
