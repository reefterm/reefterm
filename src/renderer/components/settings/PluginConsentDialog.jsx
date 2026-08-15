import { ShieldKeyIcon } from 'hugeicons-react';
import Dialog, { DialogButton } from '../ui/Dialog';
import { NodePreview } from '../../lib/plugin-ui';
import { useT } from '../../i18n';

/**
 * What a plugin is asking for, split into two sections rather than one flat
 * list: capabilities (things it *does*, each worth its own line) and UI
 * contributions (things it *shows*, a different kind of risk). Still one
 * Approve/Deny for the whole plugin - the split is for legibility, not a
 * second consent gate.
 */
export default function PluginConsentDialog({ plugin, onApprove, onDeny, onClose }) {
    const t = useT();
    if (!plugin) return null;

    const requested = plugin.capabilities.filter(capability => !capability.granted);
    const requestedExtensions = (plugin.uiExtensions || []).filter(extension => !extension.granted);

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

                {requestedExtensions.length > 0 && (
                    <>
                        <p className="text-xs font-semibold uppercase tracking-wide text-gray-400 dark:text-neutral-500">
                            {t('settings.plugins.consent.addsToInterface')}
                        </p>
                        <ul className="flex flex-col gap-2">
                            {requestedExtensions.map(extension => (
                                <li
                                    key={extension.point}
                                    className="flex items-center gap-3 rounded-lg border border-gray-200
                                        dark:border-neutral-700 bg-gray-50 dark:bg-neutral-800/60 px-3 py-2"
                                >
                                    {extension.sample && (
                                        <div className="shrink-0"><NodePreview node={extension.sample} /></div>
                                    )}
                                    <p className="text-xs text-gray-500 dark:text-gray-400">
                                        {extension.description}
                                    </p>
                                </li>
                            ))}
                        </ul>
                    </>
                )}

                <p className="text-xs text-gray-400 dark:text-neutral-500">
                    {t('settings.plugins.consent.footnote')}
                </p>
            </div>
        </Dialog>
    );
}
