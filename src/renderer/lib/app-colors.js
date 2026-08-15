/**
 * The colours the app's own chrome is made of.
 *
 * Every themeable surface in the shell is one step of a single six-colour ramp,
 * named through CSS variables rather than baked into the utilities (see
 * `tailwind.config.js` and the `:root` block in `input.css`), so setting the
 * six variables here retints the whole app without a class having to change.
 *
 * Both modes share that one ramp - which mode is active just decides which
 * tint's colours get written there. Dark's tint and light's tint are tracked
 * and remembered independently against their own preset list below, so
 * switching modes never loses either one's pick.
 */

/** The one tint id that means "the user's own hand-edited colours", on either side. */
export const CUSTOM_TINT_ID = 'custom';

/**
 * The steps, in the order the editor lists them. The words are catalog keys, so
 * the editor can name them in whatever language the app is set to.
 */
export const APP_COLOR_FIELDS = [
    { key: 'base', labelKey: 'appColors.base', hintKey: 'appColors.baseHint' },
    { key: 'raised', labelKey: 'appColors.raised', hintKey: 'appColors.raisedHint' },
    { key: 'control', labelKey: 'appColors.control', hintKey: 'appColors.controlHint' },
    { key: 'hover', labelKey: 'appColors.hover', hintKey: 'appColors.hoverHint' },
    { key: 'active', labelKey: 'appColors.active', hintKey: 'appColors.activeHint' },
    { key: 'muted', labelKey: 'appColors.muted', hintKey: 'appColors.mutedHint' },
];

/** The variable each step is published as. Read by the Tailwind palette. */
const CSS_VARIABLES = {
    base: '--app-base',
    raised: '--app-raised',
    control: '--app-control',
    hover: '--app-hover',
    active: '--app-active',
    muted: '--app-muted',
};

/**
 * Dark mode's own colours, and what an untouched dark custom theme starts as.
 *
 * Tokyo Night, the same palette the terminal defaults to (see
 * hooks/useTerminalTheme.js), so the shell and what runs inside it are one
 * scheme out of the box. Keep in step with the `:root` block in input.css.
 */
export const DEFAULT_APP_COLORS = {
    base: '#16161e',
    raised: '#1a1b26',
    control: '#24283b',
    hover: '#2f334d',
    active: '#3b4261',
    muted: '#565f89',
};

/**
 * Palettes to start from in dark mode. Each is the same six-step ramp as the
 * default, so picking one is a complete theme rather than a hue the rest has
 * to be matched to by hand.
 */
export const APP_COLOR_PRESETS = [
    { id: 'tokyo-night', label: 'Tokyo Night', colors: DEFAULT_APP_COLORS },
    {
        id: 'midnight',
        label: 'Midnight',
        colors: { base: '#111219', raised: '#1a1b26', control: '#24253a', hover: '#2e3049', active: '#3b3d5c', muted: '#565982' },
    },
    {
        id: 'graphite',
        label: 'Graphite',
        colors: { base: '#0d0d0f', raised: '#16161a', control: '#212127', hover: '#2b2b33', active: '#383840', muted: '#6b6b78' },
    },
    {
        id: 'nord',
        label: 'Nord',
        colors: { base: '#232831', raised: '#2e3440', control: '#3b4252', hover: '#434c5e', active: '#4c566a', muted: '#7c89a3' },
    },
    {
        id: 'dracula',
        label: 'Dracula',
        colors: { base: '#1a1b23', raised: '#282a36', control: '#343746', hover: '#414458', active: '#565a72', muted: '#6272a4' },
    },
    {
        id: 'catppuccin',
        label: 'Catppuccin',
        colors: { base: '#181825', raised: '#1e1e2e', control: '#313244', hover: '#45475a', active: '#585b70', muted: '#7f849c' },
    },
    {
        id: 'rose-pine',
        label: 'Rosé Pine',
        colors: { base: '#16141f', raised: '#191724', control: '#26233a', hover: '#322f4a', active: '#403d52', muted: '#6e6a86' },
    },
    {
        id: 'gruvbox',
        label: 'Gruvbox',
        colors: { base: '#1d2021', raised: '#282828', control: '#3c3836', hover: '#504945', active: '#665c54', muted: '#928374' },
    },
    {
        id: 'everforest',
        label: 'Everforest',
        colors: { base: '#232a2e', raised: '#2d353b', control: '#3d484d', hover: '#475258', active: '#56635f', muted: '#859289' },
    },
    {
        id: 'solarized',
        label: 'Solarized',
        colors: { base: '#00212b', raised: '#002b36', control: '#073642', hover: '#0f4a58', active: '#175c6c', muted: '#7d9295' },
    },
    {
        id: 'ocean',
        label: 'Ocean',
        colors: { base: '#08131f', raised: '#0d1b2a', control: '#1b263b', hover: '#24354f', active: '#2e4363', muted: '#6f83a3' },
    },
    {
        id: 'amethyst',
        label: 'Amethyst',
        colors: { base: '#14111f', raised: '#1c1830', control: '#292244', hover: '#362d5a', active: '#443873', muted: '#8478c0' },
    },
    {
        id: 'ember',
        label: 'Ember',
        colors: { base: '#17110f', raised: '#211917', control: '#332624', hover: '#423230', active: '#543f3c', muted: '#96736c' },
    },
];

