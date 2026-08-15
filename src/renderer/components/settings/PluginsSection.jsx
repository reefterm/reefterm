import { useState } from 'react';
import toast from 'react-hot-toast';
import { Refresh01Icon, PuzzleIcon, FolderOpenIcon } from 'hugeicons-react';
import SettingCard from './ui/SettingCard';
import Toggle from './ui/Toggle';
import Button from '../ui/Button';
import PluginConsentDialog from './PluginConsentDialog';
import usePlugins from '../../hooks/usePlugins';
import useBuiltinPlugins from '../../hooks/useBuiltinPlugins';
import { toastOptions } from '../../lib/toast';
import { useT } from '../../i18n';

/** One state per row, in the order plugins/manager.js's describeEntry() can report them. */
const STATE_STYLES = {
    running: { dot: 'bg-emerald-500', text: 'text-emerald-600 dark:text-emerald-400' },
    'pending-consent': { dot: 'bg-amber-500', text: 'text-amber-600 dark:text-amber-500' },
    crashed: { dot: 'bg-rose-500', text: 'text-rose-600 dark:text-rose-400' },
    invalid: { dot: 'bg-rose-500', text: 'text-rose-600 dark:text-rose-400' },
    disabled: { dot: 'bg-gray-300 dark:bg-neutral-600', text: 'text-gray-400 dark:text-neutral-500' },
    stopped: { dot: 'bg-gray-300 dark:bg-neutral-600', text: 'text-gray-400 dark:text-neutral-500' },
};

function StateBadge({ state }) {
    const t = useT();
    const style = STATE_STYLES[state] || STATE_STYLES.stopped;

    return (
        <span className={`inline-flex items-center gap-1.5 text-xs font-medium ${style.text}`}>
            <span aria-hidden="true" className={`w-1.5 h-1.5 rounded-full ${style.dot}`} />
            {t(`settings.plugins.state.${state}`)}
        </span>
    );
}

function PluginRow({ plugin, notice, onToggle, onReview }) {
    const t = useT();
    const invalid = plugin.state === 'invalid';

    return (
        <div className="flex items-start gap-3 px-4 py-3">
            <PuzzleIcon size={20} className="shrink-0 mt-0.5 text-gray-400 dark:text-neutral-500" strokeWidth={1.75} />

            <div className="min-w-0 flex-1">
                <div className="flex items-center gap-2 flex-wrap">
                    <span className="text-sm font-medium text-gray-900 dark:text-white truncate">
                        {plugin.name}
                    </span>
                    {plugin.version && (
                        <span className="text-xs text-gray-400 dark:text-neutral-500">{plugin.version}</span>
                    )}
                    <StateBadge state={plugin.state} />
                </div>

                <p className="text-xs text-gray-400 dark:text-neutral-500 font-mono mt-0.5 truncate">
                    {plugin.id}
                </p>

                {plugin.description && !invalid && (
                    <p className="text-sm text-gray-500 dark:text-gray-400 mt-1">{plugin.description}</p>
                )}

                {invalid && (
                    <p className="text-sm text-rose-600 dark:text-rose-400 mt-1">{plugin.error}</p>
                )}

                {notice && (
                    <p className="text-xs text-rose-500 dark:text-rose-400 mt-1">
                        {t(`settings.plugins.notice.${notice.type}`, { message: notice.message })}
                    </p>
                )}
            </div>

            <div className="shrink-0 flex items-center gap-2">
                {plugin.state === 'pending-consent' && (
                    <Button size="sm" variant="outline" onClick={() => onReview(plugin)}>
                        {t('settings.plugins.review')}
                    </Button>
                )}
                {!invalid && plugin.state !== 'pending-consent' && (
                    <Toggle
                        checked={plugin.state !== 'disabled'}
                        onChange={(next) => onToggle(plugin.id, next)}
                        ariaLabel={t('settings.plugins.enableAria', { name: plugin.name })}
                    />
                )}
            </div>
        </div>
    );
}

/** Simpler than PluginRow: no version, no state badge, no consent - just a name, a description and a toggle. */
function BuiltinRow({ builtin, onToggle }) {
    const t = useT();

    return (
        <div className="flex items-start gap-3 px-4 py-3">
            <PuzzleIcon size={20} className="shrink-0 mt-0.5 text-gray-400 dark:text-neutral-500" strokeWidth={1.75} />

            <div className="min-w-0 flex-1">
                <div className="flex items-center gap-2 flex-wrap">
                    <span className="text-sm font-medium text-gray-900 dark:text-white truncate">
                        {builtin.name}
                    </span>
                    {builtin.pendingRestart && (
                        <span className="text-xs font-medium text-amber-600 dark:text-amber-500">
                            {t('settings.plugins.builtin.pendingRestart')}
                        </span>
                    )}
                </div>
                {builtin.description && (
                    <p className="text-sm text-gray-500 dark:text-gray-400 mt-1">{builtin.description}</p>
                )}
            </div>

            <Toggle
                checked={builtin.enabled}
                onChange={(next) => onToggle(builtin.id, next)}
                ariaLabel={t('settings.plugins.builtin.enableAria', { name: builtin.name })}
            />
        </div>
    );
}

