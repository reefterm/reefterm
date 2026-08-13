/**
 * Jump hosts: the chain a connection is dialled through.
 *
 * Two things are worth guarding here. The order, because a chain dialled the
 * wrong way round would try to reach the bastion through the host that is only
 * reachable via the bastion. And the refusals, because every one of them stands
 * between the connection layer and a loop it would otherwise dial forever.
 */
const Module = require('module');
const path = require('path');
const fs = require('fs');
const os = require('os');
const assert = require('assert');
const { describe, test } = require('node:test');

const ROOT = path.join(__dirname, '..', 'src', 'main');

const userData = fs.mkdtempSync(path.join(os.tmpdir(), 'cb-test-jump-'));

const electronStub = {
    app: {
        getPath: (what) => (what === 'userData' ? userData : os.tmpdir()),
        getVersion: () => '1.0.0',
    },
    safeStorage: {
        isEncryptionAvailable: () => false,
        encryptString: () => { throw new Error('unavailable'); },
        decryptString: () => { throw new Error('unavailable'); },
    },
    powerMonitor: { on: () => {} },
};

const realLoad = Module._load;
Module._load = function (request, parent, isMain) {
    if (request === 'electron') return electronStub;
    return realLoad.call(this, request, parent, isMain);
};

const store = require(path.join(ROOT, 'store'));
const { proxyJumpAliases } = require(path.join(ROOT, 'ssh-config.js'));

/** A saved SSH host, with only the fields a chain reads. */
const host = (id, extra = {}) => store.saveHost({
    id,
    name: id,
    host: `${id}.example.com`,
    username: 'root',
    authMethod: 'password',
    ...extra,
});

const hopIds = (chain) => chain.map(hop => hop.hostId);

describe('ProxyJump: what a spec names', () => {
    test('a bare alias is the host', () => {
        assert.deepStrictEqual(proxyJumpAliases('bastion'), ['bastion']);
    });

    test('a user and a port belong to the hop, not to this reference', () => {
        assert.deepStrictEqual(proxyJumpAliases('deploy@bastion:2222'), ['bastion']);
    });

    test('a username containing @ splits at the last one', () => {
        assert.deepStrictEqual(proxyJumpAliases('user@corp.com@bastion'), ['bastion']);
    });

    test('an IPv6 literal keeps its colons', () => {
        assert.deepStrictEqual(proxyJumpAliases('[2001:db8::1]:2222'), ['2001:db8::1']);
        assert.deepStrictEqual(proxyJumpAliases('[2001:db8::1]'), ['2001:db8::1']);
    });

    test('a chain comes back in dial order', () => {
        assert.deepStrictEqual(proxyJumpAliases('outer,inner'), ['outer', 'inner']);
    });

    test('none cancels rather than naming a host called none', () => {
        assert.deepStrictEqual(proxyJumpAliases('none'), []);
        assert.deepStrictEqual(proxyJumpAliases('NONE'), []);
    });

    test('nothing at all is nothing', () => {
        assert.deepStrictEqual(proxyJumpAliases(''), []);
        assert.deepStrictEqual(proxyJumpAliases(undefined), []);
    });
});

describe('resolveChain: order', () => {
    test('a host reached directly is a chain of one', () => {
        host('direct');
        const { chain, error } = store.resolveChain('direct');

        assert.strictEqual(error, '');
        assert.deepStrictEqual(hopIds(chain), ['direct']);
        assert.strictEqual(chain[0].isTarget, true);
    });

    test('one hop is dialled before the host that needs it', () => {
        host('bastion');
        host('behind', { jumpHostId: 'bastion' });

        const { chain, error } = store.resolveChain('behind');

        assert.strictEqual(error, '');
        assert.deepStrictEqual(hopIds(chain), ['bastion', 'behind']);
    });

    test('only the last hop is the target', () => {
        const { chain } = store.resolveChain('behind');

        assert.deepStrictEqual(chain.map(hop => hop.isTarget), [false, true]);
    });

    test('a hop reached through a hop is dialled outermost first', () => {
        host('outer');
        host('middle', { jumpHostId: 'outer' });
        host('inner', { jumpHostId: 'middle' });

        const { chain, error } = store.resolveChain('inner');

        assert.strictEqual(error, '');
        assert.deepStrictEqual(hopIds(chain), ['outer', 'middle', 'inner']);
    });

    test('every hop carries the credentials it will be dialled with', () => {
        const { chain } = store.resolveChain('behind');

        // Resolved per hop rather than inherited from the target: that is the whole
        // point of holding a jump host as a reference to a record.
        assert.strictEqual(chain[0].host, 'bastion.example.com');
        assert.strictEqual(chain[1].host, 'behind.example.com');
        assert.strictEqual(chain[0].label.name, 'bastion');
    });
});