/**
 * Light mode's own colours, and what an untouched light custom theme starts
 * as. Its `muted` deliberately matches Tokyo Night's, so the app's two brand
 * defaults share one anchor colour.
 */
export const DEFAULT_LIGHT_APP_COLORS = {
    base: '#f7f7fb',
    raised: '#eef0f8',
    control: '#ecedf3',
    hover: '#dbdfec',
    active: '#b7bfdc',
    muted: '#565f89',
};

/**
 * Palettes to start from in light mode. A mix on purpose: some are close to
 * paper-white with just a hint of hue, some are properly coloured, because a
 * set of twelve that were all equally saturated would not actually offer
 * twelve different moods. Half are light siblings of well-known dark palettes
 * above (`catppuccin` → `catppuccin-latte`, `rose-pine` → `rose-pine-dawn`,
 * `gruvbox` → `gruvbox-light`, `solarized` → `solarized-light`, `everforest` →
 * `everforest-light`, `nord` → `nord-snow`); the rest are original.
 */
export const LIGHT_APP_COLOR_PRESETS = [
    { id: 'daybreak', label: 'Daybreak', colors: DEFAULT_LIGHT_APP_COLORS },
    {
        id: 'catppuccin-latte',
        label: 'Catppuccin Latte',
        colors: { base: '#eff1f5', raised: '#e6e9ef', control: '#dee0e4', hover: '#cacdd5', active: '#acb0be', muted: '#6c6f85' },
    },
    {
        id: 'rose-pine-dawn',
        label: 'Rosé Pine Dawn',
        colors: { base: '#faf4ed', raised: '#fffaf3', control: '#f2eeea', hover: '#e4e1e0', active: '#cecacd', muted: '#797593' },
    },
    {
        id: 'gruvbox-light',
        label: 'Gruvbox Light',
        colors: { base: '#fbf1c7', raised: '#ebdbb2', control: '#d9d0bf', hover: '#c4baa8', active: '#a89984', muted: '#7c6f64' },
    },
    {
        id: 'solarized-light',
        label: 'Solarized Light',
        colors: { base: '#fdf6e3', raised: '#eee8d5', control: '#e8e4da', hover: '#dcd6c6', active: '#c8bfa0', muted: '#657b83' },
    },
    {
        id: 'everforest-light',
        label: 'Everforest Light',
        colors: { base: '#f3ead3', raised: '#e8ddba', control: '#d2c9a7', hover: '#bfb88d', active: '#a6a26e', muted: '#638547' },
    },
    {
        id: 'nord-snow',
        label: 'Nord (Snow Storm)',
        colors: { base: '#eceff4', raised: '#e5e9f0', control: '#e3e6ec', hover: '#d3d7e0', active: '#aeb7c9', muted: '#4c566a' },
    },
    {
        id: 'meadow',
        label: 'Meadow',
        colors: { base: '#f9fbf2', raised: '#f0f6df', control: '#e7eedb', hover: '#d0e2ba', active: '#a3cf78', muted: '#4d6b2f' },
    },
    {
        id: 'citrus',
        label: 'Citrus',
        colors: { base: '#fff8ec', raised: '#fdedcf', control: '#f2e4ce', hover: '#eecc9c', active: '#ef9b4e', muted: '#b5451f' },
    },
    {
        id: 'blossom',
        label: 'Blossom',
        colors: { base: '#fdf6f8', raised: '#fbe9ee', control: '#f5e7ea', hover: '#ebccd5', active: '#d998ab', muted: '#8a4a5c' },
    },
    {
        id: 'sky',
        label: 'Sky',
        colors: { base: '#f2f9fc', raised: '#e2f2f8', control: '#dfecf0', hover: '#bcdbe4', active: '#74bcd1', muted: '#2f6b7d' },
    },
    {
        id: 'lavender',
        label: 'Lavender',
        colors: { base: '#f8f6fd', raised: '#eee7fa', control: '#eae5f4', hover: '#d5c8ea', active: '#a98adf', muted: '#5c3f8a' },
    },
];

