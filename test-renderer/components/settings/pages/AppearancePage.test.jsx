/**
 * Characterizes AppearancePage's mode + tint picker (System/Light/Dark, and
 * the tint grid underneath that follows whichever side is resolved) plus the
 * quick theme switcher toggle, which the mode/tint redesign left untouched.
 */
import { describe, test, expect, vi } from 'vitest';
import { render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import AppearancePage from '../../../../src/renderer/components/settings/pages/AppearancePage.jsx';
import { DEFAULT_APP_COLORS, DEFAULT_LIGHT_APP_COLORS } from '../../../../src/renderer/lib/app-colors.js';

function renderPage(overrides = {}) {
    const props = {
        theme: 'dark',
        darkTint: 'tokyo-night',
        lightTint: 'daybreak',
        appColors: DEFAULT_APP_COLORS,
        lightAppColors: DEFAULT_LIGHT_APP_COLORS,
        resolvedDark: true,
        showLogo: true,
        logoImage: null,
        logoSide: 'left',
        quickThemeSwitcherEnabled: true,
        onThemeChange: vi.fn(),
        onDarkTintChange: vi.fn(),
        onLightTintChange: vi.fn(),
        onAppColorsChange: vi.fn(),
        onLightAppColorsChange: vi.fn(),
        onShowLogoChange: vi.fn(),
        onLogoImageChange: vi.fn(),
        onLogoSideChange: vi.fn(),
        onQuickThemeSwitcherEnabledChange: vi.fn(),
        ...overrides,
    };
    render(<AppearancePage {...props} />);
    return props;
}

describe('AppearancePage mode + tint picker', () => {
    test('shows exactly System, Light, Dark as modes, in that order - no Custom tile', () => {
        renderPage();
        const tiles = screen.getAllByRole('button', { name: /^(System|Light|Dark|Custom)$/ });
        expect(tiles.map(tile => tile.textContent)).toEqual(['System', 'Light', 'Dark']);
    });

    test('the tint grid follows resolvedDark, not theme directly', () => {
        renderPage({ theme: 'system', resolvedDark: true, darkTint: 'tokyo-night' });
        expect(screen.getByText('Tokyo Night')).toBeInTheDocument();
        expect(screen.queryByText('Daybreak')).not.toBeInTheDocument();
    });

    test('shows light presets, not dark ones, once light is resolved', () => {
        renderPage({ resolvedDark: false, lightTint: 'daybreak' });
        expect(screen.getByText('Daybreak')).toBeInTheDocument();
        expect(screen.getByText('Meadow')).toBeInTheDocument();
        expect(screen.queryByText('Tokyo Night')).not.toBeInTheDocument();
    });

    test('clicking a mode tile reports that mode, not the one currently active', async () => {
        const user = userEvent.setup();
        const props = renderPage({ theme: 'dark' });

        await user.click(screen.getByRole('button', { name: 'Light' }));

        expect(props.onThemeChange).toHaveBeenCalledWith('light');
    });

    test('clicking a dark tint calls onDarkTintChange while dark is resolved', async () => {
        const user = userEvent.setup();
        const props = renderPage({ resolvedDark: true, darkTint: 'tokyo-night' });

        await user.click(screen.getByText('Ember').closest('button'));

        expect(props.onDarkTintChange).toHaveBeenCalledWith('ember');
        expect(props.onLightTintChange).not.toHaveBeenCalled();
    });

    test('clicking a light tint calls onLightTintChange while light is resolved', async () => {
        const user = userEvent.setup();
        const props = renderPage({ resolvedDark: false, lightTint: 'daybreak' });

        await user.click(screen.getByText('Citrus').closest('button'));

        expect(props.onLightTintChange).toHaveBeenCalledWith('citrus');
        expect(props.onDarkTintChange).not.toHaveBeenCalled();
    });

    test('a custom tint shows the "Yours" tile; a preset tint does not', () => {
        const { rerender } = render(<AppearancePage {...{
            theme: 'dark', darkTint: 'custom', lightTint: 'daybreak',
            appColors: DEFAULT_APP_COLORS, lightAppColors: DEFAULT_LIGHT_APP_COLORS,
            resolvedDark: true, onThemeChange: vi.fn(), onDarkTintChange: vi.fn(), onLightTintChange: vi.fn(),
            onAppColorsChange: vi.fn(), onLightAppColorsChange: vi.fn(),
        }} />);
        expect(screen.getByText('Yours')).toBeInTheDocument();

        rerender(<AppearancePage {...{
            theme: 'dark', darkTint: 'tokyo-night', lightTint: 'daybreak',
            appColors: DEFAULT_APP_COLORS, lightAppColors: DEFAULT_LIGHT_APP_COLORS,
            resolvedDark: true, onThemeChange: vi.fn(), onDarkTintChange: vi.fn(), onLightTintChange: vi.fn(),
            onAppColorsChange: vi.fn(), onLightAppColorsChange: vi.fn(),
        }} />);
        expect(screen.queryByText('Yours')).not.toBeInTheDocument();
    });

    test('"Edit colors" is visible regardless of which tint is selected', () => {
        renderPage({ darkTint: 'tokyo-night' });
        expect(screen.getByRole('button', { name: 'Edit colors' })).toBeInTheDocument();
    });
});

describe('AppearancePage quick theme switcher toggle', () => {
    test('reflects the enabled prop', () => {
        renderPage({ quickThemeSwitcherEnabled: true });
        expect(screen.getByRole('switch', { name: 'Show the quick theme switcher' })).toHaveAttribute(
            'aria-checked', 'true',
        );
    });

    test('reflects the disabled prop', () => {
        renderPage({ quickThemeSwitcherEnabled: false });
        expect(screen.getByRole('switch', { name: 'Show the quick theme switcher' })).toHaveAttribute(
            'aria-checked', 'false',
        );
    });

    test('clicking it reports the new value rather than changing on its own', async () => {
        const user = userEvent.setup();
        const props = renderPage({ quickThemeSwitcherEnabled: true });

        await user.click(screen.getByRole('switch', { name: 'Show the quick theme switcher' }));

        expect(props.onQuickThemeSwitcherEnabledChange).toHaveBeenCalledWith(false);
        // Nothing re-renders this instance with the new prop, so the switch
        // itself is unmoved until the parent hands the new value back down.
        expect(screen.getByRole('switch', { name: 'Show the quick theme switcher' })).toHaveAttribute(
            'aria-checked', 'true',
        );
    });
});
