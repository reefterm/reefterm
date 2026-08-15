import { Cancel01Icon, ComputerIcon, Moon02Icon, Sun03Icon } from 'hugeicons-react';
import Tooltip from '../ui/Tooltip';
import PaletteSwatch from '../ui/PaletteSwatch';
import { PANE_HEADER_HEIGHT } from '../../lib/layout';
import { APP_COLOR_PRESETS, CUSTOM_TINT_ID, LIGHT_APP_COLOR_PRESETS } from '../../lib/app-colors';
import { CUSTOM_THEME_ID, TERMINAL_THEMES, TERMINAL_THEME_PRESETS } from '../../hooks/useTerminalTheme';
import { useT } from '../../i18n';

/**
 * Everything inside PanelDock's card when the theme switcher is the panel
 * showing: the header and the three quick-switch grids. Its own rail button
 * lives in QuickAccessGutter, shared with the assistant's rather than
 * duplicated beside it.
 */
const HAIRLINE = 'border-black/[0.06] dark:border-white/[0.06]';

const MODE_OPTIONS = [
    { id: 'system', icon: ComputerIcon },
    { id: 'light', icon: Sun03Icon },
    { id: 'dark', icon: Moon02Icon },
];

function HeaderButton({ title, icon, onClick, placement = 'bottom' }) {
    return (
        <Tooltip label={title} placement={placement}>
            <button
                type="button"
                aria-label={title}
                onClick={onClick}
                className="w-8 h-8 shrink-0 flex items-center justify-center rounded-xl transition-colors
                    outline-none text-gray-500 dark:text-gray-400
                    hover:bg-surface-control hover:text-gray-900
                    dark:hover:text-white
                    focus-visible:ring-2 focus-visible:ring-gray-900/20 dark:focus-visible:ring-white/25"
            >
                {icon}
            </button>
        </Tooltip>
    );
}

// `srLabel` carries the section name the tooltip doesn't need to, since app
// tints and terminal themes share names ("Dracula", "Solarized", "Light") and
// a screen reader has no visual grouping to disambiguate them with.
function ModeTile({ Icon, active, label, srLabel, onClick }) {
    return (
        <Tooltip label={label} placement="top">
            <button
                type="button"
                aria-label={srLabel}
                aria-pressed={active}
                onClick={onClick}
                className={`w-full aspect-square flex items-center justify-center rounded-xl border transition-colors
                    ${active
                        ? 'border-surface-active bg-surface-active/20 text-gray-900 dark:text-white'
                        : `border-surface-active/60 text-gray-500 dark:text-gray-400
                            hover:border-surface-hover
                            hover:text-gray-700 dark:hover:text-gray-200`}`}
            >
                <Icon size={18} strokeWidth={1.5} />
            </button>
        </Tooltip>
    );
}

const TILE_BASE = 'flex flex-col items-center gap-1 p-1 rounded-lg border transition-all cursor-pointer';

const tileClass = (selected) => `${TILE_BASE} ${selected
    ? 'border-surface-active ring-1 ring-surface-active bg-surface-active/10'
    : 'border-surface-active/60 hover:border-surface-hover'}`;

const labelClass = (selected) => `text-[10px] text-center leading-tight truncate w-full ${selected
    ? 'font-bold text-gray-900 dark:text-white'
    : 'font-medium text-gray-600 dark:text-gray-400'}`;

function TerminalSwatch({ background, foreground, active, label, srLabel, onClick }) {
    return (
        <Tooltip label={label} placement="top">
            <button
                type="button"
                aria-label={srLabel}
                aria-pressed={active}
                onClick={onClick}
                className={`w-full aspect-square rounded-lg border-2 transition-colors
                    flex items-center justify-center overflow-hidden
                    ${active
                        ? 'border-gray-900 dark:border-white'
                        : 'border-transparent hover:border-surface-hover'}`}
                style={{ backgroundColor: background }}
            >
                {/* "Tt" rather than a plain dot, so the sample reads as the
                    theme's text colour rather than an unlabelled marker. */}
                <span
                    aria-hidden="true"
                    className="text-[11px] font-bold leading-none select-none"
                    style={{ color: foreground }}
                >
                    Tt
                </span>
            </button>
        </Tooltip>
    );
}

const TERMINAL_OPTIONS = TERMINAL_THEME_PRESETS.map(option => ({
    ...option,
    ...TERMINAL_THEMES[option.id],
}));

