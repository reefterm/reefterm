import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { Terminal } from '@xterm/xterm';
import { FitAddon } from '@xterm/addon-fit';
import { WebglAddon } from '@xterm/addon-webgl';
import { SearchAddon } from '@xterm/addon-search';
import { WebLinksAddon } from '@xterm/addon-web-links';
import toast from 'react-hot-toast';
import { resolveFontFamily } from './useTerminalSettings';
import { toastOptions } from '../lib/toast';
import { MODIFIER_KEY } from '../lib/platform';

// Pane ids that already opened a connection. Guards against React StrictMode's
// double-mount in development dialling the same host twice.
const connectedPanes = new Set();

const nextFrame = () => new Promise(requestAnimationFrame);

/**
 * Resolve once the terminal font is actually usable. Browsers only fetch a
 * webfont when something needs it, so without this the first terminal measures
 * the fallback font and every column count downstream is wrong.
 *
 * Asked for the family that is actually configured, not the bundled one: a
 * chosen face that is still loading has the same effect on the measurement.
 */
function ensureTerminalFont(fontSize, weight, fontFamily) {
    if (!document.fonts?.load) return Promise.resolve();
    return document.fonts
        .load(`${weight} ${fontSize}px ${fontFamily}`)
        .catch(() => {}); // Fall back silently to the next family in the stack.
}

/**
 * The xterm options a settings record means.
 *
 * One place, used by both the initial construction and the update effect, so
 * the two can never drift into disagreeing about what a setting does.
 *
 * Everything here is worth a refit, which is what makes it worth putting in one
 * record: applying any of it means measuring the pane again and telling the
 * remote its new window size. A setting that does not move the cell, the way
 * the theme and the scroll easing do not, does not belong here; it gets its own
 * two-line effect instead, so that changing it does not SIGWINCH the remote.
 */
export function terminalOptions(settings) {
    return {
        fontFamily: resolveFontFamily(settings.fontFamily),
        fontSize: settings.fontSize,
        fontWeight: settings.fontWeight,
        // xterm draws bold as a separate weight; keeping the gap constant means
        // bold still reads as bold at weight 300 and at weight 600.
        fontWeightBold: Math.min(900, settings.fontWeight + 300),
        lineHeight: settings.lineHeight,
        letterSpacing: settings.letterSpacing,
        cursorStyle: settings.cursorStyle,
        cursorBlink: settings.cursorBlink,
        scrollback: settings.scrollback,
    };
}

/**
 * Same check as useCardDrag, useTabDrag and useTypewriter, and read at the
 * moment it is applied rather than cached, so the terminal's one animation is
 * not the only one in the app that ignores the OS setting.
 */
const prefersReducedMotion = () =>
    window.matchMedia?.('(prefers-reduced-motion: reduce)').matches ?? false;

// A row is only given back once the overflow is worth seeing. Both renderers
// round the drawn height to whole device pixels, so a sub-pixel overhang is
// arithmetic rather than a clipped line, and trading a whole row for it would
// leave a visible gap at the bottom of every pane.
const ROW_CLIP_SLACK = 1; // px

/**
 * Size the terminal to its pane, without ever leaving a row half-drawn.
 *
 * `FitAddon` divides the pane's height by the height of one cell, but the only
 * padding it subtracts is padding sitting on the `.xterm` element itself, and
 * the padding here is on the container wrapping it. Everything in this app is
 * `border-box`, so the height it reads back already includes that padding, and
 * `p-3` gets handed to the terminal as though it were room for text. At 24px it
 * is worth an entire row: the session comes up one row taller than the pane can
 * show, and `overflow-hidden` quietly cuts the difference off the bottom. What
 * it cuts is the newest line: the prompt, the line being typed on, the thing
 * just printed.
 *
 * The renderers add a second, smaller drift: WebGL floors a cell to whole
 * device pixels, while the DOM renderer derives it back out of the height the
 * screen already had. Swapping one for the other (on mount, on the ligature
 * toggle, on a move to a display with a different pixel ratio) changes what a
 * row costs without changing how many rows there are.
 *
 * So the proposal is checked against the height the rows are actually being
 * drawn at, measured off the DOM rather than recomputed from the numbers that
 * disagree, and a row is given back when they do not fit. Blank space under the
 * last line is invisible; half a line of text is the bug.
 *
 * Returns false when nothing could be measured, so callers know not to report
 * the geometry onwards.
 */