export default function PluginsSection() {
    const t = useT();
    const { plugins, ready, notices, rescan, respondToConsent, setEnabled } = usePlugins();
    const { builtins, ready: builtinsReady, setEnabled: setBuiltinEnabled } = useBuiltinPlugins();
    const [scanning, setScanning] = useState(false);
    const [reviewing, setReviewing] = useState(null);

    const runRescan = async () => {
        setScanning(true);
        try {
            await rescan();
        } catch (error) {
            toast.error(error?.message || t('settings.plugins.rescanFailed'), toastOptions());
        } finally {
            setScanning(false);
        }
    };

    const toggle = async (id, enabled) => {
        try {
            await setEnabled(id, enabled);
        } catch (error) {
            toast.error(error?.message || t('settings.plugins.toggleFailed'), toastOptions());
        }
    };

    const approve = async (id) => {
        try {
            await respondToConsent(id, true);
        } catch (error) {
            toast.error(error?.message || t('settings.plugins.consentFailed'), toastOptions());
        }
    };

    const deny = async (id) => {
        try {
            await respondToConsent(id, false);
        } catch (error) {
            toast.error(error?.message || t('settings.plugins.consentFailed'), toastOptions());
        }
    };

    const toggleBuiltin = async (id, enabled) => {
        try {
            await setBuiltinEnabled(id, enabled);
        } catch (error) {
            toast.error(error?.message || t('settings.plugins.builtin.toggleFailed'), toastOptions());
        }
    };

    if (!ready) return null;

    return (
        <>
            {builtinsReady && builtins.length > 0 && (
                <SettingCard className="!p-0 overflow-hidden">
                    <div className="px-6 pt-6 pb-3">
                        <h4 className="text-base font-semibold text-gray-900 dark:text-white">
                            {t('settings.plugins.builtin.title')}
                        </h4>
                        <p className="text-sm text-gray-500 dark:text-gray-400 mt-1">
                            {t('settings.plugins.builtin.restartNote')}
                        </p>
                    </div>
                    <div className="divide-y divide-gray-100 dark:divide-neutral-800 border-t border-gray-100 dark:border-neutral-800">
                        {builtins.map(builtin => (
                            <BuiltinRow key={builtin.id} builtin={builtin} onToggle={toggleBuiltin} />
                        ))}
                    </div>
                </SettingCard>
            )}

            <SettingCard className="!p-0 overflow-hidden">
                <div className="flex items-center justify-between gap-4 px-6 pt-6 pb-3">
                    <div>
                        <h4 className="text-base font-semibold text-gray-900 dark:text-white">
                            {t('settings.plugins.installed')}
                        </h4>
                        <p className="text-sm text-gray-500 dark:text-gray-400 mt-1">
                            {plugins.length === 0
                                ? t('settings.plugins.none')
                                : t('settings.plugins.count', { count: plugins.length })}
                        </p>
                    </div>
                    <Button
                        size="sm"
                        variant="outline"
                        onClick={runRescan}
                        disabled={scanning}
                        icon={<Refresh01Icon size={14} strokeWidth={2} />}
                    >
                        {scanning ? t('settings.plugins.scanning') : t('settings.plugins.rescan')}
                    </Button>
                </div>

                {plugins.length > 0 ? (
                    <div className="divide-y divide-gray-100 dark:divide-neutral-800 border-t border-gray-100 dark:border-neutral-800">
                        {plugins.map(plugin => (
                            <PluginRow
                                key={plugin.id}
                                plugin={plugin}
                                notice={notices.get(plugin.id)}
                                onToggle={toggle}
                                onReview={setReviewing}
                            />
                        ))}
                    </div>
                ) : (
                    <div className="flex flex-col items-center gap-2 px-6 py-10 text-center border-t border-gray-100 dark:border-neutral-800">
                        <FolderOpenIcon size={24} className="text-gray-300 dark:text-neutral-600" strokeWidth={1.5} />
                        <p className="text-sm text-gray-400 dark:text-neutral-500 max-w-sm">
                            {t('settings.plugins.emptyFolder')}
                        </p>
                    </div>
                )}
            </SettingCard>

            <PluginConsentDialog
                plugin={reviewing}
                onApprove={approve}
                onDeny={deny}
                onClose={() => setReviewing(null)}
            />
        </>
    );
}
