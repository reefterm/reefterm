/**
 * Characterizes the pure functions behind theming: resolveAppColors (the one
 * place "what mode + which tint" turns into "six hex values"), the light and
 * dark derive functions (build a ramp from one picked colour), and the
 * one-time migration off the pre-tint theme shape.
 */
import { describe, test, expect, beforeEach } from 'vitest';
import {
    APP_COLOR_PRESETS,
    CUSTOM_TINT_ID,
    DEFAULT_APP_COLORS,
    DEFAULT_LIGHT_APP_COLORS,
    LIGHT_APP_COLOR_PRESETS,
    deriveDarkPalette,
    deriveLightPalette,
    matchPreset,
    migrateLegacyTheme,
    resolveAppColors,
    sanitizeAppColors,
} from '../../src/renderer/lib/app-colors.js';

beforeEach(() => {
    localStorage.clear();
});

describe('resolveAppColors', () => {
    const base = {
        darkTint: 'tokyo-night',
        lightTint: 'daybreak',
        appColors: DEFAULT_APP_COLORS,
        lightAppColors: DEFAULT_LIGHT_APP_COLORS,
    };

    test('dark theme resolves the dark tint regardless of prefersDark', () => {
        expect(resolveAppColors({ ...base, theme: 'dark', darkTint: 'ember', prefersDark: false }))
            .toEqual(APP_COLOR_PRESETS.find(p => p.id === 'ember').colors);
    });

    test('light theme resolves the light tint regardless of prefersDark', () => {
        expect(resolveAppColors({ ...base, theme: 'light', lightTint: 'meadow', prefersDark: true }))
            .toEqual(LIGHT_APP_COLOR_PRESETS.find(p => p.id === 'meadow').colors);
    });

    test('system theme follows prefersDark to pick which side\'s tint applies', () => {
        expect(resolveAppColors({ ...base, theme: 'system', darkTint: 'nord', prefersDark: true }))
            .toEqual(APP_COLOR_PRESETS.find(p => p.id === 'nord').colors);
        expect(resolveAppColors({ ...base, theme: 'system', lightTint: 'sky', prefersDark: false }))
            .toEqual(LIGHT_APP_COLOR_PRESETS.find(p => p.id === 'sky').colors);
    });

    test('a custom dark tint returns appColors, sanitized against the dark default', () => {
        const custom = { base: '#010203', raised: '', control: '#030405', hover: '#040506', active: '#050607', muted: '#060708' };
        const result = resolveAppColors({
            ...base, theme: 'dark', darkTint: CUSTOM_TINT_ID, appColors: custom, prefersDark: false,
        });
        expect(result.base).toBe('#010203');
        expect(result.raised).toBe(DEFAULT_APP_COLORS.raised); // blank field falls back
    });

    test('a custom light tint returns lightAppColors, sanitized against the light default', () => {
        const custom = { base: '#f0f0f0', raised: '#e0e0e0', control: '#d0d0d0', hover: '#c0c0c0', active: '#b0b0b0', muted: '#a0a0a0' };
        const result = resolveAppColors({
            ...base, theme: 'light', lightTint: CUSTOM_TINT_ID, lightAppColors: custom, prefersDark: false,
        });
        expect(result).toEqual(custom);
    });

    test('an unknown tint id falls back to that side\'s default rather than throwing', () => {
        expect(resolveAppColors({ ...base, theme: 'dark', darkTint: 'nonexistent', prefersDark: false }))
            .toEqual(DEFAULT_APP_COLORS);
        expect(resolveAppColors({ ...base, theme: 'light', lightTint: 'nonexistent', prefersDark: false }))
            .toEqual(DEFAULT_LIGHT_APP_COLORS);
    });
});

