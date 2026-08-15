import { PaintBoardIcon } from 'hugeicons-react';
import Tooltip from './ui/Tooltip';
import AgentMark from './assistant/AgentMark';
import {
    APP_GUTTER,
    PANEL_REVEAL_EASE,
    PANEL_REVEAL_MS,
    PANE_HEADER_HEIGHT,
    QUICK_ACCESS_GUTTER_WIDTH,
} from '../lib/layout';
import { useT } from '../i18n';

/**
 * The vertical strip of quick-access tools pinned to the right edge: the
 * assistant and the theme switcher today, stacked so the next tool only ever
 * adds a row, never another column. Unlike the panels it opens, this strip
 * itself never disappears while any tool is enabled - it's chrome holding a
 * gutter, not a surface, and a vanished button would strand you with no way
 * to reach another tool or close the open one.
 *
 * It does ease its own leading gap open/shut with PanelDock's card, so the
 * two gaps either side of an open card match; shut, there's no card to earn
 * a second gutter, so that gap collapses to zero.
 */
function GutterButton({ title, hint, icon, active, onClick }) {
    return (
        <Tooltip label={title} hint={hint} placement="left">
            <button
                type="button"
                aria-label={title}
                aria-pressed={active}
                onClick={onClick}
                className={`w-8 h-8 shrink-0 flex items-center justify-center rounded-xl transition-colors
                    outline-none focus-visible:ring-2 focus-visible:ring-gray-900/20 dark:focus-visible:ring-white/25
                    ${active
                        ? 'bg-surface-active/30 text-gray-900 dark:text-white'
                        : `text-gray-500 dark:text-gray-400
                            hover:bg-surface-control hover:text-gray-900
                            dark:hover:text-white`}`}
            >
                {icon}
            </button>
        </Tooltip>
    );
}

// Shared with App.jsx and PanelDock so all three key off the same strings
// rather than each hand-typing a copy that could drift.
export const TOOL_IDS = {
    ASSISTANT: 'com.reefterm.builtin.ai',
    THEME_SWITCHER: 'com.reefterm.quickaccess.theme-switcher',
};

// Static: icon, title key and hint never change, so adding a tool is one
// more entry here rather than a new prop threaded through App.jsx.
const TOOLS = [
    {
        id: TOOL_IDS.ASSISTANT,
        icon: <AgentMark size={20} mono />,
        titleKey: 'assistant.title',
        hint: 'Ctrl+Shift+A',
    },
    {
        id: TOOL_IDS.THEME_SWITCHER,
        icon: <PaintBoardIcon size={20} strokeWidth={1.5} />,
        titleKey: 'themeSwitcher.title',
    },
];

// `toolState`: `{ [id]: { enabled, open, onToggle } }`, keyed by TOOLS id. A
// tool missing or `enabled: false` is left out, hiding the strip entirely
// once nothing in it is enabled.
export default function QuickAccessGutter({ toolState }) {
    const t = useT();
    const visible = TOOLS.filter(tool => toolState[tool.id]?.enabled);
    if (visible.length === 0) return null;

    // A card mounted anywhere on the way in or out still earns the gap, not
    // just once it has fully landed.
    const panelOpen = visible.some(tool => toolState[tool.id]?.open);
    const gap = panelOpen ? APP_GUTTER : 0;

    return (
        <div
            className="relative shrink-0 flex flex-col items-center bg-surface-base"
            style={{
                width: QUICK_ACCESS_GUTTER_WIDTH + gap,
                paddingLeft: gap,
                transition: `width ${PANEL_REVEAL_MS}ms ${PANEL_REVEAL_EASE}, padding-left ${PANEL_REVEAL_MS}ms ${PANEL_REVEAL_EASE}`,
            }}
        >
            {visible.map((tool) => {
                const { open, onToggle } = toolState[tool.id];
                return (
                    <div
                        key={tool.id}
                        className="flex items-center justify-center"
                        style={{ width: QUICK_ACCESS_GUTTER_WIDTH, height: PANE_HEADER_HEIGHT }}
                    >
                        <GutterButton
                            title={t(tool.titleKey)}
                            hint={tool.hint}
                            icon={tool.icon}
                            active={open}
                            onClick={onToggle}
                        />
                    </div>
                );
            })}
        </div>
    );
}
