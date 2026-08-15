import { useCallback, useEffect, useRef, useState } from 'react';
import AssistantConversation from './assistant/AssistantConversation';
import ThemeSwitcherContent from './theme/ThemeSwitcherContent';
import { TOOL_IDS } from './QuickAccessGutter';
import { APP_GUTTER, PANEL_REVEAL_MS, PANEL_REVEAL_EASE } from '../lib/layout';

/**
 * The one column on the right edge that shows a panel, open or shut.
 *
 * Used to be two independent columns (assistant, theme switcher), each with
 * its own slice of gutter even while shut, so the gap beside QuickAccessGutter
 * changed width depending on which one (if either) was open. One column means
 * one width, and switching between panels glides straight to the new width
 * instead of closing and reopening - the stutter two columns produced.
 *
 * The card keeps its own width and the column clips it, rather than
 * reflowing a transcript or a growing textarea on every frame of the slide.
 */
const MIN_ASSISTANT_WIDTH = 340;
const MAX_ASSISTANT_WIDTH = 720;
const THEME_WIDTH = 300;

/** The card, matching `#main-content`'s 16px radius and surface. */
const CARD = 'rounded-2xl bg-surface-raised';

function widthFor(panel, assistantWidth) {
    if (panel === TOOL_IDS.ASSISTANT) return assistantWidth;
    if (panel === TOOL_IDS.THEME_SWITCHER) return THEME_WIDTH;
    return 0;
}

export default function PanelDock({
    activePanel,
    onClose,
    // assistant
    assistantSessions,
    assistantHosts,
    activeSessionId,
    assistantWidth,
    onAssistantWidthChange,
    onOpenAssistantSettings,
    // theme
    theme,
    darkTint,
    lightTint,
    appColors,
    lightAppColors,
    resolvedDark,
    onThemeChange,
    onDarkTintChange,
    onLightTintChange,
    terminalTheme,
    customTerminalTheme,
    onTerminalThemeChange,
}) {
    // Lags `activePanel` by a couple of frames so the width transition has
    // an old value to start from; `renderedPanel` below does not lag.
    const [targetPanel, setTargetPanel] = useState(activePanel);

    // Outlives `activePanel` going to null by one slide, so there is a card
    // left to collapse. Untouched by a switch between two panels.
    const [mounted, setMounted] = useState(activePanel !== null);

    const [renderedPanel, setRenderedPanel] = useState(activePanel);
    const [sliding, setSliding] = useState(false);

    const drawn = useRef(activePanel);

    useEffect(() => {
        if (drawn.current === activePanel) return undefined;
        drawn.current = activePanel;

        setSliding(true);
        if (activePanel !== null) {
            setMounted(true);
            setRenderedPanel(activePanel);
        }

        // Two frames: one to paint the column where it is, one to send it
        // where it's going - both in the same paint and it jumps instead of
        // sliding. Cancelled on cleanup so StrictMode's second mount can't
        // leave the first one's inner frame running.
        let inner = 0;
        const outer = requestAnimationFrame(() => {
            inner = requestAnimationFrame(() => setTargetPanel(activePanel));
        });

        // The two frames plus the slide, with a frame in hand.
        const landed = setTimeout(() => {
            setSliding(false);
            if (activePanel === null) {
                setMounted(false);
                setRenderedPanel(null);
            }
        }, PANEL_REVEAL_MS + 50);

        return () => {
            cancelAnimationFrame(outer);
            cancelAnimationFrame(inner);
            clearTimeout(landed);
        };
    }, [activePanel]);

    // Read live, not cached: assistantWidth can change under targetPanel
    // (someone dragging the handle) without that being open/close/switch.
    const columnWidth = widthFor(targetPanel, assistantWidth);
    const cardWidth = renderedPanel === TOOL_IDS.ASSISTANT ? assistantWidth : THEME_WIDTH;

    /** The grab strip, which lives in the gutter between the two cards. */
    const startResize = useCallback((event) => {
        event.preventDefault();
        const startX = event.clientX;
        const startWidth = assistantWidth;

        const onMove = (move) => {
            // Dragging left widens, so the delta is inverted.
            const next = Math.min(
                MAX_ASSISTANT_WIDTH,
                Math.max(MIN_ASSISTANT_WIDTH, startWidth + (startX - move.clientX)),
            );
            onAssistantWidthChange(next);
        };
        const onUp = () => {
            document.removeEventListener('mousemove', onMove);
            document.removeEventListener('mouseup', onUp);
            document.body.style.cursor = '';
            document.body.style.userSelect = '';
        };

        document.addEventListener('mousemove', onMove);
        document.addEventListener('mouseup', onUp);
        document.body.style.cursor = 'col-resize';
        document.body.style.userSelect = 'none';
    }, [assistantWidth, onAssistantWidthChange]);

    return (
        <div
            className="relative shrink-0 bg-surface-base"
            style={{
                width: columnWidth + APP_GUTTER,
                paddingLeft: APP_GUTTER,
                transition: sliding ? `width ${PANEL_REVEAL_MS}ms ${PANEL_REVEAL_EASE}` : undefined,
                overflow: sliding ? 'hidden' : 'visible',
            }}
        >
            {/* Not mid-slide, and not for the theme switcher - fixed width, nothing to drag. */}
            {targetPanel === TOOL_IDS.ASSISTANT && !sliding && (
                <div
                    className="absolute left-0 inset-y-0 z-10 cursor-col-resize group"
                    style={{ width: APP_GUTTER }}
                    onMouseDown={startResize}
                >
                    <div className="absolute inset-y-0 left-1/2 -translate-x-1/2 w-0.5 rounded-full
                        bg-transparent group-hover:bg-gray-900/15 dark:group-hover:bg-white/15 transition-colors" />
                </div>
            )}

            {mounted && (
                <aside
                    className={`absolute inset-y-0 right-0 flex flex-col ${CARD}`}
                    style={{
                        width: cardWidth,
                        opacity: targetPanel !== null ? 1 : 0,
                        // Half the card can hang outside the clip mid-slide.
                        pointerEvents: targetPanel !== null ? 'auto' : 'none',
                        transition: `opacity ${PANEL_REVEAL_MS}ms ${PANEL_REVEAL_EASE}`,
                    }}
                >
                    {renderedPanel === TOOL_IDS.ASSISTANT && (
                        <AssistantConversation
                            sessions={assistantSessions}
                            hosts={assistantHosts}
                            activeSessionId={activeSessionId}
                            onOpenSettings={onOpenAssistantSettings}
                            onClose={onClose}
                        />
                    )}
                    {renderedPanel === TOOL_IDS.THEME_SWITCHER && (
                        <ThemeSwitcherContent
                            theme={theme}
                            darkTint={darkTint}
                            lightTint={lightTint}
                            appColors={appColors}
                            lightAppColors={lightAppColors}
                            resolvedDark={resolvedDark}
                            onThemeChange={onThemeChange}
                            onDarkTintChange={onDarkTintChange}
                            onLightTintChange={onLightTintChange}
                            terminalTheme={terminalTheme}
                            customTerminalTheme={customTerminalTheme}
                            onTerminalThemeChange={onTerminalThemeChange}
                            onClose={onClose}
                        />
                    )}
                </aside>
            )}
        </div>
    );
}
