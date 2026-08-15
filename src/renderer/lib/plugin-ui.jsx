// Renders a plugin's contributed UI nodes (see src/main/plugins/ui-extensions.js)
// as the app's own real components. A plugin never ships JSX - only a small
// object from a fixed vocabulary of node types - so everything here is
// trusted code turning that description into something drawn on screen; a
// plugin gets no closer to the DOM than this file's own props.

import { useCallback, useEffect, useLayoutEffect, useRef, useState } from 'react';
import { createPortal } from 'react-dom';
import { Package01Icon, ArrowRight01Icon, CloudServerIcon, PuzzleIcon } from 'hugeicons-react';
import { place, ENTRANCE, ARROW_EDGES, arrowStyle } from '../components/ui/Tooltip';
import CopyButton from '../components/ui/CopyButton';

/** The fixed vocabulary of icon names a node's `icon` field may reference - not an open door to any hugeicons name. */
const ICONS = {
    box: Package01Icon,
    server: CloudServerIcon,
    'arrow-right': ArrowRight01Icon,
};

/** Nothing when a node simply didn't ask for an icon; the puzzle-piece fallback is only for an unrecognised name. */
export function PluginIcon({ name, size = 16, strokeWidth = 2 }) {
    if (!name) return null;
    const Icon = ICONS[name] || PuzzleIcon;
    return <Icon size={size} strokeWidth={strokeWidth} />;
}

/**
 * A contributed `button` node as a TerminalView pane-header action. `shed`
 * starts above every first-party action's own (8 is the highest today), so
 * a plugin's button always folds into the overflow menu first, never a
 * native one; `index` spreads ties across several contributions.
 */
export function toPaneAction({ pluginId, id, node }, invoke, index = 0) {
    const label = node.badge === undefined || node.badge === '' ? node.label : `${node.label} (${node.badge})`;
    return {
        key: `plugin:${pluginId}:${id}`,
        shed: 9 + index,
        label,
        menuLabel: label,
        icon: <PluginIcon name={node.icon} size={16} />,
        menuIcon: <PluginIcon name={node.icon} size={14} />,
        onSelect: () => invoke(pluginId, node.onAction),
    };
}

const TONE_TEXT = {
    default: 'text-gray-700 dark:text-gray-200',
    warning: 'text-amber-600 dark:text-amber-400',
    critical: 'text-red-600 dark:text-red-400',
};
const TONE_BAR = {
    default: 'bg-gray-400 dark:bg-neutral-500',
    warning: 'bg-amber-500',
    critical: 'bg-red-500',
};

function TooltipRowLabel({ row }) {
    return (
        <span className="flex items-center gap-1.5 min-w-0 truncate text-gray-500 dark:text-neutral-400">
            <PluginIcon name={row.icon} size={12} />
            {row.label}
        </span>
    );
}

function TooltipRowText({ row }) {
    return (
        <div className="flex items-center justify-between gap-4">
            <TooltipRowLabel row={row} />
            <span className={`shrink-0 font-medium [font-variant-numeric:tabular-nums] ${TONE_TEXT[row.tone] || TONE_TEXT.default}`}>
                {row.value}
            </span>
        </div>
    );
}

function TooltipRowBar({ row }) {
    return (
        <div className="flex flex-col gap-1">
            <div className="flex items-center justify-between gap-4">
                <TooltipRowLabel row={row} />
                <span className={`shrink-0 font-medium [font-variant-numeric:tabular-nums] ${TONE_TEXT[row.tone] || TONE_TEXT.default}`}>
                    {row.value}
                </span>
            </div>
            <div className="h-1 rounded-full bg-gray-100 dark:bg-neutral-800 overflow-hidden">
                <div
                    className={`h-full rounded-full ${TONE_BAR[row.tone] || TONE_BAR.default}`}
                    style={{ width: `${Math.max(0, Math.min(100, row.percent))}%` }}
                />
            </div>
        </div>
    );
}

/** The only row with pointer-events of its own that isn't a full-row button - CopyButton owns its own click. */
function TooltipRowCopy({ row }) {
    return (
        <div className="group flex items-center justify-between gap-4">
            <TooltipRowLabel row={row} />
            <span className="shrink-0 flex items-center gap-1">
                <span className="font-mono text-[11px] text-gray-600 dark:text-gray-300 truncate max-w-[110px]">
                    {row.value}
                </span>
                <CopyButton text={row.value} />
            </span>
        </div>
    );
}

