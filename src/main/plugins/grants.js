const fs = require('fs');
const path = require('path');

/**
 * What has actually been approved for each plugin, and the one question
 * that decides whether a plugin runs without asking again: are all of its
 * *currently requested* capabilities already among the ones it was granted.
 *
 * Deliberately not gated on the manifest's version number - that trusts the
 * plugin author to bump it honestly every time a request grows, and the
 * cost of getting that wrong is silent privilege escalation. Diffing the
 * actual capability lists is the same check regardless of what a plugin
 * claims about itself.
 *
 * Pure functions operating on a file path handed in by the caller (see
 * plugins/manager.js, which owns *when* this is read and written); no
 * electron dependency, no module-level state, so this is straightforward to
 * test and to reason about on its own.
 */

/** id -> { granted: string[], enabled: boolean } */
function load(filePath) {
    try {
        const raw = JSON.parse(fs.readFileSync(filePath, 'utf8'));
        return raw && typeof raw === 'object' && !Array.isArray(raw) ? raw : {};
    } catch {
        return {}; // First run, or an unreadable/corrupt file. Nothing is granted yet.
    }
}

/**
 * Atomic, so a crash mid-write leaves either the old file or the new one,
 * never a truncated one a later `load()` would have to fall back from.
 */
function save(filePath, grants) {
    const tmp = `${filePath}.${process.pid}.tmp`;
    fs.mkdirSync(path.dirname(filePath), { recursive: true });
    const fd = fs.openSync(tmp, 'w');
    try {
        fs.writeFileSync(fd, JSON.stringify(grants, null, 2), 'utf8');
        fs.fsyncSync(fd);
    } finally {
        fs.closeSync(fd);
    }
    fs.renameSync(tmp, filePath);
}

/** Which of `requested` are not already in `granted`. Empty means nothing more to ask for. */
function pendingCapabilities(granted, requested) {
    const grantedSet = new Set(granted || []);
    return (requested || []).filter(name => !grantedSet.has(name));
}

module.exports = { load, save, pendingCapabilities };
