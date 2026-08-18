/**
 * Exercises plugins/ui-extensions.js: the catalog of what a plugin may add
 * to the app's own interface, and the shape validator every contribution
 * (see plugin-host.test.js's "UI contributions" suite) and every manifest
 * sample (see plugin-discover.test.js) is checked against.
 */
const assert = require('assert');
const { describe, test } = require('node:test');
const uiExtensions = require('../src/main/plugins/ui-extensions');

describe('ui-extensions: the catalog', () => {
    test('pane.headerAction and host.contextMenuItem are registered with descriptions', () => {
        assert.strictEqual(uiExtensions.has('pane.headerAction'), true);
        assert.match(uiExtensions.describe('pane.headerAction'), /pane header toolbar/);
        assert.strictEqual(uiExtensions.has('host.contextMenuItem'), true);
        assert.match(uiExtensions.describe('host.contextMenuItem'), /right-click menu/);
    });

    test('statusBar.tile is registered with a description', () => {
        assert.strictEqual(uiExtensions.has('statusBar.tile'), true);
        assert.match(uiExtensions.describe('statusBar.tile'), /status bar/);
    });

    test('hosts.externalHost is registered with a description', () => {
        assert.strictEqual(uiExtensions.has('hosts.externalHost'), true);
        assert.match(uiExtensions.describe('hosts.externalHost'), /never mixed into your saved hosts/);
    });

    test('an unknown point is not in the catalog', () => {
        assert.strictEqual(uiExtensions.has('does.not.exist'), false);
        assert.strictEqual(uiExtensions.describe('does.not.exist'), '');
    });

    test('list() enumerates every registered point', () => {
        const names = uiExtensions.list().map(entry => entry.name);
        assert.ok(names.includes('pane.headerAction'));
        assert.ok(names.includes('host.contextMenuItem'));
    });
});

describe('ui-extensions: validateNode', () => {
    test('a well-formed button for pane.headerAction is valid', () => {
        const error = uiExtensions.validateNode('pane.headerAction', {
            type: 'button', label: 'Containers', icon: 'box', badge: 3, onAction: 'show',
        });
        assert.strictEqual(error, '');
    });

    test('a well-formed menuItem for host.contextMenuItem is valid', () => {
        const error = uiExtensions.validateNode('host.contextMenuItem', {
            type: 'menuItem', label: 'Deploy to host', danger: false, onAction: 'deploy',
        });
        assert.strictEqual(error, '');
    });

    test('an unknown point is refused, naming it', () => {
        const error = uiExtensions.validateNode('does.not.exist', { type: 'button', label: 'x', onAction: 'x' });
        assert.match(error, /not a known extension point/);
    });

    test('a node type the point does not accept is refused', () => {
        const error = uiExtensions.validateNode('pane.headerAction', { type: 'menuItem', label: 'x', onAction: 'x' });
        assert.match(error, /accepts button, not "menuItem"/);
    });

    test('a missing label is refused', () => {
        const error = uiExtensions.validateNode('pane.headerAction', { type: 'button', onAction: 'x' });
        assert.match(error, /"label"/);
    });

    test('a missing onAction is refused', () => {
        const error = uiExtensions.validateNode('pane.headerAction', { type: 'button', label: 'x' });
        assert.match(error, /"onAction"/);
    });

    test('a non-string, non-number badge is refused', () => {
        const error = uiExtensions.validateNode('pane.headerAction', {
            type: 'button', label: 'x', onAction: 'x', badge: {},
        });
        assert.match(error, /"badge"/);
    });

    test('a non-boolean danger flag is refused', () => {
        const error = uiExtensions.validateNode('host.contextMenuItem', {
            type: 'menuItem', label: 'x', onAction: 'x', danger: 'yes',
        });
        assert.match(error, /"danger"/);
    });

    test('not an object at all is refused rather than throwing', () => {
        assert.match(uiExtensions.validateNode('pane.headerAction', null), /must be an object/);
        assert.match(uiExtensions.validateNode('pane.headerAction', 'nope'), /must be an object/);
    });

    test('a well-formed tile for statusBar.tile is valid, with or without onAction', () => {
        assert.strictEqual(uiExtensions.validateNode('statusBar.tile', {
            type: 'tile', label: 'Hosts', value: 3, icon: 'server',
        }), '');
        assert.strictEqual(uiExtensions.validateNode('statusBar.tile', {
            type: 'tile', label: 'CPU', value: 42, unit: '%', onAction: 'showDetail',
        }), '');
    });

    test('a tile needs a label and a string-or-number value', () => {
        assert.match(uiExtensions.validateNode('statusBar.tile', { type: 'tile', value: 3 }), /"label"/);
        assert.match(uiExtensions.validateNode('statusBar.tile', { type: 'tile', label: 'Hosts', value: {} }), /"value"/);
    });

    test('a tile\'s onAction, when present, must be a non-empty string', () => {
        const error = uiExtensions.validateNode('statusBar.tile', {
            type: 'tile', label: 'Hosts', value: 3, onAction: '',
        });
        assert.match(error, /"onAction"/);
    });

    test('a well-formed host for hosts.externalHost is valid, with or without optional fields', () => {
        assert.strictEqual(uiExtensions.validateNode('hosts.externalHost', {
            type: 'host', label: 'db-1', host: '10.0.0.5',
        }), '');
        assert.strictEqual(uiExtensions.validateNode('hosts.externalHost', {
            type: 'host', label: 'db-1', host: '10.0.0.5', port: 2222, username: 'deploy',
            icon: 'server', tags: ['warpgate', 'prod'],
        }), '');
    });

    test('a host needs a label and a non-empty host string', () => {
        assert.match(uiExtensions.validateNode('hosts.externalHost', { type: 'host', host: '10.0.0.5' }), /"label"/);
        assert.match(uiExtensions.validateNode('hosts.externalHost', { type: 'host', label: 'db-1' }), /"host"/);
        assert.match(uiExtensions.validateNode('hosts.externalHost', { type: 'host', label: 'db-1', host: '  ' }), /"host"/);
    });

    test('a host\'s port, when present, must be an integer in range', () => {
        assert.match(uiExtensions.validateNode('hosts.externalHost', {
            type: 'host', label: 'db-1', host: '10.0.0.5', port: 0,
        }), /"port"/);
        assert.match(uiExtensions.validateNode('hosts.externalHost', {
            type: 'host', label: 'db-1', host: '10.0.0.5', port: 99999,
        }), /"port"/);
        assert.match(uiExtensions.validateNode('hosts.externalHost', {
            type: 'host', label: 'db-1', host: '10.0.0.5', port: '22',
        }), /"port"/);
    });

    test('a host has no onAction of its own - connecting it is not something a plugin defines', () => {
        const error = uiExtensions.validateNode('hosts.externalHost', {
            type: 'host', label: 'db-1', host: '10.0.0.5', onAction: 'somethingElse',
        });
        // Unknown extra fields are simply not read by the shape check, the
        // same as every other node type - it is the renderer that never looks
        // for onAction on this node, not this validator refusing the field.
        assert.strictEqual(error, '');
    });

    test('a host\'s tags, when present, must be an array of strings', () => {
        const error = uiExtensions.validateNode('hosts.externalHost', {
            type: 'host', label: 'db-1', host: '10.0.0.5', tags: ['prod', 3],
        });
        assert.match(error, /"tags"/);
    });
});

