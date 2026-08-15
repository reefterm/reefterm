const fs = require('fs');
const path = require('path');
const manifest = require('./manifest');
const capabilities = require('./capabilities');
const uiExtensions = require('./ui-extensions');

/**
 * Scans a plugins directory and reports what it found, one entry per
 * subdirectory - valid or not, so one malformed plugin never hides the rest
 * of a person's install from the app or from a settings page trying to list
 * them. Pure reading (plus `manifest.ensureStructure`'s directory creation
 * for anything that turns out valid): nothing here decides what runs or
 * what is granted - see manager.js for the stateful half of this.
 */
function scan(pluginsRoot) {
    let entries;
    try {
        entries = fs.readdirSync(pluginsRoot, { withFileTypes: true });
    } catch (error) {
        if (error.code === 'ENOENT') return [];
        throw error;
    }

    const found = [];
    for (const entry of entries) {
        if (!entry.isDirectory()) continue;
        const dir = path.join(pluginsRoot, entry.name);
        const result = manifest.readManifest(dir);

        if (!result.ok) {
            found.push({ id: entry.name, dir, ok: false, error: result.error });
            continue;
        }

        const unknownCapability = result.manifest.capabilities.find(name => !capabilities.has(name));
        if (unknownCapability) {
            found.push({
                id: result.manifest.id,
                dir,
                ok: false,
                error: `Requests an unknown capability "${unknownCapability}"`,
            });
            continue;
        }

        const badExtension = result.manifest.uiExtensions.find(({ point }) => !uiExtensions.has(point));
        if (badExtension) {
            found.push({
                id: result.manifest.id,
                dir,
                ok: false,
                error: `Targets an unknown extension point "${badExtension.point}"`,
            });
            continue;
        }
        const badSample = result.manifest.uiExtensions
            .filter(({ sample }) => sample)
            .map(({ point, sample }) => ({ point, error: uiExtensions.validateNode(point, sample) }))
            .find(({ error }) => error);
        if (badSample) {
            found.push({
                id: result.manifest.id,
                dir,
                ok: false,
                error: `Invalid sample for extension point "${badSample.point}": ${badSample.error}`,
            });
            continue;
        }

        manifest.ensureStructure(dir);
        found.push({ id: result.manifest.id, dir, ok: true, manifest: result.manifest });
    }

    return found;
}

module.exports = { scan };
