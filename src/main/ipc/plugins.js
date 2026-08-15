const plugins = require('../plugins');

function register({ handle }) {
    handle('plugins-list', () => plugins.list());
    handle('plugins-rescan', () => plugins.rescan());
    handle('plugins-respond-consent', (event, { id, approved }) => plugins.respondToConsent(id, { approved }));
    handle('plugins-set-enabled', (event, { id, enabled }) => plugins.setEnabled(id, enabled));
    handle('plugins-list-builtins', () => plugins.builtins.list());
    handle('plugins-set-builtin-enabled', (event, { id, enabled }) => plugins.builtins.setEnabled(id, enabled));

    handle('plugins-list-contributions', () => plugins.listContributions());
    handle('plugins-invoke-action', (event, { id, actionId, args }) => plugins.invokeAction(id, actionId, args));
}

module.exports = { register };
