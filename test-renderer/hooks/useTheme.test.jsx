/**
 * Characterizes useTheme: default state, that each setter only ever persists
 * its own key, the legacy 'custom' theme migration, and that resolvedDark and
 * the CSS variables it drives update on an OS theme change while on System -
 * the pre-tint listener only re-toggled `.dark`, never re-resolved the tint.
 */
import { describe, test, expect, beforeEach, vi } from 'vitest';
import { act, renderHook } from '@testing-library/react';
import {
    APP_COLOR_PRESETS,
    DEFAULT_APP_COLORS,
    DEFAULT_LIGHT_APP_COLORS,
    LIGHT_APP_COLOR_PRESETS,
} from '../../src/renderer/lib/app-colors.js';

/**
 * A matchMedia stub whose `matches` can be flipped after the fact and that
 * remembers its 'change' listener, so a test can simulate the OS switching
 * appearance mid-session the same way a real `MediaQueryList` would.
 */
function installMatchMediaStub(initialMatches) {
    let matches = initialMatches;
    let handler = null;
    window.matchMedia = vi.fn().mockImplementation(() => ({
        get matches() { return matches; },
        addEventListener: (_event, fn) => { handler = fn; },
        removeEventListener: () => { handler = null; },
    }));
    return {
        flip(next) {
            matches = next;
            handler?.();
        },
    };
}

async function importFreshUseTheme() {
    vi.resetModules();
    const mod = await import('../../src/renderer/hooks/useTheme.js');
    return mod.useTheme;
}

beforeEach(() => {
    localStorage.clear();
    document.documentElement.classList.remove('dark');
    document.documentElement.style.cssText = '';
});

describe('useTheme defaults', () => {
    test('starts on system mode with the brand default tint on each side', async () => {
        installMatchMediaStub(false);
        const useTheme = await importFreshUseTheme();
        const { result } = renderHook(() => useTheme());

        expect(result.current.theme).toBe('system');
        expect(result.current.darkTint).toBe('tokyo-night');
        expect(result.current.lightTint).toBe('daybreak');
    });

    test('setTheme only ever persists light, dark or system', async () => {
        installMatchMediaStub(false);
        const useTheme = await importFreshUseTheme();
        const { result } = renderHook(() => useTheme());

        act(() => result.current.setTheme('dark'));
        expect(localStorage.getItem('theme')).toBe('dark');

        act(() => result.current.setTheme('light'));
        expect(localStorage.getItem('theme')).toBe('light');
    });

    test('setDarkTint and setLightTint persist under their own keys independently', async () => {
        installMatchMediaStub(false);
        const useTheme = await importFreshUseTheme();
        const { result } = renderHook(() => useTheme());

        act(() => result.current.setDarkTint('ember'));
        act(() => result.current.setLightTint('meadow'));

        expect(localStorage.getItem('darkTint')).toBe('ember');
        expect(localStorage.getItem('lightTint')).toBe('meadow');
        expect(result.current.darkTint).toBe('ember');
        expect(result.current.lightTint).toBe('meadow');
    });
});

describe('resolvedDark and applied colours across the {theme, tint} matrix', () => {
    test('dark theme resolves dark regardless of OS preference', async () => {
        installMatchMediaStub(false);
        const useTheme = await importFreshUseTheme();
        const { result } = renderHook(() => useTheme());

        act(() => result.current.setTheme('dark'));

        expect(result.current.resolvedDark).toBe(true);
        expect(document.documentElement.classList.contains('dark')).toBe(true);
        expect(document.documentElement.style.getPropertyValue('--app-base')).toBe(
            hexToRgbTriple(DEFAULT_APP_COLORS.base),
        );
    });

    test('light theme resolves light regardless of OS preference', async () => {
        installMatchMediaStub(true);
        const useTheme = await importFreshUseTheme();
        const { result } = renderHook(() => useTheme());

        act(() => result.current.setTheme('light'));

        expect(result.current.resolvedDark).toBe(false);
        expect(document.documentElement.classList.contains('dark')).toBe(false);
        expect(document.documentElement.style.getPropertyValue('--app-base')).toBe(
            hexToRgbTriple(DEFAULT_LIGHT_APP_COLORS.base),
        );
    });

    test('system theme follows the OS at mount', async () => {
        installMatchMediaStub(true);
        const useTheme = await importFreshUseTheme();
        const { result } = renderHook(() => useTheme());

        expect(result.current.theme).toBe('system');
        expect(result.current.resolvedDark).toBe(true);
    });

    test('an OS theme change while on System re-resolves the actual colours, not just .dark', async () => {
        const media = installMatchMediaStub(false);
        const useTheme = await importFreshUseTheme();
        const { result } = renderHook(() => useTheme());

        act(() => result.current.setDarkTint('nord'));
        act(() => result.current.setLightTint('sky'));
        expect(result.current.resolvedDark).toBe(false);
        expect(document.documentElement.style.getPropertyValue('--app-base')).toBe(
            hexToRgbTriple(LIGHT_APP_COLOR_PRESETS.find(p => p.id === 'sky').colors.base),
        );

        act(() => media.flip(true));

        expect(result.current.resolvedDark).toBe(true);
        expect(document.documentElement.classList.contains('dark')).toBe(true);
        expect(document.documentElement.style.getPropertyValue('--app-base')).toBe(
            hexToRgbTriple(APP_COLOR_PRESETS.find(p => p.id === 'nord').colors.base),
        );
    });

    test('an OS theme change while on an explicit Dark/Light mode is ignored', async () => {
        const media = installMatchMediaStub(false);
        const useTheme = await importFreshUseTheme();
        const { result } = renderHook(() => useTheme());

        act(() => result.current.setTheme('dark'));
        expect(result.current.resolvedDark).toBe(true);

        // The OS switching to light should not move an app explicitly pinned to Dark.
        act(() => media.flip(true));

        expect(result.current.resolvedDark).toBe(true);
        expect(document.documentElement.classList.contains('dark')).toBe(true);
    });
});

describe('legacy theme migration', () => {
    test('a stored theme of "custom" migrates to dark + the matching preset tint before the hook even reads it', async () => {
        localStorage.setItem('theme', 'custom');
        localStorage.setItem('appColors', JSON.stringify(APP_COLOR_PRESETS.find(p => p.id === 'dracula').colors));
        installMatchMediaStub(false);

        const useTheme = await importFreshUseTheme();
        const { result } = renderHook(() => useTheme());

        expect(result.current.theme).toBe('dark');
        expect(result.current.darkTint).toBe('dracula');
    });

    test('a stored theme of "custom" with hand-edited colours migrates to the custom tint, keeping the colours', async () => {
        const handEdited = { ...DEFAULT_APP_COLORS, base: '#654321' };
        localStorage.setItem('theme', 'custom');
        localStorage.setItem('appColors', JSON.stringify(handEdited));
        installMatchMediaStub(false);

        const useTheme = await importFreshUseTheme();
        const { result } = renderHook(() => useTheme());

        expect(result.current.theme).toBe('dark');
        expect(result.current.darkTint).toBe('custom');
        expect(result.current.appColors).toEqual(handEdited);
    });
});

function hexToRgbTriple(hex) {
    const value = hex.replace('#', '');
    const r = parseInt(value.slice(0, 2), 16);
    const g = parseInt(value.slice(2, 4), 16);
    const b = parseInt(value.slice(4, 6), 16);
    return `${r} ${g} ${b}`;
}
