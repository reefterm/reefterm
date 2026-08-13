import { afterEach } from 'vitest';
import { cleanup } from '@testing-library/react';
import '@testing-library/jest-dom/vitest';

// React Testing Library mounts each rendered component into the shared jsdom
// document; without this, a component from one test is still there for the
// next one to trip over.
afterEach(() => {
    cleanup();
});
