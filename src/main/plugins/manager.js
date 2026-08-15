const fs = require('fs');
const path = require('path');
const { createPluginHost } = require('./host');
const capabilitiesCatalog = require('./capabilities');
const uiExtensionsCatalog = require('./ui-extensions');
const discover = require('./discover');
const grants = require('./grants');

/**
 * Ties discovery, persisted consent and the sandboxed host together into
 * the thing a settings page and an IPC layer actually want: a list of
 * plugins with a state each, a way to answer a consent request, and a way
 * to turn one off without revoking what it was already granted.
 *
 * Electron-free by construction - `pluginsRoot` and `grantsFile` are handed
 * in by the caller (see plugins/index.js for the real, `app.getPath`-backed
 * instance) - so this and its tests never need to stub anything to do with
 * a window, only whatever `capabilities.js` itself pulls in through the
 * real store.
 */

/** Every state list()/describeEntry() can report, in the order they are checked. */
function createPluginManager({ pluginsRoot, grantsFile }) {
    const pluginHost = createPluginHost();
    capabilitiesCatalog.registerAll(pluginHost);

    /** id -> discover.js's entry for it (the last rescan()'s results). */
    let discovered = new Map();
    /** id -> { granted: string[], enabled: boolean }, persisted to grantsFile. */
    let grantState = grants.load(grantsFile);

    let notify = () => {};
    function setNotifier(fn) {
        notify = fn;
    }

    pluginHost.setNotifier((event, payload) => {
        if (event === 'plugin-log') appendLog(payload);
        notify(event, payload);
    });

    /**
     * The predictable half of "predictable path for logs": every plugin's
     * stdout/stderr, already captured by host.js, lands in its own
     * <pluginDir>/logs/plugin.log rather than a plugin needing filesystem
     * access (which it does not have) to write its own.
     */
    function appendLog({ id, stream, text }) {
        const entry = discovered.get(id);
        if (!entry?.ok) return;
        const line = `[${new Date().toISOString()}] [${stream}] ${text}`;
        try {
            fs.appendFileSync(path.join(entry.dir, 'logs', 'plugin.log'), line.endsWith('\n') ? line : `${line}\n`);
        } catch (error) {
            console.error(`Could not write the log for plugin "${id}":`, error.message);
        }
    }

    function persistGrants() {
        grants.save(grantsFile, grantState);
    }

    function grantFor(id) {
        return grantState[id] || { granted: [], grantedExtensions: [], enabled: true };
    }

    /**
     * What was actually approved for one uiExtensions entry - point *and*
     * sample together, so a plugin quietly reshaping an already-granted
     * point (a plain tile growing a tooltip with CTA rows, say) needs fresh
     * consent, not just a new point appearing.
     */
    function extensionIdentity({ point, sample }) {
        return `${point}::${JSON.stringify(sample || null)}`;
    }

    /**
     * What this plugin still needs consent for. The one implementation both
     * describeEntry() and ensureRunning() call, so what a settings page
     * shows and what actually gates the process starting can never disagree
     * - they used to, when ensureRunning() checked capabilities only and let
     * a plugin needing nothing but uiExtensions consent run for real while
     * still reporting "pending-consent".
     */
    function pendingConsent(entry, grant) {
        const capabilities = grants.pendingCapabilities(grant.granted, entry.manifest.capabilities);
        const extensions = grants.pendingCapabilities(
            grant.grantedExtensions,
            entry.manifest.uiExtensions.map(extensionIdentity)
        );
        return { capabilities, extensions };
    }

    /** Re-reads the plugins directory. Running plugins are left exactly as they are. */
    function rescan() {
        const found = discover.scan(pluginsRoot);
        discovered = new Map(found.map(entry => [entry.id, entry]));

        // A newly-seen, otherwise-valid plugin gets a grant record so the
        // rest of this module has one consistent place to read state from,
        // rather than every reader handling "not in grantState yet" as a
        // separate case. Nothing is granted by this alone.
        let changed = false;
        for (const entry of discovered.values()) {
            if (entry.ok && !grantState[entry.id]) {
                grantState[entry.id] = { granted: [], grantedExtensions: [], enabled: true };
                changed = true;
            }
        }
        if (changed) persistGrants();

        return list();
    }

    function describeEntry(entry) {
        const base = { id: entry.id };
        if (!entry.ok) {
            return { ...base, state: 'invalid', error: entry.error, name: entry.id, capabilities: [], uiExtensions: [] };
        }

        const { manifest } = entry;
        const grant = grantFor(entry.id);
        const { capabilities: pendingCaps, extensions: pendingExt } = pendingConsent(entry, grant);
        const capabilities = manifest.capabilities.map(name => ({
            name,
            description: capabilitiesCatalog.describe(name),
            granted: !pendingCaps.includes(name),
        }));
        const uiExtensions = manifest.uiExtensions.map(uiEntry => ({
            point: uiEntry.point,
            description: uiExtensionsCatalog.describe(uiEntry.point),
            sample: uiEntry.sample,
            granted: !pendingExt.includes(extensionIdentity(uiEntry)),
        }));

        const pending = [...pendingCaps, ...pendingExt];

        const shared = {
            ...base,
            name: manifest.name,
            description: manifest.description,
            version: manifest.version,
            capabilities,
            uiExtensions,
            // Present whenever something is outstanding, regardless of
            // enabled state: a disabled plugin that would still need to ask
            // for something on re-enabling is worth a settings page saying
            // so, not just a bare "disabled".
            ...(pending.length > 0 ? { pendingCapabilities: pending } : {}),
        };

        // Checked before pending consent, not after: an explicit "no" from
        // respondToConsent() sets enabled false without clearing what is
        // still outstanding, and that has to read as the deliberate,
        // resolved "disabled" a person just chose - not as "still waiting
        // on you", which is what pending-consent means for a plugin nobody
        // has answered yet.
        if (!grant.enabled) {
            return { ...shared, state: 'disabled' };
        }
        if (pending.length > 0) {
            return { ...shared, state: 'pending-consent' };
        }

        const hostState = pluginHost.status(entry.id).state;
        return { ...shared, state: hostState === 'crashed' ? 'crashed' : hostState === 'stopped' ? 'stopped' : 'running' };
    }

    function list() {
        return [...discovered.values()].map(describeEntry);
    }

    /** Starts a plugin if (and only if) it is fully consented, enabled, and not already running. */
    async function ensureRunning(id) {
        const entry = discovered.get(id);
        if (!entry?.ok) return;
        const grant = grantFor(id);
        if (!grant.enabled) return;
        const { capabilities, extensions } = pendingConsent(entry, grant);
        if (capabilities.length > 0 || extensions.length > 0) return;
        if (pluginHost.status(id).state !== 'stopped') return; // starting, ready, or crashed: not ours to start again

        try {
            await pluginHost.start({
                id,
                entryFile: entry.manifest.entryPath,
                capabilities: entry.manifest.capabilities,
            });
        } catch (error) {
            notify('plugin-start-failed', { id, message: error.message });
        }
    }

    async function ensureAllRunning() {
        await Promise.all([...discovered.keys()].map(ensureRunning));
    }

    /**
     * Approving grants exactly what the plugin currently asks for - not an
     * open-ended trust, the specific list shown on the consent screen - and
     * starts it. Denying does not merely leave the prompt unanswered: it
     * turns the plugin off, so declining is a real, remembered decision
     * rather than something that quietly reappears on every restart until
     * acted on. Nothing about a denial is permanent - re-enabling it later
     * asks again for whatever is still outstanding.
     */
    async function respondToConsent(id, { approved }) {
        const entry = discovered.get(id);
        if (!entry?.ok) return { success: false, message: 'That plugin is not known' };

        const grant = grantFor(id);
        if (approved) {
            grant.granted = [...new Set([...grant.granted, ...entry.manifest.capabilities])];
            grant.grantedExtensions = [...new Set([
                ...(grant.grantedExtensions || []),
                ...entry.manifest.uiExtensions.map(extensionIdentity),
            ])];
        } else {
            grant.enabled = false;
        }
        grantState[id] = grant;
        persistGrants();

        if (approved) await ensureRunning(id);
        return { success: true };
    }

    async function setEnabled(id, enabled) {
        if (!discovered.has(id)) return { success: false, message: 'That plugin is not known' };

        const grant = grantFor(id);
        grant.enabled = Boolean(enabled);
        grantState[id] = grant;
        persistGrants();

        if (grant.enabled) await ensureRunning(id);
        else await pluginHost.stop(id);
        return { success: true };
    }

    async function init() {
        fs.mkdirSync(pluginsRoot, { recursive: true });
        rescan();
        await ensureAllRunning();
        return list();
    }

    async function shutdown() {
        await pluginHost.stopAll();
    }

    /**
     * Rejects for a plugin whose contribution wasn't actually granted, even
     * if the id and action name are otherwise valid - the same "checked
     * again" posture as everything else a plugin reaches the app through.
     */
    function invokeAction(id, actionId, args) {
        const grant = grantFor(id);
        if (!grant.enabled) return Promise.reject(new Error(`Plugin "${id}" is disabled`));
        return pluginHost.invokeAction(id, actionId, args);
    }

    return {
        setNotifier,
        init,
        rescan,
        list,
        respondToConsent,
        setEnabled,
        shutdown,
        listContributions: pluginHost.listContributions,
        invokeAction,
    };
}

module.exports = { createPluginManager };
