import { useState, useLayoutEffect, useCallback } from 'react';
import {
    DEFAULT_APP_COLORS,
    DEFAULT_LIGHT_APP_COLORS,
    applyAppColors,
    migrateLegacyTheme,
    resolveAppColors,
    sanitizeAppColors,
} from '../lib/app-colors';

// This module is a singleton for the life of the app, so this runs exactly
// once, before any of the lazy initializers below read the keys it might
// rewrite. See migrateLegacyTheme's own header for what it is cleaning up.
migrateLegacyTheme();

const THEMES = new Set(['light', 'dark', 'system']);

const THEME_KEY = 'theme';
const DARK_TINT_KEY = 'darkTint';
const LIGHT_TINT_KEY = 'lightTint';
const COLORS_KEY = 'appColors';
const LIGHT_COLORS_KEY = 'lightAppColors';
const LOGO_KEY = 'titleBarLogo';
const LOGO_IMAGE_KEY = 'titleBarLogoImage';
const LOGO_SIDE_KEY = 'titleBarLogoSide';
const QUICK_SWITCHER_KEY = 'quickThemeSwitcher.enabled';

const DEFAULT_DARK_TINT = 'tokyo-night';
const DEFAULT_LIGHT_TINT = 'daybreak';

/** Which end of the title bar the mark sits at. */
export const LOGO_SIDES = ['left', 'right'];

/**
 * A stored logo, if it is still one we would draw.
 *
 * Checked rather than trusted: this is the one setting whose value is a URL the
 * renderer puts in an `<img>`, and it can arrive from another device through
 * the settings snapshot. Only the image data URLs main hands out are accepted,
 * so nothing else can be smuggled into that slot.
 */
const readLogoImage = () => {
    const saved = localStorage.getItem(LOGO_IMAGE_KEY);
    return typeof saved === 'string' && /^data:image\/[a-z.+-]+;base64,[A-Za-z0-9+/=]+$/.test(saved)
        ? saved
        : null;
};

const readTheme = () => {
    const saved = localStorage.getItem(THEME_KEY);
    return THEMES.has(saved) ? saved : 'system';
};

const readDarkTint = () => localStorage.getItem(DARK_TINT_KEY) || DEFAULT_DARK_TINT;
const readLightTint = () => localStorage.getItem(LIGHT_TINT_KEY) || DEFAULT_LIGHT_TINT;

const readColors = (key, fallback) => {
    try {
        const saved = localStorage.getItem(key);
        return sanitizeAppColors(saved ? JSON.parse(saved) : null, fallback);
    } catch {
        return { ...fallback };
    }
};

const prefersDarkQuery = () => window.matchMedia('(prefers-color-scheme: dark)');

