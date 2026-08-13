/**
 * Host tags: what a tag normalises to, and what an add/remove edit produces.
 *
 * `host-tags.js` has no dependencies, so nothing needs stubbing here.
 */
const path = require('path');
const assert = require('assert');
const { describe, test } = require('node:test');

const {
    normalizeTag,
    normalizeTags,
    applyTagEdit,
    sameTags,
    MAX_TAGS,
    MAX_TAG_LENGTH,
} = require(path.join(__dirname, '..', 'src', 'main', 'host-tags.js'));

describe('tag normalisation', () => {
    test('case is dropped, so Prod and prod are one tag', () => {
        assert.strictEqual(normalizeTag('Prod'), 'prod');
        assert.strictEqual(normalizeTag('PROD'), 'prod');
    });

    test('surrounding space goes and interior runs collapse', () => {
        assert.strictEqual(normalizeTag('  web  '), 'web');
        assert.strictEqual(normalizeTag('web   server'), 'web server');
    });

    test('a comma cannot survive inside a tag: it is the separator', () => {
        assert.ok(!normalizeTag('a,b').includes(','));
    });

    test('nothing in, nothing out', () => {
        assert.strictEqual(normalizeTag('   '), '');
        assert.strictEqual(normalizeTag(null), '');
        assert.strictEqual(normalizeTag(undefined), '');
    });

    test('a tag is capped, and the cap does not leave a trailing space', () => {
        const long = normalizeTag(`${'a'.repeat(MAX_TAG_LENGTH - 1)} bbbb`);
        assert.strictEqual(long.length, MAX_TAG_LENGTH - 1);
        assert.strictEqual(long, long.trim());
    });
});

describe('tag lists', () => {
    test('a comma-separated string is a list', () => {
        assert.deepStrictEqual(normalizeTags('prod, web , db'), ['db', 'prod', 'web']);
    });

    test('an array entry holding commas is split too, which is what a paste does', () => {
        assert.deepStrictEqual(normalizeTags(['prod, web']), ['prod', 'web']);
    });

    test('duplicates go, whatever case they were typed in', () => {
        assert.deepStrictEqual(normalizeTags(['Prod', 'prod', ' PROD ']), ['prod']);
    });

    test('the result is sorted, so re-saving in another order is not an edit', () => {
        assert.deepStrictEqual(normalizeTags(['web', 'db', 'app']), ['app', 'db', 'web']);
    });

    test('empties are dropped rather than stored', () => {
        assert.deepStrictEqual(normalizeTags(['prod', '', '  ', null]), ['prod']);
    });

    test('nothing at all normalises to an empty list, not a crash', () => {
        assert.deepStrictEqual(normalizeTags(undefined), []);
        assert.deepStrictEqual(normalizeTags(null), []);
        assert.deepStrictEqual(normalizeTags(42), []);
    });

    test('the list is capped', () => {
        const many = Array.from({ length: MAX_TAGS + 10 }, (unused, index) => `tag${index}`);
        assert.strictEqual(normalizeTags(many).length, MAX_TAGS);
    });
});

describe('tag edits', () => {
    test('adding puts a tag on, and the result stays sorted', () => {
        assert.deepStrictEqual(applyTagEdit(['web'], { add: ['db'] }), ['db', 'web']);
    });

    test('adding a tag that is already there changes nothing', () => {
        assert.deepStrictEqual(applyTagEdit(['web'], { add: ['web'] }), ['web']);
    });

    test('removing takes a tag off and leaves the rest', () => {
        assert.deepStrictEqual(applyTagEdit(['db', 'web'], { remove: ['db'] }), ['web']);
    });

    test('removing something that is not there changes nothing', () => {
        assert.deepStrictEqual(applyTagEdit(['web'], { remove: ['db'] }), ['web']);
    });

    test('a tag in both add and remove ends up on: removals are applied first', () => {
        assert.deepStrictEqual(applyTagEdit(['web'], { add: ['db'], remove: ['db'] }), ['db', 'web']);
    });

    test('an edit normalises what it is given, so "Prod" removes "prod"', () => {
        assert.deepStrictEqual(applyTagEdit(['prod', 'web'], { remove: ['PROD'] }), ['web']);
    });

    test('an empty edit is the list it started with', () => {
        assert.deepStrictEqual(applyTagEdit(['web', 'db'], {}), ['db', 'web']);
        assert.deepStrictEqual(applyTagEdit(['web'], undefined), ['web']);
    });

    test('a host with no tags at all can still be tagged', () => {
        assert.deepStrictEqual(applyTagEdit(undefined, { add: ['prod'] }), ['prod']);
    });
});

describe('comparing lists', () => {
    test('two normalised lists agreeing are the same', () => {
        assert.strictEqual(sameTags(['a', 'b'], ['a', 'b']), true);
    });

    test('length and contents both count', () => {
        assert.strictEqual(sameTags(['a'], ['a', 'b']), false);
        assert.strictEqual(sameTags(['a', 'b'], ['a', 'c']), false);
    });

    test('an unchanged edit compares equal, which is what stops a needless write', () => {
        const before = normalizeTags(['web', 'db']);
        const after = applyTagEdit(before, { add: ['db'] });
        assert.strictEqual(sameTags(before, after), true);
    });
});