export function fitToPane(term, fitAddon, container) {
    if (!term || !fitAddon || !container) return false;

    // No box at all: the pane is behind SFTP, the desktop, or an inactive tab.
    // Measuring now would propose the one-row minimum and rewrap the whole
    // scrollback into a 2x1 terminal.
    if (!container.clientHeight || !container.clientWidth) return false;

    const proposed = fitAddon.proposeDimensions();
    if (!proposed?.rows || !proposed?.cols) return false;

    const style = getComputedStyle(container);
    const available = container.getBoundingClientRect().height
        - parseFloat(style.paddingTop)
        - parseFloat(style.paddingBottom);

    // What one row actually costs on screen, taken from the rows on screen; the
    // renderer's own cell height is the number in question.
    const screen = term.element?.querySelector('.xterm-screen') || term.element;
    const drawn = screen?.getBoundingClientRect().height || 0;
    const cellHeight = term.rows > 0 ? drawn / term.rows : 0;

    let rows = proposed.rows;
    if (cellHeight > 0) {
        rows = Math.max(1, Math.min(rows, Math.floor((available + ROW_CLIP_SLACK) / cellHeight)));
    }

    // `fit()` is not used: it would resize to the proposal first and be
    // corrected straight after, costing a reflow and a stray SIGWINCH every
    // time the pane moves. Resizing fires a full render on its own.
    if (rows !== term.rows || proposed.cols !== term.cols) {
        term.resize(proposed.cols, rows);
    }
    return true;
}

/**
 * Owns the xterm.js `Terminal` instance for one pane: construction, addons,
 * the GPU renderer, refit-on-change, and everything that reads or writes
 * straight through it (copy/paste, snippets, screenshots).
 *
 * `useSshConnection` decides *whether* a session is up; this hook decides
 * what the terminal in front of it looks like and does. It is handed the
 * connection's result and calls back into it at the two points the instance
 * itself has to: data arriving, and firing the initial connect().
 *
 * `termRef` is not created here but passed in. `useSshConnection`'s own
 * `getGeometry`/`write` callbacks need to read the live Terminal too, and it
 * is called before this hook in TerminalView, so the ref has to be lifted to
 * where both call sites can share it rather than mirrored into a second ref
 * that would need to be kept in sync with this one.
 */
