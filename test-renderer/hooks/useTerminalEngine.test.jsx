/**
 * Characterizes useTerminalEngine, extracted out of TerminalView.jsx.
 *
 * The real xterm.js `Terminal` cannot be constructed under jsdom: it needs a
 * `MediaQueryList` with the deprecated `addListener` and a 2D canvas context,
 * neither of which jsdom implements (the latter needs the native `canvas`
 * package, and even with it there is still no WebGL for the GPU renderer).
 * Confirmed empirically before writing these — `new Terminal().open(div)`
 * throws inside jsdom on `matchMedia`/canvas long before anything the hook
 * controls runs. So the mount effect is never exercised here: every test
 * either targets the pure helpers directly, or renders the hook with nothing
 * attached to `terminalRef`, which is exactly the "pane not mounted yet"
 * state the hook already has to handle safely (a pane can render before its
 * DOM container has laid out, and `pane` can be null on the very first
 * render). What is covered is everything reachable without a live Terminal:
 * the fit/geometry maths, and the hook's connection-status-driven state and
 * its guards against a terminal that is not there yet.
 */
import { describe, test, expect, vi, beforeEach } from 'vitest';
import { act, renderHook } from '@testing-library/react';
import { useTerminalEngine, fitToPane, terminalOptions } from '../../src/renderer/hooks/useTerminalEngine.js';

describe('terminalOptions', () => {
    test('maps a settings record onto the fields xterm takes at construction', () => {
        const options = terminalOptions({
            fontFamily: 'jetbrains-mono',
            fontSize: 14,
            fontWeight: 400,
            lineHeight: 1.2,
            letterSpacing: 0,
            cursorStyle: 'bar',
            cursorBlink: true,
            scrollback: 10000,
        });

        expect(options).toMatchObject({
            fontSize: 14,
            fontWeight: 400,
            lineHeight: 1.2,
            letterSpacing: 0,
            cursorStyle: 'bar',
            cursorBlink: true,
            scrollback: 10000,
        });
        expect(options.fontFamily).toContain('JetBrains Mono');
    });

    test('keeps bold a constant 300 weight above the regular face', () => {
        const light = terminalOptions({ fontFamily: 'jetbrains-mono', fontWeight: 300 });
        const heavy = terminalOptions({ fontFamily: 'jetbrains-mono', fontWeight: 600 });

        expect(light.fontWeightBold).toBe(600);
        expect(heavy.fontWeightBold).toBe(900);
    });

    test('never asks for a bold weight past 900', () => {
        const options = terminalOptions({ fontFamily: 'jetbrains-mono', fontWeight: 700 });
        expect(options.fontWeightBold).toBe(900);
    });
});

// A fake stands in for the real xterm `Terminal`/`FitAddon`: only the fields
// `fitToPane` actually reads, none of the machinery that jsdom can't run.
function fakeTerm({ rows = 24, cols = 80, drawnHeight = null } = {}) {
    // No `.xterm-screen` yet (drawnHeight null) falls back to `term.element`
    // itself, the same way the real code does, so that needs a rect too.
    const element = { getBoundingClientRect: () => ({ height: 0 }) };
    const screen = drawnHeight === null ? null : { getBoundingClientRect: () => ({ height: drawnHeight }) };
    return {
        rows,
        cols,
        resize: vi.fn(),
        element: { ...element, querySelector: () => screen },
    };
}

function fakeContainer({ clientHeight = 400, clientWidth = 800, borderHeight = 400 } = {}) {
    // jsdom's getComputedStyle works on a real element, so use one and
    // override the metrics `fitToPane` reads off it. clientHeight/Width are
    // getter-only on a real Element, hence defineProperty rather than assign.
    const div = document.createElement('div');
    div.style.paddingTop = '0px';
    div.style.paddingBottom = '0px';
    Object.defineProperty(div, 'clientHeight', { value: clientHeight, configurable: true });
    Object.defineProperty(div, 'clientWidth', { value: clientWidth, configurable: true });
    div.getBoundingClientRect = () => ({ height: borderHeight });
    return div;
}

