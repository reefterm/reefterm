import { Alert02Icon } from 'hugeicons-react';
import Button from './ui/Button';
import useBuiltinPlugins from '../hooks/useBuiltinPlugins';
import { useT } from '../i18n';

/**
 * Shown app-wide rather than only on the Plugins page, since a builtin
 * toggle needs a restart wherever you are. `needsRestart` is main's own
 * comparison of what loaded at boot vs. what's persisted now, so this
 * clears itself if a toggle is flipped back to its original value.
 */
export default function BuiltinRestartBanner() {
    const t = useT();
    const { needsRestart } = useBuiltinPlugins();

    if (!needsRestart) return null;

    return (
        <div className="flex items-center gap-3 px-4 h-11 shrink-0 rounded-xl app-no-drag
            bg-amber-50 dark:bg-amber-900/20 text-amber-800 dark:text-amber-300
            border border-amber-200 dark:border-amber-900/40"
        >
            <Alert02Icon size={18} strokeWidth={2} className="shrink-0" />
            <p className="text-sm font-medium flex-1 min-w-0 truncate">
                {t('builtinRestartBanner.message')}
            </p>
            <Button size="sm" variant="warning" onClick={() => window.api.window.restart()}>
                {t('builtinRestartBanner.restartNow')}
            </Button>
        </div>
    );
}
