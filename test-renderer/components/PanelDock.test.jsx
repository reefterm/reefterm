/**
 * Characterizes PanelDock: at most one of the assistant/theme-switcher
 * panels is ever in the DOM at once, switching between them swaps the
 * card's content without passing through empty, the resize handle only
 * shows for the assistant (the theme switcher has nothing to drag), and
 * `onClose` reaches whichever panel is actually showing.
 */
import { describe, test, expect, vi } from 'vitest';
import { render, screen, waitFor } from '@testing-library/react';
import PanelDock from '../../src/renderer/components/PanelDock.jsx';
import { TOOL_IDS } from '../../src/renderer/components/QuickAccessGutter.jsx';

vi.mock('../../src/renderer/components/assistant/AssistantConversation.jsx', () => ({
    default: ({ onClose }) => (
        <div>
            Assistant content
            <button onClick={onClose}>Close assistant</button>
        </div>
    ),
}));

vi.mock('../../src/renderer/components/theme/ThemeSwitcherContent.jsx', () => ({
    default: ({ onClose }) => (
        <div>
            Theme content
            <button onClick={onClose}>Close theme</button>
        </div>
    ),
}));

function renderDock(overrides = {}) {
    const props = {
        activePanel: null,
        onClose: vi.fn(),
        assistantSessions: [],
        assistantHosts: [],
        activeSessionId: null,
        assistantWidth: 400,
        onAssistantWidthChange: vi.fn(),
        onOpenAssistantSettings: vi.fn(),
        theme: 'dark',
        darkTint: 'tokyo-night',
        lightTint: 'daybreak',
        appColors: {},
        lightAppColors: {},
        resolvedDark: true,
        onThemeChange: vi.fn(),
        onDarkTintChange: vi.fn(),
        onLightTintChange: vi.fn(),
        terminalTheme: 'tokyo-night',
        customTerminalTheme: {},
        onTerminalThemeChange: vi.fn(),
        ...overrides,
    };
    const view = render(<PanelDock {...props} />);
    return { ...view, props };
}

describe('PanelDock', () => {
    test('shows neither panel while shut', () => {
        renderDock({ activePanel: null });
        expect(screen.queryByText('Assistant content')).not.toBeInTheDocument();
        expect(screen.queryByText('Theme content')).not.toBeInTheDocument();
    });

    test('shows only the assistant when it is the active panel', async () => {
        renderDock({ activePanel: TOOL_IDS.ASSISTANT });
        await waitFor(() => expect(screen.getByText('Assistant content')).toBeInTheDocument());
        expect(screen.queryByText('Theme content')).not.toBeInTheDocument();
    });

    test('shows only the theme switcher when it is the active panel', async () => {
        renderDock({ activePanel: TOOL_IDS.THEME_SWITCHER });
        await waitFor(() => expect(screen.getByText('Theme content')).toBeInTheDocument());
        expect(screen.queryByText('Assistant content')).not.toBeInTheDocument();
    });

    test('switching from one panel to the other swaps content without ever showing both', async () => {
        const { rerender, props } = renderDock({ activePanel: TOOL_IDS.ASSISTANT });
        await waitFor(() => expect(screen.getByText('Assistant content')).toBeInTheDocument());

        rerender(<PanelDock {...props} activePanel={TOOL_IDS.THEME_SWITCHER} />);

        expect(screen.getByText('Theme content')).toBeInTheDocument();
        expect(screen.queryByText('Assistant content')).not.toBeInTheDocument();
    });

    test('the resize handle appears only for the assistant panel', async () => {
        const { rerender, props } = renderDock({ activePanel: TOOL_IDS.ASSISTANT });
        await waitFor(() => expect(document.querySelector('.cursor-col-resize')).toBeInTheDocument());

        rerender(<PanelDock {...props} activePanel={TOOL_IDS.THEME_SWITCHER} />);
        await waitFor(() => expect(screen.getByText('Theme content')).toBeInTheDocument());
        expect(document.querySelector('.cursor-col-resize')).not.toBeInTheDocument();
    });

    test('closing calls the shared onClose regardless of which panel is open', async () => {
        const onClose = vi.fn();
        renderDock({ activePanel: TOOL_IDS.THEME_SWITCHER, onClose });
        await waitFor(() => expect(screen.getByText('Theme content')).toBeInTheDocument());

        screen.getByText('Close theme').click();
        expect(onClose).toHaveBeenCalledTimes(1);
    });
});