describe('resolveChain: what it refuses', () => {
    test('a host cannot be saved as its own jump host', () => {
        const saved = host('selfish', { jumpHostId: 'selfish' });
        assert.strictEqual(saved.jumpHostId, '');
    });

    test('a cycle between two hosts is refused rather than dialled', () => {
        host('ping');
        host('pong', { jumpHostId: 'ping' });
        // Closing the loop from the other end: neither save is a self-reference, so
        // only the walk catches this.
        host('ping', { jumpHostId: 'pong' });

        const { chain, error } = store.resolveChain('pong');

        assert.match(error, /reached through itself/);
        assert.deepStrictEqual(chain, []);
    });

    test('a chain longer than the cap is refused', () => {
        for (let index = 0; index <= store.MAX_JUMP_HOPS + 1; index++) {
            host(`long-${index}`, { jumpHostId: index === 0 ? '' : `long-${index - 1}` });
        }

        const { error } = store.resolveChain(`long-${store.MAX_JUMP_HOPS + 1}`);
        assert.match(error, /relayed through more than/);
    });

    test('a jump host with no SSH to relay over is refused', () => {
        host('console-server', { protocol: 'telnet' });
        host('via-telnet', { jumpHostId: 'console-server' });

        const { error } = store.resolveChain('via-telnet');
        assert.match(error, /not an SSH host/);
    });

    test('a jump host that cannot resolve its own key names itself', () => {
        host('broken-bastion', { authMethod: 'keychain', keychainKeyId: 'no-such-key' });
        host('past-it', { jumpHostId: 'broken-bastion' });

        const { error } = store.resolveChain('past-it');

        // Unqualified, this reads as being about `past-it`, and the user goes and
        // checks the wrong host's key.
        assert.match(error, /^broken-bastion: /);
    });

    test('the target resolving badly is reported without a prefix', () => {
        host('bad-target', { authMethod: 'keychain', keychainKeyId: 'no-such-key' });

        const { error } = store.resolveChain('bad-target');
        assert.match(error, /^Selected SSH key not found/);
    });
});

describe('deleting a jump host', () => {
    test('hosts relayed through a deleted host stop pointing at it', () => {
        host('doomed');
        host('orphan-a', { jumpHostId: 'doomed' });
        host('orphan-b', { jumpHostId: 'doomed' });

        store.deleteHost('doomed');

        const hosts = store.getHosts();
        assert.strictEqual(hosts.find(entry => entry.id === 'orphan-a').jumpHostId, '');
        assert.strictEqual(hosts.find(entry => entry.id === 'orphan-b').jumpHostId, '');
    });

    test('and then connect directly rather than failing to resolve', () => {
        const { chain, error } = store.resolveChain('orphan-a');

        assert.strictEqual(error, '');
        assert.deepStrictEqual(hopIds(chain), ['orphan-a']);
    });

    test('a reference to a host that vanished some other way is reported', () => {
        // Written straight into the store, bypassing the delete that would have
        // cleaned it up, as a backup from a device with more hosts would leave it.
        const raw = store.load();
        raw.hosts.find(entry => entry.id === 'orphan-b').jumpHostId = 'never-existed';

        const { error } = store.resolveChain('orphan-b');
        assert.match(error, /no longer exists/);
    });
});

Module._load = realLoad;
