const plugins = require('../plugins');

function register({ handle }) {
    handle('plugins-list', () => plugins.list());
    handle('plugins-rescan', () => plugins.rescan());
    handle('plugins-respond-consent', (event, { id, approved }) => plugins.respondToConsent(id, { approved }));
    handle('plugins-set-enabled', (event, { id, enabled }) => plugins.setEnabled(id, enabled));
}

module.exports = { register };
