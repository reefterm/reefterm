/**
 * What a plugin may add to the app's own interface, and the shape each
 * contribution has to match - same named/described-catalog pattern as
 * capabilities.js, but validating a *description of UI* instead of handing
 * back a result, which trusted renderer code then renders (see
 * src/renderer/lib/plugin-ui.jsx). A plugin never ships a pixel, only a
 * small object from this fixed vocabulary of node types.
 *
 * A separate catalog from capabilities.js because the risk is different in
 * kind: a capability is something a plugin *does*, worth its own consent
 * line; a UI contribution can only ever be seen and can only ever *act*
 * through onAction, which names a handler the plugin registered on itself
 * (see host-runtime.js), never a capability or a raw function - so it gets
 * its own section in the consent screen rather than the capability list
 * (see PluginConsentDialog.jsx).
 */

/** name -> { description, accepts: Set<nodeType> } */
const POINTS = new Map();

function define(name, { description, accepts }) {
    POINTS.set(name, { description, accepts: new Set(accepts) });
}

define('pane.headerAction', {
    description: 'A button in the terminal pane header toolbar',
    accepts: ['button'],
});

define('host.contextMenuItem', {
    description: "An entry in a host's right-click menu",
    accepts: ['menuItem'],
});

define('statusBar.tile', {
    description: 'A stat tile in the status bar at the bottom of the SSH session',
    accepts: ['tile'],
});

define('hosts.externalHost', {
    description: "A host of the plugin's own, shown in a labelled group of its own on the Hosts screen "
        + '(never mixed into your saved hosts) and dialled the same way a typed address is',
    accepts: ['host'],
});

/** Non-empty string, no control characters, under a sane display length. */
function isLabel(value, maxLength = 60) {
    return typeof value === 'string' && value.length > 0 && value.length <= maxLength;
}

const TONES = new Set(['default', 'warning', 'critical']);

/** icon/tone are optional on every tooltip row, so every row shape checks them the same way. */
function validateRowCommon(row) {
    if (row.icon !== undefined && typeof row.icon !== 'string') return '"icon" must be a string';
    if (row.tone !== undefined && !TONES.has(row.tone)) return `"tone" must be one of ${[...TONES].join(', ')}`;
    return '';
}