function TooltipRowCta({ row, pluginId, invoke }) {
    const run = () => (row.url ? window.api?.links?.open(row.url) : invoke(pluginId, row.onAction));
    return (
        <button
            type="button"
            onClick={run}
            className="flex items-center gap-1.5 w-full text-left text-blue-600 dark:text-blue-400 hover:underline"
        >
            <PluginIcon name={row.icon} size={12} />
            {row.label}
        </button>
    );
}

const TOOLTIP_ROWS = { text: TooltipRowText, bar: TooltipRowBar, copy: TooltipRowCopy, cta: TooltipRowCta };

/**
 * The rich tooltip's body and placement. Reuses ui/Tooltip.jsx's viewport
 * placement math rather than duplicating it, but has to accept the pointer
 * (unlike every tooltip there), since click-to-copy and CTA rows are the
 * entire point of it.
 */
function TileTooltipBubble({ tooltip, pluginId, invoke, trigger, closing, onEnter, onLeave }) {
    const bubbleRef = useRef(null);
    const [position, setPosition] = useState(null);

    useLayoutEffect(() => {
        const element = bubbleRef.current;
        if (!element) return;
        setPosition(place('top', trigger, { width: element.offsetWidth, height: element.offsetHeight }));
    }, [trigger]);

    const side = position?.side || 'top';

    return createPortal(
        <div
            ref={bubbleRef}
            role="tooltip"
            onMouseEnter={onEnter}
            onMouseLeave={onLeave}
            className={`tooltip-bubble ${closing ? 'tooltip-bubble-closing' : ''}
                fixed z-[10000] w-64 max-w-[80vw] rounded-lg px-3 py-2.5 text-xs
                bg-white dark:bg-surface-raised
                border border-gray-200 dark:border-surface-control
                shadow-[0_8px_24px_rgba(0,0,0,0.12)] dark:shadow-[0_8px_28px_rgba(0,0,0,0.4)]`}
            style={{
                top: position?.top ?? -9999,
                left: position?.left ?? -9999,
                visibility: position ? 'visible' : 'hidden',
                ...ENTRANCE[side],
            }}
        >
            <span
                aria-hidden="true"
                className={`absolute w-2 h-2 rotate-45 bg-white dark:bg-surface-raised
                    border-gray-200 dark:border-surface-control ${ARROW_EDGES[side]}`}
                style={arrowStyle(side, position?.arrow ?? 12)}
            />
            <div className="relative flex flex-col gap-2">
                {tooltip.title && (
                    <div className="flex items-center gap-1.5 pb-1.5 font-semibold text-gray-900 dark:text-white
                        border-b border-gray-100 dark:border-neutral-800">
                        <PluginIcon name={tooltip.icon} size={13} />
                        {tooltip.title}
                    </div>
                )}
                <div className="flex flex-col gap-2">
                    {tooltip.rows.map((row, index) => {
                        const RowComponent = TOOLTIP_ROWS[row.type];
                        return RowComponent
                            ? <RowComponent key={index} row={row} pluginId={pluginId} invoke={invoke} />
                            : null;
                    })}
                </div>
            </div>
        </div>,
        document.body
    );
}

/** How long the bubble waits before closing, so moving the pointer from the tile into it does not flicker-close it. */
const TOOLTIP_HIDE_DELAY = 120;

/** Matches input.css's tooltip-out duration - the bubble stays mounted this long after closing starts, to play it. */
const TOOLTIP_EXIT_MS = 120;

/**
 * Hover-intent, not `ui/Tooltip.jsx`'s useTooltip: the bubble is itself a
 * valid target, so leaving the trigger can't mean closing immediately - the
 * pointer needs room to cross the gap. Closing is also a two-step: `closing`
 * flips first to play the exit animation, then `trigger` clears and unmounts it.
 */
