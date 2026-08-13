const importer = require('../import');
const activity = require('../activity');

function register({ handle }) {
    /* ---------------- Import from other apps ---------------- */

    handle('import-paths', () => importer.defaultPaths());
    handle('import-detect', () => importer.detect());
    handle('import-scan', (event, options) => importer.scan(options || {}));
    // Only the selections cross the bridge; the files (or the registry) are
    // re-read here, so no host key or private key is ever taken on the
    // renderer's word.
    handle('import-apply', (event, options) => {
        const result = importer.apply(options || {});
        const sourceLabels = { putty: 'PuTTY', kitty: 'KiTTY', mobaxterm: 'MobaXterm' };
        activity.record({
            category: 'data',
            action: 'import.apply',
            outcome: result?.success === false ? 'failure' : 'success',
            target: sourceLabels[options?.source] || 'OpenSSH config',
            // The per-host saves are already logged one by one by the store;
            // this is the line that says the batch happened at all.
            detail: [
                result?.hosts?.imported ? `${result.hosts.imported} host(s)` : '',
                result?.keys?.imported ? `${result.keys.imported} key(s)` : '',
                result?.knownHosts?.imported ? `${result.knownHosts.imported} known host(s)` : '',
                result?.folders?.created ? `${result.folders.created} folder(s)` : '',
                // Which hosts are now relayed through a bastion is a routing
                // change, not a count of records, so it is named separately.
                result?.hosts?.relayed ? `${result.hosts.relayed} linked to a jump host` : '',
            ].filter(Boolean).join(' · ') || 'Nothing imported',
            message: result?.notes?.join('; ') || '',
        });
        return result;
    });
}

module.exports = { register };