/** tooltip row type -> (row) => error string, or ''. */
const TOOLTIP_ROW_SHAPES = {
    text(row) {
        if (!isLabel(row.label)) return '"label" must be a non-empty string (60 chars or fewer)';
        if (!['string', 'number'].includes(typeof row.value)) return '"value" must be a string or number';
        return validateRowCommon(row);
    },
    bar(row) {
        if (!isLabel(row.label)) return '"label" must be a non-empty string (60 chars or fewer)';
        if (!['string', 'number'].includes(typeof row.value)) return '"value" must be a string or number';
        if (typeof row.percent !== 'number' || Number.isNaN(row.percent) || row.percent < 0 || row.percent > 100) {
            return '"percent" must be a number between 0 and 100';
        }
        return validateRowCommon(row);
    },
    // No onAction of its own: the value only ever goes to the clipboard.
    copy(row) {
        if (!isLabel(row.label)) return '"label" must be a non-empty string (60 chars or fewer)';
        if (typeof row.value !== 'string' || !row.value) return '"value" must be a non-empty string to copy';
        return validateRowCommon(row);
    },
    // Exactly one of url (opens externally, https only) or onAction (the
    // plugin's own registered handler) - the same two doors call()/contribute()
    // already have, not a third invented for tooltips.
    cta(row) {
        if (!isLabel(row.label)) return '"label" must be a non-empty string (60 chars or fewer)';
        const hasUrl = row.url !== undefined;
        const hasAction = row.onAction !== undefined;
        if (hasUrl === hasAction) return 'a "cta" row needs exactly one of "url" or "onAction"';
        if (hasUrl && !/^https:\/\//.test(row.url)) return '"url" must start with https://';
        if (hasAction && !isLabel(row.onAction, 200)) return '"onAction" must be a non-empty action id';
        return validateRowCommon(row);
    },
};

/** Generous enough for "top 5 hungriest containers", not enough for a plugin to dump a log into a bubble. */
const MAX_TOOLTIP_ROWS = 12;

function validateTooltip(tooltip) {
    if (!tooltip || typeof tooltip !== 'object') return '"tooltip" must be an object';
    if (tooltip.title !== undefined && !isLabel(tooltip.title, 60)) {
        return 'tooltip "title" must be a non-empty string (60 chars or fewer)';
    }
    if (tooltip.icon !== undefined && typeof tooltip.icon !== 'string') return 'tooltip "icon" must be a string';
    if (!Array.isArray(tooltip.rows) || tooltip.rows.length === 0) return 'tooltip "rows" must be a non-empty array';
    if (tooltip.rows.length > MAX_TOOLTIP_ROWS) return `tooltip "rows" supports at most ${MAX_TOOLTIP_ROWS} rows`;

    for (const row of tooltip.rows) {
        if (!row || typeof row !== 'object') return 'each tooltip row must be an object';
        const checkRow = TOOLTIP_ROW_SHAPES[row.type];
        if (!checkRow) return `tooltip row type "${row.type}" is not supported`;
        const error = checkRow(row);
        if (error) return `tooltip row (${row.type}): ${error}`;
    }
    return '';
}

/** node type -> (node) => error string, or '' if the node is valid. */
const NODE_SHAPES = {
    button(node) {
        if (!isLabel(node.label)) return '"label" must be a non-empty string (60 chars or fewer)';
        if (node.icon !== undefined && typeof node.icon !== 'string') return '"icon" must be a string';
        if (node.badge !== undefined && !['string', 'number'].includes(typeof node.badge)) {
            return '"badge" must be a string or number';
        }
        if (!isLabel(node.onAction, 200)) return '"onAction" must name a non-empty action id';
        return '';
    },
    menuItem(node) {
        if (!isLabel(node.label)) return '"label" must be a non-empty string (60 chars or fewer)';
        if (node.icon !== undefined && typeof node.icon !== 'string') return '"icon" must be a string';
        if (node.danger !== undefined && typeof node.danger !== 'boolean') return '"danger" must be a boolean';
        if (!isLabel(node.onAction, 200)) return '"onAction" must name a non-empty action id';
        return '';
    },
    // No required onAction, unlike button/menuItem: a tile is a readout
    // first, and only optionally something you can also click through from.
    tile(node) {
        if (!isLabel(node.label, 30)) return '"label" must be a non-empty string (30 chars or fewer)';
        if (!['string', 'number'].includes(typeof node.value)) return '"value" must be a string or number';
        if (node.unit !== undefined && !isLabel(node.unit, 12)) return '"unit" must be a non-empty string (12 chars or fewer)';
        if (node.icon !== undefined && typeof node.icon !== 'string') return '"icon" must be a string';
        if (node.onAction !== undefined && !isLabel(node.onAction, 200)) return '"onAction" must be a non-empty action id';
        if (node.tooltip !== undefined) return validateTooltip(node.tooltip);
        return '';
    },
    // No onAction: unlike a button or a menu item, clicking one of these always
    // does exactly one thing (dial it, the same way a typed address is dialled)
    // rather than something the plugin gets to define. And no password, key or
    // any other credential field exists on this shape at all - connecting one
    // asks the user the same way an address typed into the picker does.
    host(node) {
        if (!isLabel(node.label)) return '"label" must be a non-empty string (60 chars or fewer)';
        if (typeof node.host !== 'string' || !node.host.trim()) return '"host" must be a non-empty string';
        if (node.port !== undefined && (!Number.isInteger(node.port) || node.port < 1 || node.port > 65535)) {
            return '"port" must be an integer between 1 and 65535';
        }
        if (node.username !== undefined && typeof node.username !== 'string') return '"username" must be a string';
        if (node.icon !== undefined && typeof node.icon !== 'string') return '"icon" must be a string';
        if (node.tags !== undefined && !(Array.isArray(node.tags) && node.tags.every(tag => typeof tag === 'string'))) {
            return '"tags" must be an array of strings';
        }
        return '';
    },
};

function has(name) {
    return POINTS.has(name);
}

function describe(name) {
    return POINTS.get(name)?.description || '';
}

/** Every extension point a plugin could target, for a consent screen or a manifest validator. */
function list() {
    return [...POINTS.entries()].map(([name, { description }]) => ({ name, description }));
}

/**
 * Validates one contributed node against the point it was contributed to.
 * Returns '' if valid, or a human-readable reason it was rejected -
 * never throws, so one malformed contribution cannot take a plugin's
 * process down (see host.js, which is what actually calls this).
 */
function validateNode(pointName, node) {
    const point = POINTS.get(pointName);
    if (!point) return `"${pointName}" is not a known extension point`;
    if (!node || typeof node !== 'object') return 'a contribution must be an object';
    if (!point.accepts.has(node.type)) {
        return `"${pointName}" accepts ${[...point.accepts].join(', ')}, not "${node.type}"`;
    }
    const checkShape = NODE_SHAPES[node.type];
    return checkShape ? checkShape(node) : `"${node.type}" has no known shape`;
}

module.exports = { has, describe, list, validateNode };
