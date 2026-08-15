/**
 * Characterizes SettingsNav's aiEnabled gating: the "assistant" category
 * disappears when the AI builtin is disabled, and arrow-key wraparound
 * walks the filtered list rather than the full SETTINGS_CATEGORIES - the
 * part most likely to be gotten wrong, since the modulo math has to use the
 * rendered list's length.
 */
import { describe, test, expect, vi } from 'vitest';
import { render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import SettingsNav, { SETTINGS_CATEGORIES } from '../../../src/renderer/components/settings/SettingsNav.jsx';

describe('SettingsNav', () => {
    test('aiEnabled defaults to true: every category, including assistant, is shown', () => {
        render(<SettingsNav active="general" onChange={() => {}} />);
        for (const { id } of SETTINGS_CATEGORIES) {
            expect(screen.getByRole('button', { name: new RegExp(id, 'i') })).toBeInTheDocument();
        }
    });

    test('aiEnabled=false hides the assistant category and nothing else', () => {
        render(<SettingsNav active="general" onChange={() => {}} aiEnabled={false} />);

        expect(screen.queryByRole('button', { name: /assistant/i })).not.toBeInTheDocument();
        expect(screen.getAllByRole('button')).toHaveLength(SETTINGS_CATEGORIES.length - 1);
    });

    test('arrow-down wraparound from the last visible category lands on the first, skipping assistant entirely', async () => {
        const onChange = vi.fn();
        const user = userEvent.setup();
        const last = SETTINGS_CATEGORIES[SETTINGS_CATEGORIES.length - 1].id;
        render(<SettingsNav active={last} onChange={onChange} aiEnabled={false} />);

        // Only the active item is in the tab order (tabIndex 0); focus it
        // directly rather than tabbing in, matching how a real user would
        // already be sitting on it before pressing an arrow key.
        screen.getByRole('button', { name: new RegExp(last, 'i') }).focus();
        await user.keyboard('{ArrowDown}');

        const first = SETTINGS_CATEGORIES[0].id;
        expect(onChange).toHaveBeenCalledWith(first);
        expect(onChange).not.toHaveBeenCalledWith('assistant');
    });
});
