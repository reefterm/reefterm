/**
 * Snippet records: normalisation, validation, and what a package composes to.
 *
 * `snippet-config.js` has no dependencies, so nothing needs stubbing here.
 */
const path = require('path');
const assert = require('assert');
const { describe, test } = require('node:test');

const {
    normalizeSnippet,
    normalizeSnippets,
    validateSnippet,
    composeSnippet,
    joinSteps,
    placeholdersIn,
    fillPlaceholders,
    MAX_STEPS,
} = require(path.join(__dirname, '..', 'src', 'main', 'snippet-config.js'));

describe('snippet records', () => {
    test('a record written before packages existed is a command', () => {
        const record = normalizeSnippet({ name: 'tail', command: 'tail -f x' });
        assert.strictEqual(record.kind, 'command');
        assert.deepStrictEqual(record.steps, []);
        assert.strictEqual(record.chain, false);
    });

    test('an unrecognised kind falls back to command', () => {
        assert.strictEqual(normalizeSnippet({ name: 'x', kind: 'wat' }).kind, 'command');
    });

    test('a referenced step keeps no inline text of its own', () => {
        const record = normalizeSnippet({
            name: 'deploy', kind: 'package',
            steps: [{ ref: 'snippet-1', command: 'should be dropped' }],
        });
        assert.strictEqual(record.steps[0].ref, 'snippet-1');
        assert.strictEqual(record.steps[0].command, '');
    });

    test('blank steps are dropped', () => {
        const record = normalizeSnippet({
            name: 'p', kind: 'package',
            steps: [{ command: 'real' }, { command: '   ' }, {}, { command: '' }],
        });
        assert.strictEqual(record.steps.length, 1);
        assert.strictEqual(record.steps[0].command, 'real');
    });

    test('steps are capped', () => {
        const many = Array.from({ length: MAX_STEPS + 20 }, (_, i) => ({ command: `c${i}` }));
        assert.strictEqual(normalizeSnippet({ name: 'p', kind: 'package', steps: many }).steps.length, MAX_STEPS);
    });

    test('steps get distinct ids', () => {
        const record = normalizeSnippet({
            name: 'p', kind: 'package',
            steps: [{ command: 'a' }, { command: 'b' }, { command: 'c' }],
        });
        assert.strictEqual(new Set(record.steps.map(s => s.id)).size, 3);
    });

    test('switching a record to a package keeps its old command text', () => {
        const record = normalizeSnippet({
            name: 'p', kind: 'package', command: 'the old text', steps: [{ command: 'a' }],
        });
        assert.strictEqual(record.command, 'the old text');
    });

    test('CRLF is normalised and the trailing newline dropped', () => {
        const record = normalizeSnippet({ name: 'x', command: 'a\r\nb\n\n' });
        assert.strictEqual(record.command, 'a\nb');
    });

    test('a leading space is kept (HISTCONTROL=ignorespace)', () => {
        assert.strictEqual(normalizeSnippet({ name: 'x', command: ' secret-cmd' }).command, ' secret-cmd');
    });
});

describe('validation', () => {
    test('a command needs text', () => {
        assert.ok(validateSnippet({ name: 'x', command: '  ' }));
        assert.strictEqual(validateSnippet({ name: 'x', command: 'ls' }), '');
    });

    test('a package needs at least one step', () => {
        assert.match(validateSnippet({ name: 'x', kind: 'package', steps: [] }), /at least one step/);
        assert.match(
            validateSnippet({ name: 'x', kind: 'package', steps: [{ command: ' ' }] }),
            /at least one step/
        );
    });

    test('a package does not need a command of its own', () => {
        assert.strictEqual(
            validateSnippet({ name: 'x', kind: 'package', command: '', steps: [{ command: 'ls' }] }),
            ''
        );
    });

    test('a package of references alone is valid', () => {
        assert.strictEqual(
            validateSnippet({ name: 'x', kind: 'package', steps: [{ ref: 'snippet-1' }] }),
            ''
        );
    });

    test('every kind needs a name', () => {
        assert.match(validateSnippet({ name: '', kind: 'package', steps: [{ command: 'a' }] }), /Name/);
    });
});

describe('joining steps', () => {
    test('unchained steps are one per line', () => {
        assert.strictEqual(joinSteps(['a', 'b', 'c'], false), 'a\nb\nc');
    });

    test('chained steps read as a shell chain', () => {
        assert.strictEqual(joinSteps(['git pull', 'npm ci'], true), 'git pull && npm ci');
    });

    test('a multi-line step is braced when chained, so && guards all of it', () => {
        assert.strictEqual(joinSteps(['a\nb', 'c'], true), '{\na\nb\n} && c');
    });

    test('a multi-line step is left alone when not chained', () => {
        assert.strictEqual(joinSteps(['a\nb', 'c'], false), 'a\nb\nc');
    });

    test('a single step composes to itself either way', () => {
        assert.strictEqual(joinSteps(['only'], true), 'only');
        assert.strictEqual(joinSteps(['only'], false), 'only');
    });
});

