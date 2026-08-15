/**
 * Characterizes QuickAccessGutter: it hides itself when nothing in
 * `toolState` is enabled, shows a button per enabled tool (in the fixed
 * `TOOLS` order, not insertion order of `toolState`), and each button
 * reflects and drives that one tool's own open/toggle state without
 * touching any other tool's.
 */
import { describe, test, expect, vi } from 'vitest';
import { render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import QuickAccessGutter from '../../src/renderer/components/QuickAccessGutter.jsx';

const ASSISTANT = 'com.reefterm.builtin.ai';
const THEME_SWITCHER = 'com.reefterm.quickaccess.theme-switcher';

function renderGutter(toolState) {
    render(<QuickAccessGutter toolState={toolState} />);
}

describe('QuickAccessGutter', () => {
    test('renders nothing when no tool is enabled', () => {
        const { container } = render(<QuickAccessGutter toolState={{}} />);
        expect(container).toBeEmptyDOMElement();
    });

    test('renders nothing when every known tool is explicitly disabled', () => {
        const { container } = render(<QuickAccessGutter toolState={{
            [ASSISTANT]: { enabled: false, open: false, onToggle: vi.fn() },
            [THEME_SWITCHER]: { enabled: false, open: false, onToggle: vi.fn() },
        }} />);
        expect(container).toBeEmptyDOMElement();
    });

    test('shows a button only for the enabled tool', () => {
        renderGutter({
            [ASSISTANT]: { enabled: true, open: false, onToggle: vi.fn() },
        });
        expect(screen.getByRole('button', { name: 'AI Agent' })).toBeInTheDocument();
        expect(screen.queryByRole('button', { name: 'Quick Themes' })).not.toBeInTheDocument();
    });

    test('shows both buttons when both tools are enabled', () => {
        renderGutter({
            [ASSISTANT]: { enabled: true, open: false, onToggle: vi.fn() },
            [THEME_SWITCHER]: { enabled: true, open: false, onToggle: vi.fn() },
        });
        expect(screen.getByRole('button', { name: 'AI Agent' })).toBeInTheDocument();
        expect(screen.getByRole('button', { name: 'Quick Themes' })).toBeInTheDocument();
    });

    test('marks a tool pressed when its own state says it is open, independent of the other tool', () => {
        renderGutter({
            [ASSISTANT]: { enabled: true, open: true, onToggle: vi.fn() },
            [THEME_SWITCHER]: { enabled: true, open: false, onToggle: vi.fn() },
        });
        expect(screen.getByRole('button', { name: 'AI Agent' })).toHaveAttribute('aria-pressed', 'true');
        expect(screen.getByRole('button', { name: 'Quick Themes' })).toHaveAttribute('aria-pressed', 'false');
    });

    test('clicking a tool calls only that tool\'s own onToggle', async () => {
        const user = userEvent.setup();
        const onToggleAssistant = vi.fn();
        const onToggleThemeSwitcher = vi.fn();
        renderGutter({
            [ASSISTANT]: { enabled: true, open: false, onToggle: onToggleAssistant },
            [THEME_SWITCHER]: { enabled: true, open: false, onToggle: onToggleThemeSwitcher },
        });

        await user.click(screen.getByRole('button', { name: 'Quick Themes' }));

        expect(onToggleThemeSwitcher).toHaveBeenCalledTimes(1);
        expect(onToggleAssistant).not.toHaveBeenCalled();
    });

    test('a tool missing from toolState entirely is treated as disabled, not a crash', () => {
        renderGutter({
            [ASSISTANT]: { enabled: true, open: false, onToggle: vi.fn() },
            // THEME_SWITCHER absent entirely.
        });
        expect(screen.getByRole('button', { name: 'AI Agent' })).toBeInTheDocument();
        expect(screen.queryByRole('button', { name: 'Quick Themes' })).not.toBeInTheDocument();
    });
});
