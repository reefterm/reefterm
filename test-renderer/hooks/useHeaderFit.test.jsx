/**
 * Characterizes useHeaderFit, extracted out of TerminalView.jsx: the header's
 * compact/narrow breakpoints and how many action buttons fit before the rest
 * fold into the overflow menu.
 *
 * jsdom has no ResizeObserver, so one is stubbed here: `observe(element)`
 * remembers which fake instance is watching which element, and the test
 * triggers a resize by calling that instance's callback directly, the same
 * shape a real observer would call it with.
 */
import { describe, test, expect, beforeEach, afterEach } from 'vitest';
import { act, render } from '@testing-library/react';
import { useHeaderFit } from '../../src/renderer/hooks/useHeaderFit.js';

let stub;
let originalResizeObserver;

function installResizeObserverStub() {
    const instances = [];
    class FakeResizeObserver {
        constructor(callback) {
            this.callback = callback;
            this.observed = null;
            instances.push(this);
        }
        observe(element) {
            this.observed = element;
        }
        disconnect() {
            this.observed = null;
        }
    }
    window.ResizeObserver = FakeResizeObserver;
    return {
        resize(element, width) {
            const instance = instances.find(i => i.observed === element);
            if (!instance) throw new Error('nothing is observing that element');
            act(() => {
                instance.callback([{ contentRect: { width } }]);
            });
        },
    };
}

beforeEach(() => {
    originalResizeObserver = window.ResizeObserver;
    stub = installResizeObserverStub();
});

afterEach(() => {
    window.ResizeObserver = originalResizeObserver;
});

// A hook that measures real elements needs real elements: renderHook alone
// mounts nothing, so rootRef/fixedRef would stay null forever. This renders a
// small harness and hands back the hook's latest return value on every render.
function renderHeaderFit() {
    let latest;
    function Harness() {
        latest = useHeaderFit();
        return (
            <div ref={latest.rootRef}>
                <div ref={latest.fixedRef} />
            </div>
        );
    }
    render(<Harness />);
    return { get current() { return latest; } };
}

describe('useHeaderFit', () => {
    test('errs towards showing everything before anything has been measured', () => {
        const hook = renderHeaderFit();
        expect(hook.current.compact).toBe(false);
        expect(hook.current.narrow).toBe(false);
    });

    test('goes compact under 760px', () => {
        const hook = renderHeaderFit();

        stub.resize(hook.current.rootRef.current, 800);
        expect(hook.current.compact).toBe(false);

        stub.resize(hook.current.rootRef.current, 759);
        expect(hook.current.compact).toBe(true);
    });

    test('goes narrow under 560px, on top of compact', () => {
        const hook = renderHeaderFit();

        stub.resize(hook.current.rootRef.current, 600);
        expect(hook.current.compact).toBe(true);
        expect(hook.current.narrow).toBe(false);

        stub.resize(hook.current.rootRef.current, 559);
        expect(hook.current.narrow).toBe(true);
    });

    test('never offers a negative number of action slots on a pane too narrow for any', () => {
        const hook = renderHeaderFit();
        stub.resize(hook.current.rootRef.current, 50);
        expect(hook.current.actionSlots).toBe(0);
    });

    test('offers more action slots as the pane widens', () => {
        const hook = renderHeaderFit();

        stub.resize(hook.current.rootRef.current, 400);
        const atNarrow = hook.current.actionSlots;

        stub.resize(hook.current.rootRef.current, 1400);
        const atWide = hook.current.actionSlots;

        expect(atWide).toBeGreaterThan(atNarrow);
    });

    test('gives the action buttons back the room a smaller fixed group frees up', () => {
        const hook = renderHeaderFit();
        stub.resize(hook.current.rootRef.current, 900);

        stub.resize(hook.current.fixedRef.current, 300);
        const withWideFixedGroup = hook.current.actionSlots;

        stub.resize(hook.current.fixedRef.current, 50);
        const withNarrowFixedGroup = hook.current.actionSlots;

        expect(withNarrowFixedGroup).toBeGreaterThan(withWideFixedGroup);
    });
});
