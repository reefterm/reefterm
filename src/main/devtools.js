const fs = require('fs');
const path = require('path');
const { app } = require('electron');

/** Empty marker file in userData; its mere existence turns DevTools on. */
const FLAG_FILE = 'devtools.enabled';

/**
 * Whether DevTools are reachable this run: always in an unpackaged (dev)
 * build, and in a packaged one only if the flag file is present. A packaged
 * build ships to people who aren't the developer, so DevTools access there
 * is opt-in rather than a menu item everyone gets by default.
 */
function isAvailable() {
    if (!app.isPackaged) return true;
    try {
        return fs.existsSync(path.join(app.getPath('userData'), FLAG_FILE));
    } catch {
        return false;
    }
}

module.exports = { isAvailable, FLAG_FILE };
