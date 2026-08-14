const { app } = require('electron');
const path = require('path');
const { createPluginManager } = require('./manager');

/**
 * The one real plugin manager the running app uses. manager.js itself is
 * deliberately electron-free (see its own header) so it can be unit tested
 * without a window; this is the thin, untested-on-purpose wiring that hands
 * it real, `app.getPath`-backed paths.
 */
module.exports = createPluginManager({
    pluginsRoot: path.join(app.getPath('userData'), 'plugins'),
    grantsFile: path.join(app.getPath('userData'), 'plugins.json'),
});
