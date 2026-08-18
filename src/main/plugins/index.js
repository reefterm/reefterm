const { app } = require('electron');
const path = require('path');
const { createPluginManager } = require('./manager');
const { createBuiltinsManager } = require('./builtins');

/**
 * The one real plugin manager the running app uses. manager.js itself is
 * deliberately electron-free (see its own header) so it can be unit tested
 * without a window; this is the thin, untested-on-purpose wiring that hands
 * it real, `app.getPath`-backed paths.
 *
 * `builtins` (plugins/builtins.js) is a separate manager exposed as
 * `plugins.builtins` - note `plugins.setEnabled` and
 * `plugins.builtins.setEnabled` are different methods with different
 * semantics that happen to share a name at different depths.
 */
const manager = createPluginManager({
    pluginsRoot: path.join(app.getPath('userData'), 'plugins'),
    grantsFile: path.join(app.getPath('userData'), 'plugins.json'),
    credentialsFile: path.join(app.getPath('userData'), 'plugin-credentials.json'),
});

const builtins = createBuiltinsManager({
    stateFile: path.join(app.getPath('userData'), 'builtins.json'),
});

module.exports = { ...manager, builtins };
