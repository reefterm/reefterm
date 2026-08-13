const { ipcMain, app, dialog, shell, clipboard } = require('electron');
const fs = require('fs');
const path = require('path');
const screenshot = require('../screenshot');
const startup = require('../startup');

/**
 * Image formats the title bar will accept for a custom logo, and the MIME type
 * each is handed back under. An extension not listed here is refused rather
 * than guessed at: the renderer draws whatever comes back in an `<img>`, and a
 * data URL is only as trustworthy as the type on the front of it.
 */
const LOGO_TYPES = {
    '.png': 'image/png',
    '.jpg': 'image/jpeg',
    '.jpeg': 'image/jpeg',
    '.gif': 'image/gif',
    '.webp': 'image/webp',
    '.svg': 'image/svg+xml',
    '.bmp': 'image/bmp',
    '.ico': 'image/x-icon',
};

// The mark is drawn 24 pixels square and the data URL rides along in the
// settings snapshot, so there is no reason to carry a photograph.
const MAX_LOGO_BYTES = 512 * 1024;

function register({ handle, getWindow }) {
    /* ---------------- External links ---------------- */

    // Terminal output is whatever the far end chose to send, and a link in it
    // is a click target the user did not author. So the scheme is allowlisted
    // rather than filtered: `file:` would open a local path, and the
    // shell:/javascript:/ms-msdt: family are handed to the OS to interpret.
    // Only the two schemes a link in a log is ever meant to be get through.
    handle('open-external', async (event, url) => {
        let parsed;
        try {
            parsed = new URL(String(url));
        } catch {
            return { success: false, message: 'Not a valid URL' };
        }

        if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') {
            return {
                success: false,
                message: `Refusing to open a ${parsed.protocol.replace(':', '')} link`,
            };
        }

        // `href` rather than the original string: it is the parsed form, so
        // nothing that survived parsing but was not part of the URL goes on
        // to the shell.
        await shell.openExternal(parsed.href);
        return { success: true };
    });

    /* ---------------- Appearance ---------------- */

    /**
     * Pick an image for the title bar and hand it back as a data URL.
     *
     * Read here rather than in the renderer: it has no filesystem, and the type
     * and size checks belong on the side doing the reading. Only the bytes of a
     * file the user just chose in a native dialog ever cross the bridge, so
     * there is no path for the page to name a file of its own.
     */
    handle('choose-logo-image', async () => {
        const { canceled, filePaths } = await dialog.showOpenDialog(getWindow(), {
            title: 'Choose a logo',
            properties: ['openFile'],
            filters: [{ name: 'Images', extensions: Object.keys(LOGO_TYPES).map(ext => ext.slice(1)) }],
        });

        const filePath = filePaths?.[0];
        if (canceled || !filePath) return { success: false, canceled: true };

        const type = LOGO_TYPES[path.extname(filePath).toLowerCase()];
        if (!type) return { success: false, message: 'That file is not an image the title bar can draw' };

        try {
            const { size } = await fs.promises.stat(filePath);
            if (size > MAX_LOGO_BYTES) {
                return {
                    success: false,
                    message: `That image is ${Math.round(size / 1024)} KB. The limit is `
                        + `${MAX_LOGO_BYTES / 1024} KB, because the mark is drawn 24 pixels square `
                        + 'and travels with your settings.',
                };
            }

            const bytes = await fs.promises.readFile(filePath);
            return {
                success: true,
                dataUrl: `data:${type};base64,${bytes.toString('base64')}`,
                name: path.basename(filePath),
            };
        } catch (error) {
            return { success: false, message: error.message };
        }
    });

    /* ---------------- Dialogs ---------------- */

    handle('show-save-dialog', (event, { defaultPath, filters, title }) =>
        dialog.showSaveDialog(getWindow(), {
            defaultPath,
            title,
            filters: filters || [{ name: 'All Files', extensions: ['*'] }],
        }));

    handle('show-open-dialog', (event, { properties, filters, defaultPath, title }) =>
        dialog.showOpenDialog(getWindow(), {
            properties: properties || ['openFile'],
            defaultPath,
            title,
            // A directory picker with file filters shows an empty list on Windows.
            filters: properties?.includes('openDirectory')
                ? undefined
                : filters || [{ name: 'All Files', extensions: ['*'] }],
        }));

    /* ---------------- Clipboard ---------------- */

    // The terminal needs clipboard access for copy/paste. Routed through main
    // rather than navigator.clipboard so it works in the sandboxed renderer
    // without a permission prompt.
    handle('clipboard-read-text', () => clipboard.readText());
    handle('clipboard-write-text', (event, text) => {
        clipboard.writeText(typeof text === 'string' ? text : '');
        return true;
    });

    /* ---------------- Screenshots ---------------- */

    handle('screenshot-capture', (event, options) =>
        screenshot.capture(getWindow(), options));
    handle('screenshot-get', (event, id) => screenshot.get(id));
    handle('screenshot-copy', (event, id) => screenshot.copy(id));
    handle('screenshot-save', (event, id) => screenshot.save(id));
    handle('screenshot-reveal', (event, filePath) => screenshot.reveal(filePath));
    handle('screenshot-close', (event) => screenshot.closeViewer(event.sender));

    /* ---------------- Startup ---------------- */

    // Read from the system on every call rather than cached, because the user
    // can turn this off somewhere that is not this app.
    handle('startup-status', () => startup.status());
    handle('startup-set-enabled', (event, enabled) => startup.setEnabled(enabled));

    /* ---------------- Window ----------------
     *
     * Raw ipcMain.on rather than the locked `handle` wrapper: a locked window
     * still needs to minimise, close and be quit like any other.
     */

    ipcMain.on('window-minimize', () => getWindow()?.minimize());
    ipcMain.on('window-maximize', () => {
        const window = getWindow();
        if (!window) return;
        if (window.isMaximized()) window.unmaximize();
        else window.maximize();
    });
    ipcMain.on('window-close', () => getWindow()?.close());
    ipcMain.on('open-devtools', () => getWindow()?.webContents.toggleDevTools());
    ipcMain.on('reload-window', () => getWindow()?.reload());
    ipcMain.on('force-quit', () => app.quit());
}

module.exports = { register };
