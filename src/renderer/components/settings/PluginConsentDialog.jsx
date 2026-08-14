import { ShieldKeyIcon } from 'hugeicons-react';
import Dialog, { DialogButton } from '../ui/Dialog';
import { useT } from '../../i18n';

/**
 * What a plugin is asking for, named one capability at a time, before it is
 * ever allowed to run. There is no "approve everything" shortcut: the list
 * shown here is exactly what gets granted, and is exactly what
 * plugins/manager.js persists against this plugin's id.
 */
export default function PluginConsentDialog({ plugin, onApprove, onDeny, onClose }) {
    const t = useT();
    if (!plugin) return null;

    const requested = plugin.capabilities.filter(capability => !capability.granted);

    return (
        <Dialog
            title={t('settings.plugins.consent.title', { name: plugin.name })}
            subtitle={t('settings.plugins.consent.subtitle', { id: plugin.id })}
            icon={<ShieldKeyIcon size={20} className="text-amber-500" strokeWidth={1.75} />}
            onClose={onClose}
            footer={(
                <>
                    <DialogButton data-autofocus variant="ghost" onClick={onClose}>
                        {t('common.cancel')}
                    </DialogButton>
                    <DialogButton
                        variant="danger"
                        onClick={() => { onDeny(plugin.id); onClose(); }}
                    >
                        {t('settings.plugins.consent.deny')}
                    </DialogButton>
                    <DialogButton
                        variant="primary"
                        onClick={() => { onApprove(plugin.id); onClose(); }}
                    >
                        {t('settings.plugins.consent.approve')}
                    </DialogButton>
                </>
            )}
        >
            <div className="flex flex-col gap-3">
                {plugin.description && (
                    <p className="text-sm text-gray-500 dark:text-gray-400">{plugin.description}</p>
                )}

                <p className="text-xs font-semibold uppercase tracking-wide text-gray-400 dark:text-neutral-500">
                    {t('settings.plugins.consent.asksFor')}
                </p>

                <ul className="flex flex-col gap-2">
                    {requested.map(capability => (
                        <li
                            key={capability.name}
                            className="rounded-lg border border-gray-200 dark:border-neutral-700 px-3 py-2"
                        >
                            <p className="text-sm font-medium text-gray-900 dark:text-white">
                                {capability.name}
                            </p>
                            <p className="text-xs text-gray-500 dark:text-gray-400 mt-0.5">
                                {capability.description}
                            </p>
                        </li>
                    ))}
                </ul>

                <p className="text-xs text-gray-400 dark:text-neutral-500">
                    {t('settings.plugins.consent.footnote')}
                </p>
            </div>
        </Dialog>
    );
}
