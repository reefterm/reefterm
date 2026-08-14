const fs = require('fs');
const path = require('path');
const { createPluginHost } = require('./host');
const capabilitiesCatalog = require('./capabilities');
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
        return grantState[id] || { granted: [], enabled: true };
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
                grantState[entry.id] = { granted: [], enabled: true };
                changed = true;
            }
        }
        if (changed) persistGrants();

        return list();
    }

    function describeEntry(entry) {
        const base = { id: entry.id };
        if (!entry.ok) {
            return { ...base, state: 'invalid', error: entry.error, name: entry.id, capabilities: [] };
        }

        const { manifest } = entry;
        const grant = grantFor(entry.id);
        const pending = grants.pendingCapabilities(grant.granted, manifest.capabilities);
        const capabilities = manifest.capabilities.map(name => ({
            name,
            description: capabilitiesCatalog.describe(name),
            granted: !pending.includes(name),
        }));

        const shared = {
            ...base,
            name: manifest.name,
            description: manifest.description,
            version: manifest.version,
            capabilities,
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
        if (grants.pendingCapabilities(grant.granted, entry.manifest.capabilities).length > 0) return;
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

    return {
        setNotifier,
        init,
        rescan,
        list,
        respondToConsent,
        setEnabled,
        shutdown,
    };
}

module.exports = { createPluginManager };