describe('composing a package', () => {
    const library = [
        normalizeSnippet({ id: 'c1', name: 'Pull', command: 'git pull' }),
        normalizeSnippet({ id: 'c2', name: 'Build', command: 'npm ci && npm run build' }),
        normalizeSnippet({ id: 'c3', name: 'Restart', command: 'systemctl restart {{service}}' }),
        normalizeSnippet({ id: 'p1', name: 'Other package', kind: 'package', steps: [{ command: 'x' }] }),
    ];

    test('a command composes to its own text', () => {
        const { text, missing } = composeSnippet(library[0], library);
        assert.strictEqual(text, 'git pull');
        assert.deepStrictEqual(missing, []);
    });

    test('references resolve in order', () => {
        const pkg = normalizeSnippet({
            name: 'Deploy', kind: 'package',
            steps: [{ ref: 'c1' }, { ref: 'c2' }, { ref: 'c3' }],
        });
        assert.strictEqual(
            composeSnippet(pkg, library).text,
            'git pull\nnpm ci && npm run build\nsystemctl restart {{service}}'
        );
    });

    test('inline and referenced steps mix', () => {
        const pkg = normalizeSnippet({
            name: 'Deploy', kind: 'package',
            steps: [{ ref: 'c1' }, { command: 'echo custom' }, { ref: 'c3' }],
        });
        assert.strictEqual(
            composeSnippet(pkg, library).text,
            'git pull\necho custom\nsystemctl restart {{service}}'
        );
    });

    test('a deleted reference is reported, never silently skipped', () => {
        const pkg = normalizeSnippet({
            name: 'Deploy', kind: 'package',
            steps: [{ ref: 'c1' }, { ref: 'gone' }, { ref: 'c3' }],
        });
        const { missing } = composeSnippet(pkg, library);
        assert.strictEqual(missing.length, 1);
        assert.strictEqual(missing[0].ref, 'gone');
    });

    test('a package cannot reference another package', () => {
        const pkg = normalizeSnippet({
            name: 'Nested', kind: 'package', steps: [{ ref: 'c1' }, { ref: 'p1' }],
        });
        const { missing, steps } = composeSnippet(pkg, library);
        assert.strictEqual(missing.length, 1);
        assert.strictEqual(missing[0].ref, 'p1');
        assert.strictEqual(steps.length, 1);
    });

    test('a package that references itself resolves to nothing extra', () => {
        const pkg = normalizeSnippet({ id: 'self', name: 'Self', kind: 'package', steps: [{ ref: 'self' }] });
        const { missing, text } = composeSnippet(pkg, [...library, pkg]);
        assert.strictEqual(missing.length, 1);
        assert.strictEqual(text, '');
    });

    test('composed steps carry the name they came from', () => {
        const pkg = normalizeSnippet({ name: 'D', kind: 'package', steps: [{ ref: 'c1' }, { command: 'inline' }] });
        const { steps } = composeSnippet(pkg, library);
        assert.strictEqual(steps[0].name, 'Pull');
        assert.strictEqual(steps[1].name, '');
    });

    test('an empty library leaves every reference missing', () => {
        const pkg = normalizeSnippet({ name: 'D', kind: 'package', steps: [{ ref: 'c1' }, { ref: 'c2' }] });
        assert.strictEqual(composeSnippet(pkg, []).missing.length, 2);
    });
});

describe('placeholders across a package', () => {
    const library = [
        normalizeSnippet({ id: 'c1', name: 'Pull', command: 'git pull' }),
        normalizeSnippet({ id: 'c3', name: 'Restart', command: 'systemctl restart {{service}}' }),
    ];

    test('a value used by several steps is asked for once', () => {
        const pkg = normalizeSnippet({
            name: 'Restart and watch', kind: 'package',
            steps: [{ ref: 'c3' }, { command: 'journalctl -u {{service}} -n 50' }],
        });
        const { text } = composeSnippet(pkg, library);
        assert.deepStrictEqual(placeholdersIn(text), ['service']);
    });

    test('every occurrence is filled from the one answer', () => {
        const pkg = normalizeSnippet({
            name: 'Restart and watch', kind: 'package',
            steps: [{ ref: 'c3' }, { command: 'journalctl -u {{service}} -n 50' }],
        });
        const { text } = composeSnippet(pkg, library);
        assert.strictEqual(
            fillPlaceholders(text, { service: 'nginx' }),
            'systemctl restart nginx\njournalctl -u nginx -n 50'
        );
    });

    test('an unanswered placeholder is left standing across a package too', () => {
        const pkg = normalizeSnippet({
            name: 'Clean', kind: 'package', steps: [{ command: 'rm -rf {{path}}/*' }],
        });
        const { text } = composeSnippet(pkg, library);
        assert.strictEqual(fillPlaceholders(text, {}), 'rm -rf {{path}}/*');
    });

    test('placeholders are collected in first-appearance order', () => {
        const pkg = normalizeSnippet({
            name: 'p', kind: 'package',
            steps: [{ command: 'a {{one}}' }, { command: 'b {{two}} {{one}}' }],
        });
        assert.deepStrictEqual(placeholdersIn(composeSnippet(pkg, library).text), ['one', 'two']);
    });
});

describe('round trip', () => {
    const library = [
        normalizeSnippet({ id: 'c1', name: 'Pull', command: 'git pull' }),
        normalizeSnippet({ id: 'c2', name: 'Build', command: 'npm ci && npm run build' }),
    ];

    test('normalising a normalised package is stable', () => {
        const once = normalizeSnippet({
            name: 'Deploy', kind: 'package', chain: true,
            steps: [{ ref: 'c1' }, { command: 'echo done' }],
        });
        assert.deepStrictEqual(normalizeSnippet(once), once);
    });

    test('a list of mixed kinds normalises', () => {
        const list = normalizeSnippets([
            { name: 'a', command: 'ls' },
            { name: 'b', kind: 'package', steps: [{ ref: 'c1' }] },
        ]);
        assert.strictEqual(list[0].kind, 'command');
        assert.strictEqual(list[1].kind, 'package');
    });

    test('chained packages survive normalisation', () => {
        const pkg = normalizeSnippet({
            name: 'Deploy', kind: 'package', chain: true,
            steps: [{ ref: 'c1' }, { ref: 'c2' }],
        });
        assert.strictEqual(composeSnippet(pkg, library).text, 'git pull && npm ci && npm run build');
    });
});
