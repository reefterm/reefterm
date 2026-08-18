import Select from '../ui/Select';
import { useT } from '../../i18n';

/**
 * How a plugin's own hosts (see HostsPanel's `hosts.externalHost` group)
 * authenticate on a one-click connect - set here, per group plus a
 * plugin-wide default, and never seen by the plugin itself. Only shown once
 * a plugin actually has hosts to offer: most plugins never contribute one at
 * all, and this would be noise on every one of their rows otherwise.
 */

const SELECT_CLASS = 'w-44 h-8 px-2.5 rounded-lg text-xs bg-surface-control border border-surface-active '
    + 'text-gray-900 dark:text-gray-100 outline-none '
    + 'focus-visible:ring-2 focus-visible:ring-gray-900/20 dark:focus-visible:ring-white/25';

function entryToValue(entry) {
    if (entry?.method === 'key' && entry.keyId) return `key:${entry.keyId}`;
    if (entry?.method === 'agent') return 'agent';
    return 'prompt';
}

function valueToEntry(value) {
    if (value === 'agent') return { method: 'agent' };
    if (value.startsWith('key:')) return { method: 'key', keyId: value.slice(4) };
    return { method: 'prompt' };
}

function GroupRow({ label, title, entry, keys, onChange }) {
    const t = useT();
    const options = [
        { value: 'prompt', label: t('settings.plugins.credentials.prompt') },
        { value: 'agent', label: t('settings.plugins.credentials.agent') },
        ...keys.map(key => ({ value: `key:${key.id}`, label: t('settings.plugins.credentials.key', { name: key.name }) })),
    ];

    return (
        <div className="flex items-center justify-between gap-3 py-1">
            <span title={title} className="text-xs text-gray-500 dark:text-gray-400 truncate">{label}</span>
            <Select
                aria-label={label}
                value={entryToValue(entry)}
                onChange={(value) => onChange(valueToEntry(value))}
                options={options}
                className={SELECT_CLASS}
            />
        </div>
    );
}

export default function PluginConnectionDefaults({ pluginId, groups, mapping, keys, onSetMapping }) {
    const t = useT();
    // `null` means the plugin has never contributed a host at all - nothing
    // to configure yet. An empty array is a real, worth-showing case: hosts
    // exist but none of them named a group, so only the Default row applies.
    if (!groups) return null;

    return (
        <div className="mt-2.5 pt-2.5 border-t border-gray-900/[0.06] dark:border-white/[0.06]">
            <p className="text-[11px] font-semibold uppercase tracking-wide text-gray-400 dark:text-neutral-500 mb-1">
                {t('settings.plugins.credentials.title')}
            </p>

            <GroupRow
                label={t('settings.plugins.credentials.default')}
                title={t('settings.plugins.credentials.defaultHint')}
                entry={mapping?.default}
                keys={keys}
                onChange={(entry) => onSetMapping(pluginId, '', entry)}
            />

            {groups.map(group => (
                <GroupRow
                    key={group}
                    label={group}
                    entry={mapping?.groups?.[group]}
                    keys={keys}
                    onChange={(entry) => onSetMapping(pluginId, group, entry)}
                />
            ))}
        </div>
    );
}
