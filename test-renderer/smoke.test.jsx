/**
 * Proves the Vitest + jsdom + React Testing Library pipeline works end to
 * end - JSX transform, DOM rendering, jest-dom matchers, and a real user
 * interaction driving a state update and a re-render - before it's trusted
 * as the safety net for splitting App.jsx and TerminalView.jsx. Not a test
 * of application code; nothing here should still exist once real renderer
 * tests do.
 */
import { useState } from 'react';
import { describe, test, expect } from 'vitest';
import { render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';

function Counter() {
    const [count, setCount] = useState(0);
    return (
        <button onClick={() => setCount(c => c + 1)}>
            Clicked {count} times
        </button>
    );
}

describe('vitest + jsdom + RTL plumbing', () => {
    test('renders, queries by role, and reacts to a real user click', async () => {
        const user = userEvent.setup();
        render(<Counter />);

        const button = screen.getByRole('button', { name: /clicked 0 times/i });
        expect(button).toBeInTheDocument();

        await user.click(button);
        expect(screen.getByRole('button', { name: /clicked 1 times/i })).toBeInTheDocument();
    });
});
