import { useEffect, useRef, useState } from 'react';

// A pane can be a quarter of the window, so the header sheds what it cannot
// fit, least important first: the view labels, then the status line. What is
// left is the pane's name and the route mark, which between them say which
// session you are looking at and where it goes.
const COMPACT_WIDTH = 760;
const NARROW_WIDTH = 560;

// The action buttons are handled separately, because they are not dropped;
// they move into the header's burger menu one at a time as the room for them
// runs out, so every action stays reachable at any pane width.
const ACTION_BUTTON = 32;                 // w-8
const ACTION_GAP_COMPACT = 6;             // gap-1.5
const ACTION_GAP = 8;                     // gap-2
const HEADER_CHROME = 24 + 12;            // px-3 either side, gap-3 between groups
// What the pane's name is never made to give up. Below this the title would be
// an ellipsis and the header would stop identifying the session at all.
const IDENTITY_MIN = 124;

/**
 * How much header room a pane has, and what that buys.
 *
 * `rootRef` goes on the pane's own root element, `fixedRef` on the group that
 * never folds (the view switcher and Reconnect): both are measured rather than
 * derived from the split, because a pane's width depends on where the dividers
 * happen to be.
 */
export function useHeaderFit() {
    const rootRef = useRef(null);
    const fixedRef = useRef(null);
    const [width, setWidth] = useState(Infinity);
    // The view switcher and the Reconnect button never collapse, and both are
    // text-sized, so how much room is left for the action buttons is measured
    // off them rather than guessed at. Starts at 0 so the first paint, before
    // any measurement, errs towards showing everything.
    const [fixedWidth, setFixedWidth] = useState(0);

    useEffect(() => {
        const element = rootRef.current;
        if (!element) return;

        const observer = new ResizeObserver(([entry]) => {
            setWidth(entry.contentRect.width);
        });
        observer.observe(element);
        return () => observer.disconnect();
    }, []);

    // Safe from feedback: this group's width follows `narrow` and the
    // connection status, never the number of action buttons beside it, so
    // measuring it cannot make it change size again.
    useEffect(() => {
        const element = fixedRef.current;
        if (!element) return;

        const observer = new ResizeObserver(([entry]) => {
            setFixedWidth(entry.contentRect.width);
        });
        observer.observe(element);
        return () => observer.disconnect();
    }, []);

    const compact = width < COMPACT_WIDTH;
    const narrow = width < NARROW_WIDTH;

    // How many action buttons the header can still afford. One slot is spent up
    // front on the burger itself, whether or not it ends up needed; paying for
    // it only once something overflows would mean the button that opens the menu
    // is what pushed the next action into it.
    const actionSlot = ACTION_BUTTON + (compact ? ACTION_GAP_COMPACT : ACTION_GAP);
    const actionSlots = Math.max(
        0,
        Math.floor((width - HEADER_CHROME - IDENTITY_MIN - fixedWidth - actionSlot) / actionSlot)
    );

    return { rootRef, fixedRef, compact, narrow, actionSlots };
}
