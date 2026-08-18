import { afterEach } from 'vitest';
import { cleanup } from '@testing-library/react';
import '@testing-library/jest-dom/vitest';

// React Testing Library mounts each rendered component into the shared jsdom
// document; without this, a component from one test is still there for the
// next one to trip over.
afterEach(() => {
    cleanup();
});

// jsdom implements no layout at all, so it has nothing to scroll and never
// defined this. ui/Select.jsx calls it on the active row whenever the list's
// open, which is any test that opens one.
if (typeof Element !== 'undefined' && !Element.prototype.scrollIntoView) {
    Element.prototype.scrollIntoView = () => {};
}
