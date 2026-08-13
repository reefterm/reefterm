const fs = require('fs');
const path = require('path');
const store = require('../store');
const rdp = require('../rdp');
const activity = require('../activity');
const { describeDesktop } = require('../desktop-config');

/**
 * Named from the host record rather than from `ssh.describe`, because a
 * direct-transport desktop has no SSH session to describe and would
 * otherwise be logged as happening nowhere.
 */
function describeDesktopHost(hostId) {
    const info = store.describeHost(hostId);
    return { hostId: info.id, hostName: info.name, subject: info.address };
}

// The IronRDP WebAssembly module, cached: it is four megabytes and every
// pane would otherwise ask for its own copy.
let wasmBytes = null;

function register({ handle }) {
    /* ---------------- Remote desktop: RDP ---------------- */

    handle('rdp-get', (event, paneId) => rdp.get(paneId));

    handle('rdp-open', async (event, { paneId, hostId }) => {
        const result = await rdp.open(paneId, hostId);

        activity.record({
            category: 'connection',
            action: 'desktop.open',
            outcome: result.success ? 'success' : 'failure',
            target: describeDesktop(store.getHostDesktop(hostId)),
            detail: 'Remote desktop (RDP)',
            message: result.success ? '' : (result.message || ''),
            ...describeDesktopHost(hostId),
        });

        return result;
    });

    handle('rdp-close', (event, { paneId, hostId }) => {
        // Only a session that existed is worth a line; the view closes
        // defensively on unmount whether or not it ever opened one.
        const existed = Boolean(rdp.get(paneId));
        const result = rdp.close(paneId);

        if (existed && hostId) {
            activity.record({
                category: 'connection',
                action: 'desktop.close',
                target: describeDesktop(store.getHostDesktop(hostId)),
                detail: 'Remote desktop (RDP)',
                ...describeDesktopHost(hostId),
            });
        }

        return result;
    });

    /**
     * The IronRDP WebAssembly module, as bytes.
     *
     * The module ships a loader that resolves the `.wasm` relative to
     * `import.meta.url` and fetches it. Electron does allow that under `file://`
     * for the app's own origin, so it would work, but only because Electron is
     * more permissive there than the web is, and only while `webSecurity` and
     * the sandbox flags stay as they are. Serving the bytes from here instead
     * depends on none of that, and keeps one copy of the module rather than a
     * second emitted into the bundle.
     */
    handle('rdp-wasm', () => {
        if (wasmBytes) return wasmBytes;

        // Resolved through the package rather than by path so it is found the
        // same way inside an asar archive as it is in node_modules.
        const entry = require.resolve('ironrdp-wasm');
        const binary = path.join(path.dirname(entry), 'rdp_client_bg.wasm');

        wasmBytes = fs.readFileSync(binary);
        return wasmBytes;
    });
}

module.exports = { register };