export function useTerminalEngine({
    pane,
    terminalSettings,
    themeConfig,
    connection,
    isActive,
    isFocused,
    isFullscreen,
    promptId,
    onInput,
    termRef,
    onOpenSearch,
    onOpenSnippets,
}) {
    const terminalRef = useRef(null);
    const fitAddonRef = useRef(null);
    const searchAddonRef = useRef(null);
    // Held so the ligature toggle can tear the GPU renderer down and put it
    // back without rebuilding the terminal underneath it.
    const webglRef = useRef(null);

    const [isConnecting, setIsConnecting] = useState(true);
    /**
     * Whether this pane has ever had a session up.
     *
     * It is what decides who owns the pane when there is no connection: before
     * the first one lands there is nothing in the terminal, so the session
     * screen has it, and a failure is a screen rather than a red line in an
     * otherwise blank buffer. After it, the scrollback is the pane, and a drop
     * is reported in the header without covering a word of it.
     */
    const [everConnected, setEverConnected] = useState(false);

    // The mount effect wires callbacks that outlive any single render, so it
    // reaches the connection through a ref rather than closing over it.
    const connectionRef = useRef(connection);
    connectionRef.current = connection;

    const titleRef = useRef(pane?.title);
    titleRef.current = pane?.title || 'terminal';

    /**
     * Everything typed, pasted or inserted goes out through here.
     *
     * A ref because the mount effect below registers xterm's data handler once,
     * for the life of the pane, and that handler has to reach whatever the
     * current broadcast scope is, not the one that was in force when the pane
     * opened.
     */
    const inputRef = useRef(onInput);
    inputRef.current = onInput;

    // Same reason: the link addon is loaded once, for the life of the pane, so
    // it has to read the current setting rather than the one that was in force
    // when the session opened.
    const linkActivationRef = useRef(terminalSettings.linkActivation);
    linkActivationRef.current = terminalSettings.linkActivation;

    const sendInput = useCallback((data) => {
        if (!pane?.id) return;
        if (inputRef.current) inputRef.current(pane.id, data);
        else window.api.ssh.sendInput(pane.id, data);
    }, [pane?.id]);

    /**
     * Re-measure the pane and tell the remote what it now is.
     *
     * Every path that can change the size of a cell or of the pane ends up
     * here, so there is one place that decides how many rows fit, and so the
     * rule that the bottom row is never clipped only has to hold in one place.
     */
    const pushResize = useCallback(() => {
        const term = termRef.current;
        if (!fitToPane(term, fitAddonRef.current, terminalRef.current)) return;
        window.api.ssh.resize(pane.id, term.cols, term.rows);
    }, [pane?.id, termRef]);

    /** Copy the terminal selection. Returns false when there is nothing to copy. */
    const copySelection = useCallback(async () => {
        const selection = termRef.current?.getSelection();
        if (!selection) return false;
        await window.api.clipboard.writeText(selection);
        return true;
    }, [termRef]);

    const pasteFromClipboard = useCallback(async () => {
        const text = await window.api.clipboard.readText();
        // `paste` (not `sendInput`) so bracketed-paste mode is honoured, so pasting
        // multi-line text into vim or a shell prompt behaves as it should.
        if (text) termRef.current?.paste(text);
    }, [termRef]);

    /**
     * Put a snippet into the shell.
     *
     * Pasted rather than written, for the same reason as the clipboard above: a
     * multi-line snippet has to land in the line editor as one edit instead of
     * running a line at a time. The Enter that runs it is sent separately,
     * because a newline *inside* a bracketed paste is literal text and would
     * sit in the buffer rather than executing.
     */
    const insertSnippet = useCallback((text, runImmediately) => {
        const term = termRef.current;
        if (!term) return;

        // `paste` raises onData, so the snippet follows the same route as
        // typing, including out to every other session when broadcasting.
        term.paste(text);
        if (runImmediately) sendInput('\r');
        term.focus();
    }, [sendInput, termRef]);

    const focus = useCallback(() => {
        termRef.current?.focus();
    }, [termRef]);

    // Memoised because the custom theme is built fresh on every resolve, and a
    // new object identity here would re-assign term.options.theme each render,
    // which makes xterm rebuild its glyph atlas. Resolved by the caller, since
    // TerminalView's JSX (the pane background, the session screen's colours)
    // needs the same value.

    /**
     * Same reasoning as the theme: a fresh object every render would re-assign
     * xterm's options on every commit, and each assignment costs a reflow.
     *
     * Keyed on the contents and not on `terminalSettings`, which is replaced
     * whenever *any* terminal setting changes. Half the record is not in here at
     * all: the scroll easing, the link modifier, the ligature toggle. Memoising
     * on the object would hand the refit effect below a new identity for those
     * too, and refit every pane and SIGWINCH every remote for a record in which
     * nothing moved. Keyed on the values, a change that is not in here is not a
     * change, and the list stays honest on its own as fields come and go.
     */
    const geometry = terminalOptions(terminalSettings);
    const geometryKey = JSON.stringify(geometry);
    const options = useMemo(() => geometry, [geometryKey]);

    /**
     * The record the terminal is built from, read at construction time.
     *
     * The mount effect below is keyed on the pane alone and waits on a font
     * before it constructs. A settings change landing inside that wait would
     * otherwise be lost: the update effect runs, finds no terminal yet, returns,
     * and never fires again, because `options` has already changed. The pane
     * then keeps the settings it was opened with until the next edit.
     */
    const optionsRef = useRef(options);
    optionsRef.current = options;

    /**
     * How long a wheel gesture takes to settle, with reduced motion applied.
     *
     * Deliberately not part of `options`: the easing does not change the size of
     * a cell, and going through that effect would refit every pane and send a
     * window-change to every remote on each of the thirty steps of a slider
     * drag, which is a SIGWINCH storm and a full redraw in anything running
     * full-screen.
     */
    const smoothScrollDuration = prefersReducedMotion() ? 0 : terminalSettings.smoothScrollDuration;
    const smoothScrollRef = useRef(smoothScrollDuration);
    smoothScrollRef.current = smoothScrollDuration;

    /**
     * Put the GPU renderer on a terminal, or take it off again.
     *
     * A pair rather than inline code in two places, because the ligature toggle
     * has to do exactly what mount and unmount do, and a renderer disposed
     * twice, or attached twice, leaves a terminal that draws nothing.
     */
    const attachRenderer = useCallback((term) => {
        if (!term || webglRef.current) return;
        try {
            const addon = new WebglAddon();
            // The context can be lost for reasons that have nothing to do with
            // us (a driver reset, the GPU process restarting). Dropping the
            // addon falls back to the DOM renderer rather than a blank pane.
            addon.onContextLoss(() => {
                try {
                    addon.dispose();
                } catch {
                    // Already gone.
                }
                if (webglRef.current === addon) webglRef.current = null;
            });
            term.loadAddon(addon);
            webglRef.current = addon;
        } catch (error) {
            console.warn('WebGL addon failed to load, using the DOM renderer:', error);
        }
    }, []);

    const detachRenderer = useCallback(() => {
        const addon = webglRef.current;
        webglRef.current = null;
        if (!addon) return;
        try {
            addon.dispose();
        } catch (error) {
            console.warn('WebGL addon dispose failed:', error);
        }
    }, []);

    useEffect(() => {
        if (!terminalRef.current || !pane) return;

        let disposed = false;
        let term = null;
        let observer = null;
        let resizeTimer = null;
        let unsubscribeData = null;
        let unsubscribeDisconnect = null;

        const setup = async () => {
            // xterm derives its cell geometry from the *loaded* font. If the
            // webfont is still pending it measures the fallback instead, so the
            // glyph atlas and the size handed to the PTY both come out wrong:
            // measured here as 125 columns instead of 134.
            //
            // Re-read after each wait rather than building from the record this
            // effect closed over, for the reason `optionsRef` exists. Bounded,
            // because a record still moving after three font loads is a slider
            // mid-drag, and settling for the newest values with a font that is
            // still arriving beats settling for values the user has left behind.
            let mountOptions = optionsRef.current;
            for (let pass = 0; pass < 3; pass += 1) {
                await ensureTerminalFont(
                    mountOptions.fontSize,
                    mountOptions.fontWeight,
                    mountOptions.fontFamily
                );
                if (disposed || !terminalRef.current) return;
                if (optionsRef.current === mountOptions) break;
                mountOptions = optionsRef.current;
            }

            term = new Terminal({
                ...mountOptions,
                theme: themeConfig,
                smoothScrollDuration: smoothScrollRef.current,
                allowProposedApi: true,
                fastScrollModifier: 'alt',
                rescaleOverlappingGlyphs: false,
            });

            const fitAddon = new FitAddon();
            term.loadAddon(fitAddon);
            term.open(terminalRef.current);

            const searchAddon = new SearchAddon();
            term.loadAddon(searchAddon);

            // A URL in the scrollback was printed by the remote, so opening it
            // goes through main, which allowlists the scheme. Only a left click
            // opens, and only when nothing is selected: dragging across a URL to
            // copy it must not also launch a browser.
            //
            // Whether that click has to carry Ctrl (Cmd on macOS) is a setting.
            // A click with the modifier missing says so rather than doing
            // nothing, which would read as a link that is simply broken; one
            // toast id, so a second try replaces the hint instead of stacking
            // another copy under it.
            term.loadAddon(new WebLinksAddon((event, uri) => {
                if (event.button !== 0 || term.hasSelection()) return;

                if (linkActivationRef.current === 'modifier' && !event.ctrlKey && !event.metaKey) {
                    toast(
                        `Hold ${MODIFIER_KEY} and click to open this link`,
                        toastOptions({ id: 'terminal-link-modifier' })
                    );
                    return;
                }

                Promise.resolve(window.api.links?.open(uri))
                    .then((result) => {
                        if (result && !result.success) {
                            toast.error(result.message || 'Could not open that link', toastOptions());
                        }
                    })
                    .catch(() => {});
            }));

            termRef.current = term;
            fitAddonRef.current = fitAddon;
            searchAddonRef.current = searchAddon;

            let overlayHidden = false;
            const hideOverlayOnce = () => {
                if (overlayHidden) return;
                overlayHidden = true;
                setIsConnecting(false);
            };

            // Through `sendInput`, not straight to the session: it is what
            // decides whether this keystroke also reaches the other panes.
            term.onData(data => sendInput(data));

            // Ctrl+Shift+C/V. Plain Ctrl+C must stay SIGINT, which is exactly
            // why terminals put copy on the shifted chord. Returning false
            // stops xterm forwarding the key to the shell.
            term.attachCustomKeyEventHandler((event) => {
                if (event.type !== 'keydown') return true;
                if (!event.ctrlKey || !event.shiftKey || event.altKey) return true;

                if (event.code === 'KeyC') {
                    copySelection();
                    return false;
                }
                if (event.code === 'KeyV') {
                    pasteFromClipboard();
                    return false;
                }
                // Both open a panel that takes DOM focus, so the terminal stops
                // seeing keys until it is closed and Escape can go back to
                // meaning what the shell thinks it means.
                if (event.code === 'KeyF') {
                    onOpenSearch?.();
                    return false;
                }
                if (event.code === 'KeyK') {
                    onOpenSnippets?.();
                    return false;
                }
                return true;
            });

            // The stream closing and the client closing both report the same
            // drop; the connection hook de-duplicates them and decides whether
            // to chase it.
            unsubscribeData = window.api.ssh.onData(pane.id, (message) => {
                if (message.type === 'data') {
                    term.write(message.data);
                    hideOverlayOnce();
                } else if (message.type === 'disconnected') {
                    connectionRef.current.handleDropped();
                }
            });

            unsubscribeDisconnect = window.api.ssh.onDisconnected((paneId) => {
                if (paneId === pane.id) connectionRef.current.handleDropped();
            });

            // Ligatures and the GPU renderer are mutually exclusive: WebGL
            // draws one glyph per cell out of an atlas, which is exactly what a
            // ligature is not. So the renderer is chosen by that setting, and
            // the effect below swaps it when the setting changes.
            //
            // Chosen before the first measurement, never after: the renderer is
            // what decides how tall a row is, and sizing the pane against the
            // DOM renderer's answer only to hand the session to WebGL is a way
            // to come up one row taller than the pane can show.
            if (!terminalSettings.ligatures) attachRenderer(term);

            await nextFrame();
            if (disposed) return;
            fitToPane(term, fitAddon, terminalRef.current);

            // Refit on any layout change. The sidebar, the fullscreen toggle and
            // every divider drag move it too, not just window resizes. Debounced
            // so dragging doesn't reflow the buffer and storm the remote with
            // SIGWINCH on every frame.
            observer = new ResizeObserver(() => {
                clearTimeout(resizeTimer);
                resizeTimer = setTimeout(pushResize, 80);
            });
            observer.observe(terminalRef.current);

            // Nothing to dial: this host has no SSH server, and attempting one
            // would spend the retry budget failing at a machine that was never
            // going to answer. True of a desktop-only host, and more plainly
            // true of an IPMI-only one, where the machine behind the service
            // processor may not even be powered on.
            if (pane?.host?.desktop?.enabled && pane.host.desktop.only) return;
            if (pane?.host?.bmc?.enabled && pane.host.bmc.only) return;

            if (connectedPanes.has(pane.id)) return;
            connectedPanes.add(pane.id);

            const result = await connectionRef.current.connect();
            if (disposed) return;
            if (!result?.success) hideOverlayOnce();
        };

        setup();

        return () => {
            disposed = true;
            clearTimeout(resizeTimer);
            observer?.disconnect();
            unsubscribeData?.();
            unsubscribeDisconnect?.();
            connectedPanes.delete(pane.id);
            searchAddonRef.current = null;
            window.api.ssh.release(pane.id);

            // Tear the GPU renderer down before the terminal, and never let a
            // failure escape: an exception thrown from a cleanup function
            // unmounts the entire React tree, blanking the window.
            detachRenderer();
            try {
                term?.dispose();
            } catch (error) {
                console.warn('Terminal dispose failed:', error);
            }
        };
        // eslint-disable-next-line react-hooks/exhaustive-deps
    }, [pane?.id]);

    // Update theme when it changes
    useEffect(() => {
        if (termRef.current) {
            termRef.current.options.theme = themeConfig;
        }
    }, [themeConfig, termRef]);

    // Scroll easing, live. Assigned on its own, not refitted: see the comment on
    // `smoothScrollDuration` for why it stays out of the typography effect.
    useEffect(() => {
        if (termRef.current) {
            termRef.current.options.smoothScrollDuration = smoothScrollDuration;
        }
    }, [smoothScrollDuration, termRef]);

    /**
     * Typography, live.
     *
     * Every one of these changes the size of a cell, so the terminal has to be
     * measured again and the remote told its new window size; otherwise the
     * shell keeps wrapping at the old column count and every line it redraws
     * lands in the wrong place. One effect for all of them, because that refit
     * only needs doing once however many settings moved.
     */
    useEffect(() => {
        const term = termRef.current;
        if (!term || !fitAddonRef.current) return;

        // Loaded first: assigning a family the browser has not fetched yet makes
        // xterm measure the fallback and cache the wrong cell width.
        let cancelled = false;
        ensureTerminalFont(options.fontSize, options.fontWeight, options.fontFamily).then(() => {
            if (cancelled || termRef.current !== term) return;

            for (const [key, value] of Object.entries(options)) {
                if (term.options[key] !== value) term.options[key] = value;
            }

            pushResize();
        });

        return () => { cancelled = true; };
    }, [options, pane?.id, pushResize, termRef]);

    /**
     * The renderer follows the ligature setting.
     *
     * Skipped on the first run for a pane, since the mount effect has already
     * chosen: doing it here as well would attach the addon to a terminal that
     * does not exist yet, or dispose the one it just made.
     */
    useEffect(() => {
        const term = termRef.current;
        if (!term) return;

        if (terminalSettings.ligatures) detachRenderer();
        else attachRenderer(term);

        // The atlas the old renderer built is the wrong shape for the new one,
        // and so, by a pixel or two, is its idea of how tall a row is, which is
        // why the remote is told about this and not just the screen.
        pushResize();
        term.refresh(0, term.rows - 1);
    }, [terminalSettings.ligatures, attachRenderer, detachRenderer, pushResize, termRef]);

    // Handle resize on visibility change or fullscreen toggle. The terminal is
    // not given focus while the session screen is asking something, since the
    // answer is typed into that: see `promptId` below.
    useEffect(() => {
        if (!isActive) return;
        const timer = setTimeout(() => {
            pushResize();
            if (isFocused && !promptId) termRef.current?.focus();
        }, 350); // Wait for sidebar animation
        return () => clearTimeout(timer);
    }, [isActive, isFullscreen, isFocused, promptId, pane?.id, pushResize, termRef]);

    // Following the focused pane has to be immediate: the 350ms settle above is
    // there for an animating layout, and waiting that long to start typing in
    // the pane you just clicked reads as a dropped keystroke. Answering a
    // question hands focus back here, because this is where typing resumes.
    useEffect(() => {
        if (isActive && isFocused && !promptId) termRef.current?.focus();
    }, [isActive, isFocused, promptId, termRef]);

    // The overlay only covers the first dial. A later drop is reported in the
    // header and in the terminal itself, so it must not blank the scrollback
    // the user may still want to read.
    useEffect(() => {
        if (connection.status !== 'connecting') setIsConnecting(false);
        if (connection.status === 'connected') setEverConnected(true);
    }, [connection.status]);

    // Right-click pastes, the way PuTTY and mintty do. A selection is left
    // alone. Use Ctrl+Shift+C for that.
    const handleContextMenu = useCallback((event) => {
        event.preventDefault();
        pasteFromClipboard();
    }, [pasteFromClipboard]);

    // Capture just the terminal's rectangle out of the window and hand it to a
    // viewer window. Measured in CSS pixels, which is what capturePage expects.
    const handleScreenshot = useCallback(async () => {
        const element = terminalRef.current;
        if (!element) return;

        const { x, y, width: rectWidth, height } = element.getBoundingClientRect();
        const result = await window.api.screenshot.capture({
            rect: { x, y, width: rectWidth, height },
            title: titleRef.current,
        });

        if (!result?.success) {
            toast.error(result?.message || 'Screenshot failed', toastOptions());
        }
    }, []);

    return {
        terminalRef,
        searchAddonRef,
        isConnecting,
        everConnected,
        insertSnippet,
        handleContextMenu,
        handleScreenshot,
        focus,
    };
}
