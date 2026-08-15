/**
 * Characterizes ThemeSwitcherContent: the header and all three quick-switch
 * grids, that each tile calls back with the id it represents rather than
 * some derived label, and that the tint grid follows `resolvedDark` (which
 * side of the ramp is actually on screen) - not `theme` directly, since
 * System has to track the OS live. Open/shut and mounting are PanelDock's
 * job now, covered in its own test file, not this component's.
 */
import { describe, test, expect, vi } from 'vitest';
import { render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import ThemeSwitcherContent from '../../../src/renderer/components/theme/ThemeSwitcherContent.jsx';
import { DEFAULT_CUSTOM_THEME } from '../../../src/renderer/hooks/useTerminalTheme.js';
import { DEFAULT_APP_COLORS, DEFAULT_LIGHT_APP_COLORS } from '../../../src/renderer/lib/app-colors.js';

function renderPanel(overrides = {}) {
    const props = {
        theme: 'dark',
        darkTint: 'tokyo-night',
        lightTint: 'daybreak',
        appColors: DEFAULT_APP_COLORS,
        lightAppColors: DEFAULT_LIGHT_APP_COLORS,
        resolvedDark: true,
        onThemeChange: vi.fn(),
        onDarkTintChange: vi.fn(),
        onLightTintChange: vi.fn(),
        terminalTheme: 'tokyo-night',
        customTerminalTheme: DEFAULT_CUSTOM_THEME,
        onTerminalThemeChange: vi.fn(),
        onClose: vi.fn(),
        ...overrides,
    };
    render(<ThemeSwitcherContent {...props} />);
    return props;
}

describe('ThemeSwitcherContent', () => {
    test('shows all three quick-switch grids and closes on request', async () => {
        const user = userEvent.setup();
        const props = renderPanel();

        expect(screen.getByText('App theme')).toBeInTheDocument();
        expect(screen.getByText('App tint')).toBeInTheDocument();
        expect(screen.getByText('Terminal theme')).toBeInTheDocument();

        await user.click(screen.getByRole('button', { name: 'Close' }));
        expect(props.onClose).toHaveBeenCalledTimes(1);
    });

    test('marks the current app theme, app tint and terminal theme as pressed', () => {
        renderPanel({
            theme: 'system',
            resolvedDark: true,
            darkTint: 'rose-pine',
            terminalTheme: 'dracula',
        });

        expect(screen.getByRole('button', { name: 'App theme: System' })).toHaveAttribute('aria-pressed', 'true');
        expect(screen.getByRole('button', { name: 'App theme: Light' })).toHaveAttribute('aria-pressed', 'false');
        expect(screen.getByRole('button', { name: 'App tint: Rosé Pine' })).toHaveAttribute('aria-pressed', 'true');
        expect(screen.getByRole('button', { name: 'App tint: Tokyo Night' })).toHaveAttribute('aria-pressed', 'false');
        expect(screen.getByRole('button', { name: 'Terminal theme: Dracula' }))
            .toHaveAttribute('aria-pressed', 'true');
    });

    test('the three grids never share an accessible name, even where their labels collide', () => {
        renderPanel();

        // 'Light' is both an app mode and a terminal colour scheme.
        expect(screen.getByRole('button', { name: 'App theme: Light' })).toBeInTheDocument();
        expect(screen.getByRole('button', { name: 'Terminal theme: Light' })).toBeInTheDocument();
        // 'Dracula' is both a dark app tint and a terminal colour scheme.
        expect(screen.getByRole('button', { name: 'App tint: Dracula' })).toBeInTheDocument();
        expect(screen.getByRole('button', { name: 'Terminal theme: Dracula' })).toBeInTheDocument();
        // 'Custom' is both the user's own terminal colours...
        expect(screen.getByRole('button', { name: 'Terminal theme: Custom' })).toBeInTheDocument();
        // ...while the app side calls the same idea 'Yours', so the two never
        // collide even when both are showing (only true once a custom tint
        // is actually selected, exercised in its own test below).
    });

    test('clicking an app theme tile reports that theme, not the one currently active', async () => {
        const user = userEvent.setup();
        const props = renderPanel({ theme: 'dark' });

        await user.click(screen.getByRole('button', { name: 'App theme: Light' }));

        expect(props.onThemeChange).toHaveBeenCalledWith('light');
    });

    test('clicking a dark app tint calls onDarkTintChange, not onLightTintChange, while dark is resolved', async () => {
        const user = userEvent.setup();
        const props = renderPanel({ resolvedDark: true, darkTint: 'tokyo-night' });

        await user.click(screen.getByRole('button', { name: 'App tint: Ember' }));

        expect(props.onDarkTintChange).toHaveBeenCalledWith('ember');
        expect(props.onLightTintChange).not.toHaveBeenCalled();
    });

    test('the tint grid shows light presets and calls onLightTintChange once light is resolved', async () => {
        const user = userEvent.setup();
        const props = renderPanel({ resolvedDark: false, lightTint: 'daybreak' });

        expect(screen.getByRole('button', { name: 'App tint: Daybreak' })).toBeInTheDocument();
        expect(screen.queryByRole('button', { name: 'App tint: Tokyo Night' })).not.toBeInTheDocument();

        await user.click(screen.getByRole('button', { name: 'App tint: Meadow' }));

        expect(props.onLightTintChange).toHaveBeenCalledWith('meadow');
        expect(props.onDarkTintChange).not.toHaveBeenCalled();
    });

    test('a custom app tint shows an inert "Yours" tile previewing that side\'s own colours', () => {
        renderPanel({
            resolvedDark: true,
            darkTint: 'custom',
            appColors: { ...DEFAULT_APP_COLORS, base: '#123456' },
        });

        // Inert, like AppearancePage's own "Yours" tile: nothing to click on
        // a palette that is already selected, so it is a div, not a button.
        const yours = screen.getByLabelText('App tint: Yours');
        expect(yours.tagName).toBe('DIV');
        expect(screen.queryByRole('button', { name: 'App tint: Yours' })).not.toBeInTheDocument();
    });

    test('clicking a terminal swatch reports that theme id', async () => {
        const user = userEvent.setup();
        const props = renderPanel({ terminalTheme: 'tokyo-night' });

        await user.click(screen.getByRole('button', { name: 'Terminal theme: Nord' }));

        expect(props.onTerminalThemeChange).toHaveBeenCalledWith('nord');
    });

    test('the custom terminal swatch uses the user\'s own colours and reports the custom id', async () => {
        const user = userEvent.setup();
        const props = renderPanel({
            terminalTheme: 'tokyo-night',
            customTerminalTheme: { ...DEFAULT_CUSTOM_THEME, background: '#123456' },
        });

        const customSwatch = screen.getByRole('button', { name: 'Terminal theme: Custom' });
        expect(customSwatch).toHaveStyle({ backgroundColor: '#123456' });

        await user.click(customSwatch);
        expect(props.onTerminalThemeChange).toHaveBeenCalledWith('custom');
    });
});