export default function ThemeSwitcherContent({
    theme,
    darkTint,
    lightTint,
    appColors,
    lightAppColors,
    resolvedDark,
    onThemeChange,
    onDarkTintChange,
    onLightTintChange,
    terminalTheme,
    customTerminalTheme,
    onTerminalThemeChange,
    onClose,
}) {
    const t = useT();

    // Which side of the ramp a tint pick actually changes, tracking the OS
    // live on System - same `resolvedDark` read AppearancePage does.
    const tint = resolvedDark ? darkTint : lightTint;
    const tintPresets = resolvedDark ? APP_COLOR_PRESETS : LIGHT_APP_COLOR_PRESETS;
    const customColors = resolvedDark ? appColors : lightAppColors;
    const onTintChange = resolvedDark ? onDarkTintChange : onLightTintChange;

    return (
        <>
            <header
                className={`shrink-0 pl-3 pr-1.5 flex items-center gap-1 border-b ${HAIRLINE}`}
                style={{ height: PANE_HEADER_HEIGHT }}
            >
                <h2 className="flex-1 min-w-0 truncate text-sm font-semibold text-gray-900 dark:text-white">
                    {t('themeSwitcher.title')}
                </h2>
                <HeaderButton
                    title={t('common.close')}
                    icon={<Cancel01Icon size={16} strokeWidth={1.5} />}
                    onClick={onClose}
                />
            </header>

            <div className="flex-1 min-h-0 overflow-y-auto p-3 space-y-6">
                <div>
                    <h3 className="mb-2 text-xs font-semibold uppercase tracking-wide
                        text-gray-400 dark:text-gray-600">
                        {t('themeSwitcher.appTheme')}
                    </h3>
                    <div className="grid grid-cols-3 gap-2">
                        {MODE_OPTIONS.map(({ id, icon }) => (
                            <ModeTile
                                key={id}
                                Icon={icon}
                                active={theme === id}
                                label={t(`settings.appearance.theme.${id}`)}
                                srLabel={t('themeSwitcher.appThemeOption', {
                                    theme: t(`settings.appearance.theme.${id}`),
                                })}
                                onClick={() => onThemeChange(id)}
                            />
                        ))}
                    </div>
                </div>

                <div>
                    <h3 className="mb-2 text-xs font-semibold uppercase tracking-wide
                        text-gray-400 dark:text-gray-600">
                        {t('themeSwitcher.appTint')}
                    </h3>
                    <div className="grid grid-cols-3 gap-2">
                        {tintPresets.map(option => (
                            <button
                                key={option.id}
                                className={tileClass(tint === option.id)}
                                onClick={() => onTintChange?.(option.id)}
                                aria-label={t('themeSwitcher.appTintOption', { tint: option.label })}
                                aria-pressed={tint === option.id}
                            >
                                <PaletteSwatch colors={option.colors} />
                                <span className={labelClass(tint === option.id)}>
                                    {option.label}
                                </span>
                            </button>
                        ))}

                        {/* Where a hand-picked palette shows up, so a
                            custom colour set (only editable from
                            Settings) is still shown as the one in use
                            rather than leaving nothing highlighted. */}
                        {tint === CUSTOM_TINT_ID && (
                            <div
                                className={`${tileClass(true)} cursor-default`}
                                aria-label={t('themeSwitcher.appTintOption', {
                                    tint: t('settings.appearance.yours'),
                                })}
                            >
                                <PaletteSwatch colors={customColors} />
                                <span className={labelClass(true)}>
                                    {t('settings.appearance.yours')}
                                </span>
                            </div>
                        )}
                    </div>
                </div>

                <div>
                    <h3 className="mb-2 text-xs font-semibold uppercase tracking-wide
                        text-gray-400 dark:text-gray-600">
                        {t('themeSwitcher.terminalTheme')}
                    </h3>
                    <div className="grid grid-cols-6 gap-2">
                        {TERMINAL_OPTIONS.map(option => (
                            <TerminalSwatch
                                key={option.id}
                                background={option.background}
                                foreground={option.foreground}
                                active={terminalTheme === option.id}
                                label={option.label}
                                srLabel={t('themeSwitcher.terminalThemeOption', { theme: option.label })}
                                onClick={() => onTerminalThemeChange(option.id)}
                            />
                        ))}
                        <TerminalSwatch
                            background={customTerminalTheme.background}
                            foreground={customTerminalTheme.foreground}
                            active={terminalTheme === CUSTOM_THEME_ID}
                            label={t('settings.terminal.custom')}
                            srLabel={t('themeSwitcher.terminalThemeOption', {
                                theme: t('settings.terminal.custom'),
                            })}
                            onClick={() => onTerminalThemeChange(CUSTOM_THEME_ID)}
                        />
                    </div>
                </div>
            </div>
        </>
    );
}
