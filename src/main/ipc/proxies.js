const store = require('../store');
const proxy = require('../proxy');
const activity = require('../activity');
const { describeProxy, nameProxy } = require('../proxy-config');

function register({ handle }) {
    /* ---------------- Store: proxies ----------------
     *
     * Normalised in the store like the snippets above, and for a sharper reason:
     * these records decide where a socket is opened and what credential is handed
     * over on the way, so a malformed one must never reach the client.
     */

    handle('get-proxies', () => store.getProxies());
    handle('save-proxy', (event, record) => store.saveProxy(record));
    handle('delete-proxy', (event, proxyId) => store.deleteProxy(proxyId));
    // Copied in main, where the password is: a copy made by saving the redacted
    // record back would come out unable to authenticate.
    handle('duplicate-proxy', (event, proxyId) => store.duplicateProxy(proxyId));

    /**
     * Check a proxy, saved or still being typed.
     *
     * The draft form is the one that matters: an editor that can only check what
     * is already stored cannot help anyone get the settings right. A password
     * typed into the form travels renderer to main here, which is the same
     * direction, and the same exception, as a keyboard-interactive answer. The
     * store's rule is that secrets never travel the other way.
     */
    handle('proxies-test', async (event, payload = {}) => {
        const { chain, error } = store.resolveTestChain(payload || {});
        if (error) return { success: false, message: error };

        const result = await proxy.test(chain);
        const last = chain[chain.length - 1];

        activity.record({
            category: 'connection',
            action: 'proxy.test',
            outcome: result.success ? 'success' : 'failure',
            target: nameProxy(last),
            subject: describeProxy(last),
            detail: 'Proxy check',
            message: result.success ? '' : (result.message || ''),
        });

        return result;
    });
}

module.exports = { register };