function useTileTooltip(enabled) {
    const [trigger, setTrigger] = useState(null);
    const [closing, setClosing] = useState(false);
    const hideTimer = useRef(0);
    const exitTimer = useRef(0);

    const cancelHide = useCallback(() => {
        clearTimeout(hideTimer.current);
        clearTimeout(exitTimer.current);
        setClosing(false);
    }, []);

    const scheduleHide = useCallback(() => {
        cancelHide();
        hideTimer.current = setTimeout(() => {
            setClosing(true);
            exitTimer.current = setTimeout(() => setTrigger(null), TOOLTIP_EXIT_MS);
        }, TOOLTIP_HIDE_DELAY);
    }, [cancelHide]);

    const show = useCallback((event) => {
        if (!enabled) return;
        cancelHide();
        setTrigger(event.currentTarget.getBoundingClientRect());
    }, [enabled, cancelHide]);

    useEffect(() => () => {
        clearTimeout(hideTimer.current);
        clearTimeout(exitTimer.current);
    }, []);

    // Same dismissal set as ui/Tooltip.jsx's useTooltip, instant rather than
    // animated: scroll/resize move the trigger the exit animation would
    // otherwise fly back towards, so this is a cut, not a movement.
    useEffect(() => {
        if (!trigger) return undefined;
        const dismiss = () => { setClosing(false); setTrigger(null); };
        const handleKey = (event) => { if (event.key === 'Escape') dismiss(); };
        window.addEventListener('blur', dismiss);
        window.addEventListener('resize', dismiss);
        document.addEventListener('scroll', dismiss, true);
        document.addEventListener('keydown', handleKey, true);
        return () => {
            window.removeEventListener('blur', dismiss);
            window.removeEventListener('resize', dismiss);
            document.removeEventListener('scroll', dismiss, true);
            document.removeEventListener('keydown', handleKey, true);
        };
    }, [trigger]);

    return { trigger, closing, show, hide: scheduleHide, cancelHide };
}

/**
 * A contributed `tile` node as a status-bar readout - a plain element
 * unless `onAction` makes it a drill-down button. An optional `tooltip`
 * opens on hover independently of that: a tile can be either, both, or neither.
 */
export function StatusTile({ contribution: { pluginId, node }, invoke }) {
    const clickable = Boolean(node.onAction);
    const hasTooltip = Boolean(node.tooltip);
    const { trigger, closing, show, hide, cancelHide } = useTileTooltip(hasTooltip);
    const Tag = clickable ? 'button' : 'div';

    return (
        <>
            <Tag
                type={clickable ? 'button' : undefined}
                onClick={clickable ? () => invoke(pluginId, node.onAction) : undefined}
                onMouseEnter={hasTooltip ? show : undefined}
                onMouseLeave={hasTooltip ? hide : undefined}
                className={`flex items-center gap-1.5 text-xs shrink-0 ${
                    clickable ? 'cursor-pointer hover:opacity-75 transition-opacity' : ''
                }`}
            >
                <PluginIcon name={node.icon} size={13} />
                <span className="text-gray-400 dark:text-neutral-500">{node.label}</span>
                <span className="font-semibold text-gray-700 dark:text-gray-200 [font-variant-numeric:tabular-nums]">
                    {node.value}{node.unit || ''}
                </span>
            </Tag>
            {hasTooltip && trigger && (
                <TileTooltipBubble
                    tooltip={node.tooltip}
                    pluginId={pluginId}
                    invoke={invoke}
                    trigger={trigger}
                    closing={closing}
                    onEnter={cancelHide}
                    onLeave={hide}
                />
            )}
        </>
    );
}

/**
 * What PluginConsentDialog shows for a manifest-declared `sample`, before
 * anything is running. `tile` reuses StatusTile itself so the preview is
 * pixel-identical to what renders later; `button`/`menuItem` share a chip look.
 */
export function NodePreview({ node }) {
    if (!node) return null;
    if (node.type === 'tile') {
        return <StatusTile contribution={{ pluginId: '', node }} invoke={() => {}} />;
    }
    if (node.type !== 'button' && node.type !== 'menuItem') return null;
    const label = node.type === 'button' && node.badge !== undefined && node.badge !== ''
        ? `${node.label} (${node.badge})`
        : node.label;
    return (
        <span
            className="inline-flex items-center gap-1.5 h-7 px-2.5 rounded-lg border text-xs font-medium shadow-sm
                border-gray-200 dark:border-neutral-700 text-gray-700 dark:text-gray-200 bg-white dark:bg-neutral-900"
        >
            <PluginIcon name={node.icon} size={13} />
            {label}
        </span>
    );
}

/** A contributed `menuItem` node as a ui/ContextMenu entry. `args` is the menu's own context - a host menu passes the host id. */
export function toContextMenuItem({ pluginId, node }, invoke, args = []) {
    return {
        label: node.label,
        icon: <PluginIcon name={node.icon} size={16} />,
        danger: Boolean(node.danger),
        onClick: () => invoke(pluginId, node.onAction, args),
    };
}