export function useTheme() {
    const [theme, setThemeState] = useState(readTheme);
    const [darkTint, setDarkTintState] = useState(readDarkTint);
    const [lightTint, setLightTintState] = useState(readLightTint);
    const [appColors, setAppColorsState] = useState(() => readColors(COLORS_KEY, DEFAULT_APP_COLORS));
    const [lightAppColors, setLightAppColorsState] = useState(
        () => readColors(LIGHT_COLORS_KEY, DEFAULT_LIGHT_APP_COLORS),
    );

    // The mark in the title bar: whether it is drawn, whose it is, and which
    // end it sits at. Owned here rather than by the settings page, because the
    // title bar is what has to be told about it.
    const [showLogo, setShowLogoState] = useState(() => localStorage.getItem(LOGO_KEY) !== 'false');
    const [logoImage, setLogoImageState] = useState(readLogoImage);
    const [logoSide, setLogoSideState] = useState(() => {
        const saved = localStorage.getItem(LOGO_SIDE_KEY);
        return LOGO_SIDES.includes(saved) ? saved : 'left';
    });

    // The quick-switch gutter on the shell's edge. On by default, same as the
    // logo: a feature you have to discover is one most people never will.
    const [quickThemeSwitcherEnabled, setQuickThemeSwitcherEnabledState] = useState(
        () => localStorage.getItem(QUICK_SWITCHER_KEY) !== 'false',
    );

    // Whether the resolved mode is dark right now. Its own state, not computed
    // inline, because System mode tracks the OS live and a reader (the tint
    // grid) needs to re-render on that, not just have the CSS variables update
    // underneath it.
    const [resolvedDark, setResolvedDark] = useState(
        () => theme === 'dark' || (theme === 'system' && prefersDarkQuery().matches),
    );

    const applyTheme = useCallback((themeName, tints) => {
        const prefersDark = prefersDarkQuery().matches;
        const dark = themeName === 'dark' || (themeName === 'system' && prefersDark);

        document.documentElement.classList.toggle('dark', dark);
        applyAppColors(resolveAppColors({ theme: themeName, ...tints, prefersDark }));
        setResolvedDark(dark);
    }, []);

    const setTheme = useCallback((newTheme) => {
        setThemeState(newTheme);
        localStorage.setItem(THEME_KEY, newTheme);
    }, []);

    const setDarkTint = useCallback((tint) => {
        setDarkTintState(tint);
        localStorage.setItem(DARK_TINT_KEY, tint);
    }, []);

    const setLightTint = useCallback((tint) => {
        setLightTintState(tint);
        localStorage.setItem(LIGHT_TINT_KEY, tint);
    }, []);

    const setAppColors = useCallback((colors) => {
        const next = sanitizeAppColors(colors, DEFAULT_APP_COLORS);
        setAppColorsState(next);
        localStorage.setItem(COLORS_KEY, JSON.stringify(next));
        return next;
    }, []);

    const setLightAppColors = useCallback((colors) => {
        const next = sanitizeAppColors(colors, DEFAULT_LIGHT_APP_COLORS);
        setLightAppColorsState(next);
        localStorage.setItem(LIGHT_COLORS_KEY, JSON.stringify(next));
        return next;
    }, []);

    const setShowLogo = useCallback((next) => {
        setShowLogoState(next);
        localStorage.setItem(LOGO_KEY, String(next));
    }, []);

    /** A data URL from the picker, or null to go back to the app's own mark. */
    const setLogoImage = useCallback((dataUrl) => {
        if (dataUrl) {
            localStorage.setItem(LOGO_IMAGE_KEY, dataUrl);
        } else {
            localStorage.removeItem(LOGO_IMAGE_KEY);
        }
        // Read back rather than stored as given, so an image that would not
        // survive a reload does not display for the rest of this run either.
        setLogoImageState(readLogoImage());
    }, []);

    const setLogoSide = useCallback((next) => {
        const side = LOGO_SIDES.includes(next) ? next : 'left';
        setLogoSideState(side);
        localStorage.setItem(LOGO_SIDE_KEY, side);
    }, []);

    const setQuickThemeSwitcherEnabled = useCallback((next) => {
        setQuickThemeSwitcherEnabledState(next);
        localStorage.setItem(QUICK_SWITCHER_KEY, String(next));
    }, []);

    // Before the paint rather than after it: this is what decides whether the
    // window is black or white, and a frame of the wrong one is a flash.
    useLayoutEffect(() => {
        const tints = { darkTint, lightTint, appColors, lightAppColors };
        applyTheme(theme, tints);

        // Listen for system theme changes. On System mode this has to
        // re-resolve which tint's colours apply, not just flip `.dark` - the
        // ramp itself is different on either side of the OS switch.
        const mediaQuery = prefersDarkQuery();
        const handleChange = () => {
            if (theme === 'system') applyTheme('system', tints);
        };

        mediaQuery.addEventListener('change', handleChange);
        return () => mediaQuery.removeEventListener('change', handleChange);
    }, [theme, darkTint, lightTint, appColors, lightAppColors, applyTheme]);

    return {
        theme, setTheme,
        darkTint, setDarkTint,
        lightTint, setLightTint,
        appColors, setAppColors,
        lightAppColors, setLightAppColors,
        resolvedDark,
        showLogo, setShowLogo,
        logoImage, setLogoImage,
        logoSide, setLogoSide,
        quickThemeSwitcherEnabled, setQuickThemeSwitcherEnabled,
    };
}