/**
 * How much lighter each dark step is than the window behind it, in HSL
 * lightness points. Measured off the default palette, so a ramp derived from
 * one colour has the same spacing the app was drawn with.
 */
const DARK_LIGHTNESS_STEPS = [0, 4.5, 10, 15, 21, 34];

/**
 * The light equivalent: a light ramp starts near white and descends, so these
 * are subtracted rather than added. The last step is a much bigger jump than
 * dark's (-48 vs +13) because HSL chroma is `S × (1 − |2L−1|)` - a muted step
 * near L 50% needs to travel a lot further from a base at L 96-98% to read as
 * saturated at all than dark's equivalent step does travelling the other way.
 */
const LIGHT_LIGHTNESS_STEPS = [0, -2, -6, -12, -19, -48];

const HEX_PATTERN = /^#?([0-9a-f]{3}|[0-9a-f]{6})$/i;

/** Anything a colour input or a hand-edited store might hold, as `#rrggbb`. */
export function normalizeHex(value, fallback = '#000000') {
    if (typeof value !== 'string') return fallback;

    const match = HEX_PATTERN.exec(value.trim());
    if (!match) return fallback;

    const digits = match[1];
    const full = digits.length === 3
        ? digits.split('').map(digit => digit + digit).join('')
        : digits;

    return `#${full.toLowerCase()}`;
}

function hexToRgb(hex) {
    const value = normalizeHex(hex);
    return [
        parseInt(value.slice(1, 3), 16),
        parseInt(value.slice(3, 5), 16),
        parseInt(value.slice(5, 7), 16),
    ];
}

function rgbToHsl([red, green, blue]) {
    const r = red / 255;
    const g = green / 255;
    const b = blue / 255;

    const max = Math.max(r, g, b);
    const min = Math.min(r, g, b);
    const lightness = (max + min) / 2;
    const delta = max - min;

    if (delta === 0) return [0, 0, lightness * 100];

    const saturation = delta / (1 - Math.abs(2 * lightness - 1));

    let hue;
    if (max === r) hue = ((g - b) / delta) % 6;
    else if (max === g) hue = (b - r) / delta + 2;
    else hue = (r - g) / delta + 4;

    hue *= 60;
    if (hue < 0) hue += 360;

    return [hue, saturation * 100, lightness * 100];
}

function hslToHex(hue, saturation, lightness) {
    const s = Math.max(0, Math.min(100, saturation)) / 100;
    const l = Math.max(0, Math.min(100, lightness)) / 100;

    const chroma = (1 - Math.abs(2 * l - 1)) * s;
    const second = chroma * (1 - Math.abs(((hue / 60) % 2) - 1));
    const match = l - chroma / 2;

    const sector = Math.floor(((hue % 360) + 360) % 360 / 60);
    const [r, g, b] = [
        [chroma, second, 0],
        [second, chroma, 0],
        [0, chroma, second],
        [0, second, chroma],
        [second, 0, chroma],
        [chroma, 0, second],
    ][sector];

    return `#${[r, g, b]
        .map(channel => Math.round((channel + match) * 255).toString(16).padStart(2, '0'))
        .join('')}`;
}

/**
 * A whole ramp from one colour: the window keeps the hue and saturation it was
 * given, and every surface above it is the same colour shifted. One picker is
 * how most people want to say "make the app green", and each step stays
 * editable afterwards.
 */