describe('deriveDarkPalette / deriveLightPalette', () => {
    test('dark palette lightness increases monotonically from base to muted', () => {
        const ramp = deriveDarkPalette('#202020');
        const lightness = ['base', 'raised', 'control', 'hover', 'active', 'muted'].map(
            key => parseInt(ramp[key].slice(1, 3), 16) + parseInt(ramp[key].slice(3, 5), 16) + parseInt(ramp[key].slice(5, 7), 16),
        );
        for (let i = 1; i < lightness.length; i++) expect(lightness[i]).toBeGreaterThan(lightness[i - 1]);
    });

    test('light palette lightness decreases monotonically from base to muted', () => {
        const ramp = deriveLightPalette('#f0f0f0');
        const lightness = ['base', 'raised', 'control', 'hover', 'active', 'muted'].map(
            key => parseInt(ramp[key].slice(1, 3), 16) + parseInt(ramp[key].slice(3, 5), 16) + parseInt(ramp[key].slice(5, 7), 16),
        );
        for (let i = 1; i < lightness.length; i++) expect(lightness[i]).toBeLessThan(lightness[i - 1]);
    });

    test('both keep the seed colour exactly as the base step', () => {
        expect(deriveDarkPalette('#1a2b3c').base).toBe('#1a2b3c');
        expect(deriveLightPalette('#e0d0c0').base).toBe('#e0d0c0');
    });
});

describe('matchPreset', () => {
    test('matches an exact dark preset by default', () => {
        expect(matchPreset(APP_COLOR_PRESETS.find(p => p.id === 'dracula').colors)).toBe('dracula');
    });

    test('matches against a supplied light preset list', () => {
        const colors = LIGHT_APP_COLOR_PRESETS.find(p => p.id === 'citrus').colors;
        expect(matchPreset(colors, LIGHT_APP_COLOR_PRESETS)).toBe('citrus');
    });

    test('returns null for colours that match no preset', () => {
        expect(matchPreset({ ...DEFAULT_APP_COLORS, base: '#123456' })).toBeNull();
    });
});

describe('sanitizeAppColors', () => {
    test('fills missing/invalid fields from the given fallback, not always the dark default', () => {
        const result = sanitizeAppColors({ base: 'not-a-color' }, DEFAULT_LIGHT_APP_COLORS);
        expect(result.base).toBe(DEFAULT_LIGHT_APP_COLORS.base);
        expect(result.muted).toBe(DEFAULT_LIGHT_APP_COLORS.muted);
    });
});

describe('migrateLegacyTheme', () => {
    test('does nothing when theme is not the legacy "custom" value', () => {
        localStorage.setItem('theme', 'dark');
        migrateLegacyTheme();
        expect(localStorage.getItem('theme')).toBe('dark');
        expect(localStorage.getItem('darkTint')).toBeNull();
    });

    test('migrates legacy custom colours that exactly match a preset to that preset\'s tint', () => {
        localStorage.setItem('theme', 'custom');
        localStorage.setItem('appColors', JSON.stringify(APP_COLOR_PRESETS.find(p => p.id === 'gruvbox').colors));

        migrateLegacyTheme();

        expect(localStorage.getItem('theme')).toBe('dark');
        expect(localStorage.getItem('darkTint')).toBe('gruvbox');
    });

    test('migrates legacy custom colours that match nothing to the custom tint, preserving the colours', () => {
        const handEdited = { ...DEFAULT_APP_COLORS, base: '#654321' };
        localStorage.setItem('theme', 'custom');
        localStorage.setItem('appColors', JSON.stringify(handEdited));

        migrateLegacyTheme();

        expect(localStorage.getItem('theme')).toBe('dark');
        expect(localStorage.getItem('darkTint')).toBe('custom');
        expect(JSON.parse(localStorage.getItem('appColors'))).toEqual(handEdited);
    });

    test('is idempotent - running it again after migration is a no-op', () => {
        localStorage.setItem('theme', 'custom');
        localStorage.setItem('appColors', JSON.stringify(DEFAULT_APP_COLORS));
        migrateLegacyTheme();
        migrateLegacyTheme();
        expect(localStorage.getItem('theme')).toBe('dark');
        expect(localStorage.getItem('darkTint')).toBe('tokyo-night');
    });

    test('an unreadable stored palette still migrates, falling back to the dark default', () => {
        localStorage.setItem('theme', 'custom');
        localStorage.setItem('appColors', 'not json');

        migrateLegacyTheme();

        expect(localStorage.getItem('theme')).toBe('dark');
        expect(localStorage.getItem('darkTint')).toBe('tokyo-night'); // default colours match the tokyo-night preset
    });
});