describe('fitToPane', () => {
    test('does nothing when any of the three pieces is missing', () => {
        expect(fitToPane(null, {}, fakeContainer())).toBe(false);
        expect(fitToPane(fakeTerm(), null, fakeContainer())).toBe(false);
        expect(fitToPane(fakeTerm(), {}, null)).toBe(false);
    });

    test('will not measure a pane with no box at all', () => {
        const term = fakeTerm();
        const fitAddon = { proposeDimensions: () => ({ rows: 24, cols: 80 }) };
        const hidden = fakeContainer({ clientHeight: 0, clientWidth: 0 });

        expect(fitToPane(term, fitAddon, hidden)).toBe(false);
        expect(term.resize).not.toHaveBeenCalled();
    });

    test('will not resize on a proposal with no rows or cols', () => {
        const term = fakeTerm();
        const fitAddon = { proposeDimensions: () => ({}) };

        expect(fitToPane(term, fitAddon, fakeContainer())).toBe(false);
        expect(term.resize).not.toHaveBeenCalled();
    });

    test('resizes to the proposal when it already fits and nothing is drawn yet', () => {
        const term = fakeTerm({ rows: 20, cols: 70 });
        const fitAddon = { proposeDimensions: () => ({ rows: 24, cols: 80 }) };

        expect(fitToPane(term, fitAddon, fakeContainer())).toBe(true);
        expect(term.resize).toHaveBeenCalledWith(80, 24);
    });

    test('skips the resize call when the proposal already matches', () => {
        const term = fakeTerm({ rows: 24, cols: 80 });
        const fitAddon = { proposeDimensions: () => ({ rows: 24, cols: 80 }) };

        expect(fitToPane(term, fitAddon, fakeContainer())).toBe(true);
        expect(term.resize).not.toHaveBeenCalled();
    });

    test('gives back a row that would only be half drawn', () => {
        // 10 rows drawn at 400px is 40px a row; a 396px box has room for 9
        // whole rows and 36px of a tenth, which is short of the 1px slack.
        const term = fakeTerm({ rows: 10, drawnHeight: 400 });
        const fitAddon = { proposeDimensions: () => ({ rows: 10, cols: 80 }) };
        const container = fakeContainer({ borderHeight: 396 });

        expect(fitToPane(term, fitAddon, container)).toBe(true);
        expect(term.resize).toHaveBeenCalledWith(80, 9);
    });

    test('keeps the row when the overhang is within the clip slack', () => {
        // Same cell height, but the box is 400.5px: the tenth row overhangs by
        // half a pixel, which ROW_CLIP_SLACK absorbs rather than dropping it.
        const term = fakeTerm({ rows: 10, drawnHeight: 400 });
        const fitAddon = { proposeDimensions: () => ({ rows: 10, cols: 80 }) };
        const container = fakeContainer({ borderHeight: 400.5 });

        expect(fitToPane(term, fitAddon, container)).toBe(true);
        expect(term.resize).not.toHaveBeenCalled();
    });

    test('never proposes fewer than one row', () => {
        const term = fakeTerm({ rows: 10, drawnHeight: 400 });
        const fitAddon = { proposeDimensions: () => ({ rows: 10, cols: 80 }) };
        const container = fakeContainer({ borderHeight: 5 });

        expect(fitToPane(term, fitAddon, container)).toBe(true);
        expect(term.resize).toHaveBeenCalledWith(80, 1);
    });
});

function fakeConnection(status = 'connecting') {
    return {
        status,
        connect: vi.fn().mockResolvedValue({ success: true }),
        handleDropped: vi.fn(),
        disconnect: vi.fn(),
        reconnectNow: vi.fn(),
    };
}

describe('useTerminalEngine (no terminal mounted)', () => {
    beforeEach(() => {
        window.api = {
            ssh: { sendInput: vi.fn(), resize: vi.fn(), onData: vi.fn(), onDisconnected: vi.fn(), release: vi.fn() },
            clipboard: { writeText: vi.fn(), readText: vi.fn().mockResolvedValue('') },
            screenshot: { capture: vi.fn().mockResolvedValue({ success: true }) },
            links: { open: vi.fn() },
        };
    });

    function setup(overrides = {}) {
        const termRef = { current: null };
        const connection = overrides.connection || fakeConnection();
        const { result, rerender } = renderHook(
            (props) => useTerminalEngine({
                pane: { id: 'pane-1', title: 'pane-1', host: {} },
                terminalSettings: { linkActivation: 'click', ligatures: false, smoothScrollDuration: 0 },
                themeConfig: { background: '#000' },
                connection: props.connection,
                isActive: true,
                isFocused: true,
                isFullscreen: false,
                promptId: null,
                onInput: undefined,
                termRef,
                onOpenSearch: vi.fn(),
                onOpenSnippets: vi.fn(),
            }),
            { initialProps: { connection, ...overrides } }
        );
        return { result, rerender, termRef, connection };
    }

    test('starts connecting and not yet connected', () => {
        const { result } = setup({ connection: fakeConnection('connecting') });
        expect(result.current.isConnecting).toBe(true);
        expect(result.current.everConnected).toBe(false);
    });

    test('clears the connecting overlay once the dial is no longer in flight', () => {
        const { result, rerender } = setup({ connection: fakeConnection('connecting') });

        rerender({ connection: fakeConnection('failed') });

        expect(result.current.isConnecting).toBe(false);
        expect(result.current.everConnected).toBe(false);
    });

    test('marks the pane as ever connected once the connection lands, and it stays that way', () => {
        const { result, rerender } = setup({ connection: fakeConnection('connecting') });

        rerender({ connection: fakeConnection('connected') });
        expect(result.current.everConnected).toBe(true);

        rerender({ connection: fakeConnection('waiting') });
        expect(result.current.everConnected).toBe(true);
    });

    test('insertSnippet is a no-op when there is no terminal to paste into', () => {
        const { result } = setup();
        expect(() => result.current.insertSnippet('ls\n', false)).not.toThrow();
        expect(window.api.ssh.sendInput).not.toHaveBeenCalled();
    });

    test('focus is a no-op when there is no terminal to focus', () => {
        const { result } = setup();
        expect(() => result.current.focus()).not.toThrow();
    });

    test('handleScreenshot does nothing when the pane has not laid out yet', async () => {
        const { result } = setup();
        await act(async () => {
            await result.current.handleScreenshot();
        });
        expect(window.api.screenshot.capture).not.toHaveBeenCalled();
    });

    test('handleContextMenu prevents the native menu and reads the clipboard to paste', async () => {
        const { result } = setup();
        const event = { preventDefault: vi.fn() };

        await act(async () => {
            result.current.handleContextMenu(event);
            await Promise.resolve();
        });

        expect(event.preventDefault).toHaveBeenCalled();
        expect(window.api.clipboard.readText).toHaveBeenCalled();
    });

    test('exposes a stable searchAddonRef and terminalRef for the pane to attach and query', () => {
        const { result } = setup();
        expect(result.current.terminalRef).toHaveProperty('current');
        expect(result.current.searchAddonRef).toHaveProperty('current', null);
    });
});