function derivePaletteWithSteps(baseHex, steps) {
    const [hue, saturation, lightness] = rgbToHsl(hexToRgb(baseHex));

    return APP_COLOR_FIELDS.reduce((colors, field, index) => {
        colors[field.key] = hslToHex(hue, saturation, lightness + steps[index]);
        return colors;
    }, {});
}

export function deriveDarkPalette(baseHex) {
    return derivePaletteWithSteps(baseHex, DARK_LIGHTNESS_STEPS);
}

export function deriveLightPalette(baseHex) {
    return derivePaletteWithSteps(baseHex, LIGHT_LIGHTNESS_STEPS);
}

/** Fill the gaps and drop anything unreadable, so a half-written store still
 *  produces an app you can see. */
export function sanitizeAppColors(colors, fallback = DEFAULT_APP_COLORS) {
    const source = colors || {};
    return APP_COLOR_FIELDS.reduce((result, field) => {
        result[field.key] = normalizeHex(source[field.key], fallback[field.key]);
        return result;
    }, {});
}

/** The preset these colours are, if they are still exactly one of them. */
export function matchPreset(colors, presets = APP_COLOR_PRESETS) {
    const candidate = sanitizeAppColors(colors);
    return presets.find(preset =>
        APP_COLOR_FIELDS.every(field => preset.colors[field.key] === candidate[field.key])
    )?.id || null;
}

/**
 * The six colours that should actually be on screen right now, given what
 * mode and which tint on each side of it are selected. The one place this
 * gets worked out - `hooks/useTheme.js` and the pre-paint boot script in
 * `main.jsx` both call this rather than each carrying their own copy of the
 * same branching.
 */
export function resolveAppColors({ theme, darkTint, lightTint, appColors, lightAppColors, prefersDark }) {
    const dark = theme === 'dark' || (theme === 'system' && prefersDark);
    const tint = dark ? darkTint : lightTint;

    if (tint === CUSTOM_TINT_ID) {
        return dark
            ? sanitizeAppColors(appColors, DEFAULT_APP_COLORS)
            : sanitizeAppColors(lightAppColors, DEFAULT_LIGHT_APP_COLORS);
    }

    const presets = dark ? APP_COLOR_PRESETS : LIGHT_APP_COLOR_PRESETS;
    const fallback = dark ? DEFAULT_APP_COLORS : DEFAULT_LIGHT_APP_COLORS;
    return presets.find(preset => preset.id === tint)?.colors || fallback;
}

/**
 * One-time cleanup for the theme this app shipped with before light mode was
 * themeable, where "Custom" was a fourth option alongside Light/Dark/System
 * rather than a tint under Dark. Owns its own `localStorage` read/write
 * (idempotent) rather than being handed values, since it has to run from both
 * `useTheme.js` (a hook) and `main.jsx`'s pre-paint boot script (not a hook).
 */
export function migrateLegacyTheme() {
    if (localStorage.getItem('theme') !== 'custom') return;

    let stored = null;
    try {
        stored = JSON.parse(localStorage.getItem('appColors') || 'null');
    } catch {
        stored = null;
    }

    const colors = sanitizeAppColors(stored, DEFAULT_APP_COLORS);
    localStorage.setItem('theme', 'dark');
    localStorage.setItem('darkTint', matchPreset(colors, APP_COLOR_PRESETS) || CUSTOM_TINT_ID);
}

/**
 * Publish a palette to the document.
 *
 * Written as bare `r g b` channels, which is the form Tailwind's opacity
 * modifiers need: `bg-surface-control/60` becomes `rgb(var(--app-control) / 0.6)`
 * and a `#rrggbb` in there would not parse.
 */
export function applyAppColors(colors) {
    const palette = sanitizeAppColors(colors);
    const root = document.documentElement;

    for (const field of APP_COLOR_FIELDS) {
        root.style.setProperty(CSS_VARIABLES[field.key], hexToRgb(palette[field.key]).join(' '));
    }
}

/** What one of these colours currently resolves to, whichever tint is live. */
export function currentAppColor(key) {
    const variable = CSS_VARIABLES[key];
    if (!variable) return DEFAULT_APP_COLORS.base;

    const channels = getComputedStyle(document.documentElement).getPropertyValue(variable).trim();
    return channels ? `rgb(${channels})` : DEFAULT_APP_COLORS[key];
}