describe('ui-extensions: tile tooltip rows', () => {
    function tileWithTooltip(tooltip) {
        return { type: 'tile', label: 'Docker', value: 3, tooltip };
    }

    test('a well-formed tooltip with one of each row type is valid', () => {
        const error = uiExtensions.validateNode('statusBar.tile', tileWithTooltip({
            title: 'Containers',
            rows: [
                { type: 'text', label: 'Status', value: 'healthy' },
                { type: 'bar', label: 'nginx', value: '82%', percent: 82, tone: 'warning' },
                { type: 'copy', label: 'Container ID', value: 'a1b2c3' },
                { type: 'cta', label: 'Open dashboard', url: 'https://example.com' },
                { type: 'cta', label: 'Restart', onAction: 'restart' },
            ],
        }));
        assert.strictEqual(error, '');
    });

    test('tooltip requires a non-empty rows array', () => {
        assert.match(uiExtensions.validateNode('statusBar.tile', tileWithTooltip({ rows: [] })), /non-empty array/);
        assert.match(uiExtensions.validateNode('statusBar.tile', tileWithTooltip({})), /non-empty array/);
    });

    test('tooltip rejects more than 12 rows', () => {
        const rows = Array.from({ length: 13 }, (_, i) => ({ type: 'text', label: `row${i}`, value: i }));
        assert.match(uiExtensions.validateNode('statusBar.tile', tileWithTooltip({ rows })), /at most 12 rows/);
    });

    test('an unsupported row type is refused, naming it', () => {
        const error = uiExtensions.validateNode('statusBar.tile', tileWithTooltip({
            rows: [{ type: 'codeblock', label: 'x' }],
        }));
        assert.match(error, /row type "codeblock" is not supported/);
    });

    test('a bar row needs percent between 0 and 100', () => {
        const tooBig = uiExtensions.validateNode('statusBar.tile', tileWithTooltip({
            rows: [{ type: 'bar', label: 'x', value: '120%', percent: 120 }],
        }));
        assert.match(tooBig, /"percent"/);

        const notNumber = uiExtensions.validateNode('statusBar.tile', tileWithTooltip({
            rows: [{ type: 'bar', label: 'x', value: '1', percent: '50' }],
        }));
        assert.match(notNumber, /"percent"/);
    });

    test('a copy row needs a non-empty string value', () => {
        const error = uiExtensions.validateNode('statusBar.tile', tileWithTooltip({
            rows: [{ type: 'copy', label: 'ID', value: 42 }],
        }));
        assert.match(error, /"value"/);
    });

    test('a cta row needs exactly one of url or onAction, never both or neither', () => {
        const neither = uiExtensions.validateNode('statusBar.tile', tileWithTooltip({
            rows: [{ type: 'cta', label: 'x' }],
        }));
        assert.match(neither, /exactly one of "url" or "onAction"/);

        const both = uiExtensions.validateNode('statusBar.tile', tileWithTooltip({
            rows: [{ type: 'cta', label: 'x', url: 'https://example.com', onAction: 'go' }],
        }));
        assert.match(both, /exactly one of "url" or "onAction"/);
    });

    test('a cta row\'s url must be https, not http or any other scheme', () => {
        const error = uiExtensions.validateNode('statusBar.tile', tileWithTooltip({
            rows: [{ type: 'cta', label: 'x', url: 'http://example.com' }],
        }));
        assert.match(error, /"url" must start with https/);

        const jsUrl = uiExtensions.validateNode('statusBar.tile', tileWithTooltip({
            rows: [{ type: 'cta', label: 'x', url: 'javascript:alert(1)' }],
        }));
        assert.match(jsUrl, /"url" must start with https/);
    });

    test('an invalid tone on any row is refused', () => {
        const error = uiExtensions.validateNode('statusBar.tile', tileWithTooltip({
            rows: [{ type: 'text', label: 'x', value: 1, tone: 'rainbow' }],
        }));
        assert.match(error, /"tone" must be one of/);
    });
});
