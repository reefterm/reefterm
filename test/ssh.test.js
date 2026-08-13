/**
 * Exercises ssh.js: the connection dial (single hop and jump-host chains),
 * keyboard-interactive auth (which prompts a stored password auto-answers,
 * which go to the user, and the round limit), session teardown ordering, and
 * the pure config/formatting helpers.
 *
 * `electron` is stubbed the same way store.test.js/jump-host.test.js do it.
 * `ssh2` is stubbed too, with a fake `Client` that is a plain EventEmitter
 * plus recorded calls (`forwardOut`/`shell`/`exec`) the test resolves by
 * hand: this is not a re-implementation of ssh2's own auth-method
 * negotiation (that is ssh2's job, not this repo's), it is a way to drive
 * the orchestration ssh.js itself owns - chain traversal, relay wiring, the
 * interactive-round bookkeeping, settle/abandon - without a real server.
 */
const Module = require('module');
const EventEmitter = require('events');
const path = require('path');
const fs = require('fs');
const os = require('os');
const assert = require('assert');
const { describe, test } = require('node:test');

const ROOT = path.join(__dirname, '..', 'src', 'main');

/* ------------------------------------------------------------------ *
 * Fakes
 * ------------------------------------------------------------------ */

class FakeStream extends EventEmitter {
    constructor() {
        super();
        this.stderr = new EventEmitter();
        this.writable = true;
        this.written = [];
        this.windowChanges = [];
        this.ended = false;
    }
    write(data) { this.written.push(data); return true; }
    setWindow(rows, cols) { this.windowChanges.push({ rows, cols }); }
    end() { this.ended = true; }
}

function makeFakeSsh2() {
    const instances = [];

    class FakeClient extends EventEmitter {
        constructor() {
            super();
            this.ended = false;
            this._readyTimeout = null;
            this.forwardOutCalls = [];
            this.shellCalls = [];
            this.execCalls = [];
            this.config = null;
            this.noDelay = false;
            instances.push(this);
        }
        connect(config) { this.config = config; }
        setNoDelay(v) { this.noDelay = v; }
        end() {
            if (this.ended) return;
            this.ended = true;
            // Deferred, not synchronous: a real socket's teardown always
            // costs at least a tick, which is what lets abandon()'s own
            // settle() (called right after end()) win the race against the
            // close handler's. A synchronous emit here would settle every
            // abandoned dial with "Connection closed" instead of the actual
            // reason, which is not what a live server produces.
            setImmediate(() => this.emit('close'));
        }
        forwardOut(srcIP, srcPort, dstHost, dstPort, cb) {
            this.forwardOutCalls.push({ dstHost, dstPort, cb });
        }
        shell(options, cb) {
            const stream = new FakeStream();
            this.shellCalls.push({ options, cb, stream });
        }
        exec(cmd, cb) {
            const stream = new FakeStream();
            this.execCalls.push({ cmd, cb, stream });
        }
    }

    return { Client: FakeClient, instances };
}

class FakeMessagePort extends EventEmitter {
    constructor() {
        super();
        this.started = false;
        this.posted = [];
        this.peer = null;
    }
    on(event, cb) {
        if (event === 'message') super.on('message', cb);
        return this;
    }
    start() { this.started = true; }
    postMessage(data) {
        this.posted.push(data);
        if (this.peer?.started) this.peer.emit('message', { data });
    }
    close() {}
}

class FakeMessageChannelMain {
    constructor() {
        this.port1 = new FakeMessagePort();
        this.port2 = new FakeMessagePort();
        this.port1.peer = this.port2;
        this.port2.peer = this.port1;
    }
}

/** Loads a fresh ssh.js (plus store.js, same instance) under stubbed electron/ssh2. */
function freshSsh({ userData = null } = {}) {
    const dir = userData || fs.mkdtempSync(path.join(os.tmpdir(), 'rt-test-ssh-'));
    const ssh2Fake = makeFakeSsh2();
    const electronStub = {
        app: {
            getPath: (what) => (what === 'userData' ? dir : os.tmpdir()),
            getVersion: () => '1.0.0',
            on: () => {},
        },
        safeStorage: {
            isEncryptionAvailable: () => false,
            encryptString: () => { throw new Error('unavailable'); },
            decryptString: () => { throw new Error('unavailable'); },
        },
        powerMonitor: { on: () => {} },
        MessageChannelMain: FakeMessageChannelMain,
    };

    const realLoad = Module._load;
    Module._load = function (request, parent, isMain) {
        if (request === 'electron') return electronStub;
        if (request === 'ssh2') {
            // Only Client is faked. certificate.js/hello.js/agent.js pull real
            // exports (BaseAgent, utils.parseKey, createAgent) off this same
            // module, so those have to stay real underneath the override.
            const real = realLoad.call(this, request, parent, isMain);
            return { ...real, Client: ssh2Fake.Client };
        }
        return realLoad.call(this, request, parent, isMain);
    };
    try {
        for (const key of Object.keys(require.cache)) {
            if (key.includes(`${path.sep}main${path.sep}`)) delete require.cache[key];
        }
        return {
            ssh: require(path.join(ROOT, 'ssh')),
            store: require(path.join(ROOT, 'store')),
            userData: dir,
            instances: ssh2Fake.instances,
        };
    } finally {
        Module._load = realLoad;
    }
}

/** A saved SSH host, with only the fields a dial reads. */
function host(store, id, extra = {}) {
    return store.saveHost({
        id, name: id, host: `${id}.example.com`, username: 'root', authMethod: 'password', password: 'hunter2',
        ...extra,
    });
}

const noopRequestTrust = async () => true;

/* ------------------------------------------------------------------ *
 * Pure helpers
 * ------------------------------------------------------------------ */

describe('ssh: buildConfig', () => {
    const { ssh } = freshSsh();

    test('a password host gets tryKeyboard and the password, nothing else', () => {
        const config = ssh.buildConfig({ host: 'h', port: 22, username: 'root', authMethod: 'password', password: 'x' });
        assert.strictEqual(config.password, 'x');
        assert.strictEqual(config.tryKeyboard, true);
        assert.strictEqual(config.agent, undefined);
        assert.strictEqual(config.privateKey, undefined);
    });

    test('an empty-string password still buys a config.password so it is offered and refused first', () => {
        const config = ssh.buildConfig({ host: 'h', port: 22, username: 'root', authMethod: 'password', password: '' });
        assert.strictEqual(config.password, undefined);
    });

    test('an agent host carries the resolved path, not the configured one', () => {
        const config = ssh.buildConfig({
            host: 'h', port: 22, username: 'root', authMethod: 'agent',
            agentPath: 'configured-path', resolvedAgentPath: 'resolved-path',
        });
        assert.strictEqual(config.agent, 'resolved-path');
    });

    test('agent forwarding is only set when asked for', () => {
        const withForward = ssh.buildConfig({ host: 'h', authMethod: 'agent', resolvedAgentPath: 'p', agentForward: true });
        assert.strictEqual(withForward.agentForward, true);

        const without = ssh.buildConfig({ host: 'h', authMethod: 'agent', resolvedAgentPath: 'p' });
        assert.strictEqual(without.agentForward, undefined);
    });

    test('a plain key host carries the private key, and the passphrase only when there is one', () => {
        const withPassphrase = ssh.buildConfig({
            host: 'h', authMethod: 'key', privateKey: 'PEM', passphrase: 'secret',
        });
        assert.strictEqual(withPassphrase.privateKey, 'PEM');
        assert.strictEqual(withPassphrase.passphrase, 'secret');

        const without = ssh.buildConfig({ host: 'h', authMethod: 'key', privateKey: 'PEM' });
        assert.strictEqual(without.passphrase, undefined);
    });

    test('legacyAlgorithms swaps in the compatibility list', () => {
        const withLegacy = ssh.buildConfig({ host: 'h', authMethod: 'password', legacyAlgorithms: true });
        assert.ok(withLegacy.algorithms.cipher.includes('aes256-cbc'));

        const without = ssh.buildConfig({ host: 'h', authMethod: 'password' });
        assert.strictEqual(without.algorithms, undefined);
    });

    test('tryKeyboard is offered for every auth method, not just password', () => {
        for (const authMethod of ['agent', 'key', 'password']) {
            const config = ssh.buildConfig({ host: 'h', authMethod, resolvedAgentPath: 'p', privateKey: 'PEM', password: 'x' });
            assert.strictEqual(config.tryKeyboard, true);
        }
    });

    // hello.agentFor/certificate.agentFor parse real key/certificate material
    // via ssh2's own key parser and throw on anything else. Generating a
    // synthetic OpenSSH certificate (not just a keypair) to exercise those
    // branches is out of scope for this pass; buildConfig's wiring for every
    // other auth method is covered above.
});

describe('ssh: planKeyboardInteractive', () => {
    const { ssh } = freshSsh();

    test('an echo-off password prompt is auto-answered from the stored password', () => {
        const { answers, unanswered, spentPassword } = ssh.planKeyboardInteractive(
            [{ prompt: 'Password:', echo: false }], 'hunter2', false
        );
        assert.deepStrictEqual(answers, ['hunter2']);
        assert.deepStrictEqual(unanswered, []);
        assert.strictEqual(spentPassword, true);
    });

    test('a passphrase prompt matches too', () => {
        const { answers } = ssh.planKeyboardInteractive([{ prompt: 'Enter passphrase:', echo: false }], 'hunter2', false);
        assert.deepStrictEqual(answers, ['hunter2']);
    });

    test('an echoed prompt is never auto-answered, even if it says "password"', () => {
        const { answers, unanswered } = ssh.planKeyboardInteractive(
            [{ prompt: 'Confirm password:', echo: true }], 'hunter2', false
        );
        assert.deepStrictEqual(answers, ['']);
        assert.strictEqual(unanswered.length, 1);
    });

    test('a non-password prompt (a one-time code) is left for the user', () => {
        const { answers, unanswered } = ssh.planKeyboardInteractive(
            [{ prompt: 'Verification code:', echo: false }], 'hunter2', false
        );
        assert.deepStrictEqual(answers, ['']);
        assert.strictEqual(unanswered.length, 1);
        assert.strictEqual(unanswered[0].text, 'Verification code:');
    });

    test('the password is spent at most once per round, even with two matching prompts', () => {
        const { answers, unanswered, spentPassword } = ssh.planKeyboardInteractive(
            [{ prompt: 'Password:', echo: false }, { prompt: 'Password (again):', echo: false }],
            'hunter2', false
        );
        assert.strictEqual(answers[0], 'hunter2');
        assert.strictEqual(answers[1], '');
        assert.strictEqual(unanswered.length, 1);
        assert.strictEqual(spentPassword, true);
    });

    test('a password already spent in an earlier round is not resent', () => {
        const { answers, unanswered, spentPassword } = ssh.planKeyboardInteractive(
            [{ prompt: 'Password:', echo: false }], 'hunter2', true
        );
        assert.strictEqual(answers[0], '');
        assert.strictEqual(unanswered.length, 1);
        assert.strictEqual(spentPassword, false);
    });

    test('with no stored password, a password prompt goes to the user like any other', () => {
        const { answers, unanswered } = ssh.planKeyboardInteractive(
            [{ prompt: 'Password:', echo: false }], '', false
        );
        assert.strictEqual(answers[0], '');
        assert.strictEqual(unanswered.length, 1);
    });

    test('every prompt keeps its original index in the unanswered list', () => {
        const { unanswered } = ssh.planKeyboardInteractive(
            [
                { prompt: 'Password:', echo: false },
                { prompt: 'One-time code:', echo: false },
                { prompt: 'Confirm:', echo: true },
            ],
            'hunter2', false
        );
        assert.deepStrictEqual(unanswered.map(u => u.index), [1, 2]);
    });
});

/* ------------------------------------------------------------------ *
 * Session teardown
 * ------------------------------------------------------------------ */

/** A minimal fake session, with just enough shape for destroy() to walk. */
function fakeSession(overrides = {}) {
    return {
        client: { end: () => {} },
        chain: null,
        stream: { end: () => {} },
        port: { close: () => {} },
        hostId: 'h1',
        hostName: 'h1',
        address: 'h1.example.com:22',
        openedAt: Date.now(),
        ...overrides,
    };
}

describe('ssh: session teardown', () => {
    test('destroy() reports false and does nothing for a tab with no session', () => {
        const { ssh } = freshSsh();
        assert.strictEqual(ssh.destroy('nope'), false);
    });

    test('destroy() removes the session and ends its stream, port and client', () => {
        const { ssh } = freshSsh();
        const ended = { client: false, stream: false, port: false };
        ssh.sessions.set('t1', fakeSession({
            client: { end: () => { ended.client = true; } },
            stream: { end: () => { ended.stream = true; } },
            port: { close: () => { ended.port = true; } },
        }));

        assert.strictEqual(ssh.destroy('t1'), true);
        assert.deepStrictEqual(ended, { client: true, stream: true, port: true });
        assert.strictEqual(ssh.get('t1'), undefined);
    });

    test('a multi-hop chain is ended innermost first', () => {
        const { ssh } = freshSsh();
        const order = [];
        const chain = [
            { end: () => order.push('bastion') },
            { end: () => order.push('target') },
        ];
        ssh.sessions.set('t1', fakeSession({ client: chain[1], chain }));

        ssh.destroy('t1');
        assert.deepStrictEqual(order, ['target', 'bastion']);
    });

    test('teardown hooks run before the sockets are torn down, and a throwing hook does not stop the others', () => {
        const { ssh } = freshSsh();
        const calls = [];
        ssh.onDestroy(() => calls.push('hook-1'));
        ssh.onDestroy(() => { throw new Error('boom'); });
        ssh.onDestroy(() => calls.push('hook-2'));
        ssh.sessions.set('t1', fakeSession({ stream: { end: () => calls.push('stream-end') } }));

        ssh.destroy('t1');
        assert.deepStrictEqual(calls, ['hook-1', 'hook-2', 'stream-end']);
    });

    test('destroyAll() tears down every open session', () => {
        const { ssh } = freshSsh();
        ssh.sessions.set('t1', fakeSession());
        ssh.sessions.set('t2', fakeSession());

        ssh.destroyAll();
        assert.strictEqual(ssh.sessions.size, 0);
    });

    test('describe() names the host a tab is attached to, and is blank for an unknown tab', () => {
        const { ssh } = freshSsh();
        ssh.sessions.set('t1', fakeSession({ hostId: 'h1', hostName: 'db', address: 'db.example.com:22' }));

        assert.deepStrictEqual(ssh.describe('t1'), { hostId: 'h1', hostName: 'db', subject: 'db.example.com:22' });
        assert.deepStrictEqual(ssh.describe('nope'), { hostId: '', hostName: '', subject: '' });
    });

    test('a session closed as dropped is logged as a failure; an ordinary close is not', () => {
        const { ssh, userData } = freshSsh();
        const activity = require(path.join(ROOT, 'activity'));

        ssh.sessions.set('t1', fakeSession());
        ssh.destroy('t1', { reason: 'dropped' });
        ssh.sessions.set('t2', fakeSession());
        ssh.destroy('t2', { reason: 'closed' });

        const { entries } = activity.list({ category: 'connection' });
        const dropped = entries.find(e => e.detail?.includes('connection dropped'));
        const closed = entries.find(e => e.detail?.includes('Closed from the app'));
        assert.strictEqual(dropped?.outcome, 'failure');
        assert.strictEqual(closed?.outcome, 'info');
        void userData;
    });

    test('the logged duration is phrased in the largest whole unit that fits', () => {
        const { ssh } = freshSsh();
        const activity = require(path.join(ROOT, 'activity'));

        ssh.sessions.set('short', fakeSession({ openedAt: Date.now() - 5000 }));
        ssh.destroy('short');
        ssh.sessions.set('long', fakeSession({ openedAt: Date.now() - 90 * 1000 }));
        ssh.destroy('long');

        const { entries } = activity.list({ category: 'connection' });
        const short = entries.find(e => e.detail?.includes('lasted 5s'));
        const long = entries.find(e => /lasted 1m 3\ds/.test(e.detail || ''));
        assert.ok(short, 'expected a "lasted 5s" entry');
        assert.ok(long, 'expected a "lasted 1m ..s" entry');
    });
});

/* ------------------------------------------------------------------ *
 * The dial itself: connect() / dialChain(), driven through the fake Client
 * ------------------------------------------------------------------ */

/**
 * Everything up to and including `client.connect(config)` happens
 * synchronously inside dialHop's own Promise executor, so the fake Client
 * exists in `instances` the moment `ssh.connect()` returns - no await
 * needed to observe it. Resolving *that* promise (via emit('ready') etc.)
 * only schedules dialChain's continuation, though, so a macrotask flush is
 * needed before its effects (like client.shell() being called) are visible.
 */
const tick = () => new Promise((resolve) => setImmediate(resolve));

const noRequestKeyboardInteractive = async () => null;

describe('ssh: connect() - single hop', () => {
    test('a successful dial registers a session and returns the route', async () => {
        const { ssh, store, instances } = freshSsh();
        const h = host(store, 'h1');

        const resultPromise = ssh.connect(
            { tabId: 't1', hostId: h.id, cols: 100, rows: 30 },
            { window: null, requestTrust: noopRequestTrust, requestKeyboardInteractive: noRequestKeyboardInteractive }
        );

        const client = instances[instances.length - 1];
        assert.strictEqual(client.config.host, 'h1.example.com');
        assert.strictEqual(client.config.password, 'hunter2');
        client.emit('ready');
        await tick();

        assert.strictEqual(client.shellCalls.length, 1);
        assert.deepStrictEqual(client.shellCalls[0].options, { term: 'xterm-256color', cols: 100, rows: 30 });
        client.shellCalls[0].cb(null, client.shellCalls[0].stream);

        const result = await resultPromise;
        assert.strictEqual(result.success, true);
        assert.deepStrictEqual(result.route, [{ kind: 'host', label: 'h1', detail: 'root@h1.example.com' }]);
        assert.strictEqual(ssh.get('t1').client, client);
    });

    test('an auth failure reports the error and registers no session', async () => {
        const { ssh, store, instances } = freshSsh();
        const h = host(store, 'h1');

        const resultPromise = ssh.connect(
            { tabId: 't1', hostId: h.id },
            { window: null, requestTrust: noopRequestTrust, requestKeyboardInteractive: noRequestKeyboardInteractive }
        );

        const client = instances[instances.length - 1];
        client.emit('error', new Error('All configured authentication methods failed'));

        const result = await resultPromise;
        assert.strictEqual(result.success, false);
        assert.match(result.message, /authentication methods failed/);
        assert.strictEqual(ssh.get('t1'), undefined);
    });

    test('a shell that fails to open still settles the connect() promise', async () => {
        const { ssh, store, instances } = freshSsh();
        const h = host(store, 'h1');

        const resultPromise = ssh.connect(
            { tabId: 't1', hostId: h.id },
            { window: null, requestTrust: noopRequestTrust, requestKeyboardInteractive: noRequestKeyboardInteractive }
        );

        const client = instances[instances.length - 1];
        client.emit('ready');
        await tick();
        client.shellCalls[0].cb(new Error('channel open failed'));

        const result = await resultPromise;
        assert.strictEqual(result.success, false);
        assert.match(result.message, /channel open failed/);
    });
});

describe('ssh: connect() - jump hosts', () => {
    test('a two-hop chain relays through the bastion and dials the target over it', async () => {
        const { ssh, store, instances } = freshSsh();
        const bastion = host(store, 'bastion');
        const target = host(store, 'target', { jumpHostId: bastion.id });

        const resultPromise = ssh.connect(
            { tabId: 't1', hostId: target.id },
            { window: null, requestTrust: noopRequestTrust, requestKeyboardInteractive: noRequestKeyboardInteractive }
        );

        const bastionClient = instances[instances.length - 1];
        assert.strictEqual(bastionClient.config.host, 'bastion.example.com');
        bastionClient.emit('ready');
        await tick();

        assert.strictEqual(bastionClient.forwardOutCalls.length, 1);
        assert.strictEqual(bastionClient.forwardOutCalls[0].dstHost, 'target.example.com');
        const relayStream = {};
        bastionClient.forwardOutCalls[0].cb(null, relayStream);
        await tick();

        const targetClient = instances[instances.length - 1];
        assert.notStrictEqual(targetClient, bastionClient);
        assert.strictEqual(targetClient.config.sock, relayStream);
        targetClient.emit('ready');
        await tick();
        targetClient.shellCalls[0].cb(null, targetClient.shellCalls[0].stream);

        const result = await resultPromise;
        assert.strictEqual(result.success, true);
        assert.deepStrictEqual(result.route, [
            { kind: 'jump', label: 'bastion', detail: 'root@bastion.example.com' },
            { kind: 'host', label: 'target', detail: 'root@target.example.com' },
        ]);
        assert.deepStrictEqual(ssh.get('t1').chain, [bastionClient, targetClient]);
    });

    test('a jump host that fails to authenticate is named in the failure, not the target', async () => {
        const { ssh, store, instances } = freshSsh();
        const bastion = host(store, 'bastion');
        const target = host(store, 'target', { jumpHostId: bastion.id });

        const resultPromise = ssh.connect(
            { tabId: 't1', hostId: target.id },
            { window: null, requestTrust: noopRequestTrust, requestKeyboardInteractive: noRequestKeyboardInteractive }
        );

        const bastionClient = instances[instances.length - 1];
        bastionClient.emit('error', new Error('Authentication failed'));

        const result = await resultPromise;
        assert.strictEqual(result.success, false);
        assert.match(result.message, /^bastion: /);
    });

    test('a bastion that cannot reach the target reports which hop and why, and tears the bastion down', async () => {
        const { ssh, store, instances } = freshSsh();
        const bastion = host(store, 'bastion');
        const target = host(store, 'target', { jumpHostId: bastion.id });

        const resultPromise = ssh.connect(
            { tabId: 't1', hostId: target.id },
            { window: null, requestTrust: noopRequestTrust, requestKeyboardInteractive: noRequestKeyboardInteractive }
        );

        const bastionClient = instances[instances.length - 1];
        bastionClient.emit('ready');
        await tick();
        bastionClient.forwardOutCalls[0].cb(new Error('Connection refused'));

        const result = await resultPromise;
        assert.strictEqual(result.success, false);
        assert.match(result.message, /bastion could not reach target\.example\.com:22: Connection refused/);
        assert.strictEqual(bastionClient.ended, true);
    });
});

describe('ssh: connect() - keyboard-interactive', () => {
    test('a lone password prompt is answered from the stored password without asking the user', async () => {
        const { ssh, store, instances } = freshSsh();
        const h = host(store, 'h1');
        let askedUser = false;

        ssh.connect(
            { tabId: 't1', hostId: h.id },
            { window: null, requestTrust: noopRequestTrust, requestKeyboardInteractive: async () => { askedUser = true; return null; } }
        );

        const client = instances[instances.length - 1];
        const finishCalls = [];
        client.emit('keyboard-interactive', '', '', '', [{ prompt: 'Password:', echo: false }], (answers) => finishCalls.push(answers));

        assert.strictEqual(askedUser, false);
        assert.deepStrictEqual(finishCalls, [['hunter2']]);
    });

    test('a one-time-code prompt is put to the user, and the reply is sent back through finish()', async () => {
        const { ssh, store, instances } = freshSsh();
        const h = host(store, 'h1');

        const resultPromise = ssh.connect(
            { tabId: 't1', hostId: h.id },
            {
                window: null,
                requestTrust: noopRequestTrust,
                requestKeyboardInteractive: async ({ prompts }) => {
                    assert.strictEqual(prompts.length, 1);
                    assert.strictEqual(prompts[0].text, 'Verification code:');
                    return ['123456'];
                },
            }
        );

        const client = instances[instances.length - 1];
        const finishCalls = [];
        client.emit('keyboard-interactive', '', '', '', [{ prompt: 'Verification code:', echo: false }], (answers) => finishCalls.push(answers));
        await tick();

        assert.deepStrictEqual(finishCalls, [['123456']]);

        client.emit('ready');
        await tick();
        client.shellCalls[0].cb(null, client.shellCalls[0].stream);
        assert.strictEqual((await resultPromise).success, true);
    });

    test('a cancelled prompt settles the dial as cancelled rather than hanging', async () => {
        const { ssh, store, instances } = freshSsh();
        const h = host(store, 'h1');

        const resultPromise = ssh.connect(
            { tabId: 't1', hostId: h.id },
            { window: null, requestTrust: noopRequestTrust, requestKeyboardInteractive: async () => null }
        );

        const client = instances[instances.length - 1];
        client.emit('keyboard-interactive', '', '', '', [{ prompt: 'Verification code:', echo: false }], () => {});
        await tick();

        const result = await resultPromise;
        assert.strictEqual(result.success, false);
        assert.match(result.message, /cancelled/);
        assert.strictEqual(client.ended, true);
    });

    test('a server that keeps asking is cut off after the round limit', async () => {
        const { ssh, store, instances } = freshSsh();
        const h = host(store, 'h1');
        let rounds = 0;

        const resultPromise = ssh.connect(
            { tabId: 't1', hostId: h.id },
            {
                window: null,
                requestTrust: noopRequestTrust,
                requestKeyboardInteractive: async () => { rounds += 1; return ['nope']; },
            }
        );

        const client = instances[instances.length - 1];
        for (let i = 0; i < 9; i += 1) {
            client.emit('keyboard-interactive', '', '', '', [{ prompt: `Code attempt ${i}:`, echo: false }], () => {});
            await tick();
        }

        const result = await resultPromise;
        assert.strictEqual(result.success, false);
        assert.match(result.message, /kept asking/);
        assert.ok(rounds <= 8, `expected at most 8 rounds put to the user, got ${rounds}`);
    });
});

describe('ssh: connect() - replacing and dropping a session', () => {
    test('a stale close from a chain that was replaced does not tear down the new session', async () => {
        const { ssh, store, instances } = freshSsh();
        const h = host(store, 'h1');

        // First dial, left mid-flight (never reaches 'ready').
        ssh.connect(
            { tabId: 't1', hostId: h.id },
            { window: null, requestTrust: noopRequestTrust, requestKeyboardInteractive: noRequestKeyboardInteractive }
        );
        const firstClient = instances[instances.length - 1];

        // A second dial on the same tab supersedes it and completes.
        const secondResult = ssh.connect(
            { tabId: 't1', hostId: h.id },
            { window: null, requestTrust: noopRequestTrust, requestKeyboardInteractive: noRequestKeyboardInteractive }
        );
        const secondClient = instances[instances.length - 1];
        assert.notStrictEqual(secondClient, firstClient);
        secondClient.emit('ready');
        await tick();
        secondClient.shellCalls[0].cb(null, secondClient.shellCalls[0].stream);
        await secondResult;

        const registeredBeforeStaleClose = ssh.get('t1');
        assert.strictEqual(registeredBeforeStaleClose.client, secondClient);

        // The superseded first client's close arrives late. It must not be
        // mistaken for the live session dropping.
        firstClient.emit('close');

        assert.strictEqual(ssh.get('t1'), registeredBeforeStaleClose);
    });
});

describe('ssh: connect() - quick connect (a typed address, no saved host)', () => {
    /**
     * An address typed into the picker: no username, no stored password.
     * openQuickConnect, not saveHost - rememberQuickConnect and resolveChain
     * both read the ad-hoc record from store's own in-memory quickConnects
     * map, not the persisted hosts array a normal saveHost writes to.
     */
    function ephemeralHost(store, address = {}) {
        return store.openQuickConnect({ host: '10.0.0.5', ...address });
    }

    test('asks for a username first, since there is no handshake without one', async () => {
        const { ssh, store, instances } = freshSsh();
        const h = ephemeralHost(store);

        const requests = [];
        ssh.connect(
            { tabId: 't1', hostId: h.id },
            {
                window: null,
                requestTrust: noopRequestTrust,
                requestKeyboardInteractive: async (payload) => { requests.push(payload); return null; },
            }
        );
        await tick();

        assert.strictEqual(requests.length, 1);
        assert.strictEqual(requests[0].prompts[0].text, 'login as:');
        // Cancelled (null reply), so nothing was ever dialled.
        assert.strictEqual(instances.length, 0);
    });

    test('with no user name typed, the dial is refused rather than sent with a blank login', async () => {
        const { ssh, store } = freshSsh();
        const h = ephemeralHost(store);

        const resultPromise = ssh.connect(
            { tabId: 't1', hostId: h.id },
            {
                window: null,
                requestTrust: noopRequestTrust,
                requestKeyboardInteractive: async () => ['   '],
            }
        );

        const result = await resultPromise;
        assert.strictEqual(result.success, false);
        assert.match(result.message, /No user name/);
    });

    /**
     * Drives quickConnectAuth the way ssh2's own authHandler contract works:
     * called once per round with what the server still accepts. 'none' is
     * offered first (and always is, regardless of authsLeft) so the server
     * gets a chance to just let the connection through; a server offering
     * only 'password' is what reaches the branch that asks the user for one
     * directly rather than routing through the keyboard-interactive event
     * (see the 'keyboard-interactive'-offered case below).
     */
    test('once logged in, asks for the password directly when the server offers only that', async () => {
        const { ssh, store, instances } = freshSsh();
        const h = ephemeralHost(store);

        const asked = [];
        const resultPromise = ssh.connect(
            { tabId: 't1', hostId: h.id },
            {
                window: null,
                requestTrust: noopRequestTrust,
                requestKeyboardInteractive: async (payload) => {
                    asked.push(payload);
                    if (payload.prompts[0].text === 'login as:') return ['deploy'];
                    return ['typed-password'];
                },
            }
        );
        await tick();

        const client = instances[instances.length - 1];
        assert.strictEqual(client.config.username, 'deploy');
        const authHandler = client.config.authHandler;

        assert.strictEqual(authHandler(null, false, () => {}), 'none');

        let offeredCredential = null;
        authHandler(['password'], false, (cred) => { offeredCredential = cred; });
        await tick();

        assert.strictEqual(asked[1].prompts[0].text, "deploy@10.0.0.5's password:");
        assert.deepStrictEqual(offeredCredential, { type: 'password', username: 'deploy', password: 'typed-password' });

        client.emit('ready');
        await tick();
        client.shellCalls[0].cb(null, client.shellCalls[0].stream);

        const result = await resultPromise;
        assert.strictEqual(result.success, true);
        // Learned only once the server actually accepted it.
        assert.strictEqual(store.resolveChain(h.id).chain[0].password, 'typed-password');
    });

    test('when the server offers keyboard-interactive, that is tried before ever asking for a plain password', async () => {
        const { ssh, store, instances } = freshSsh();
        const h = ephemeralHost(store);

        ssh.connect(
            { tabId: 't1', hostId: h.id },
            { window: null, requestTrust: noopRequestTrust, requestKeyboardInteractive: async () => ['deploy'] }
        );
        await tick();

        const client = instances[instances.length - 1];
        const authHandler = client.config.authHandler;
        authHandler(null, false, () => {});
        const method = authHandler(['keyboard-interactive', 'password'], false, () => {});

        // Routes to the client's own 'keyboard-interactive' event handler
        // (already covered above) rather than asking for a password itself.
        assert.strictEqual(method, 'keyboard-interactive');
    });

    test('nothing an address alone can answer is refused, naming what the server wanted', async () => {
        const { ssh, store, instances } = freshSsh();
        const h = ephemeralHost(store);

        const resultPromise = ssh.connect(
            { tabId: 't1', hostId: h.id },
            { window: null, requestTrust: noopRequestTrust, requestKeyboardInteractive: async () => ['deploy'] }
        );
        await tick();

        const client = instances[instances.length - 1];
        const authHandler = client.config.authHandler;
        authHandler(null, false, () => {});
        const method = authHandler(['publickey'], false, () => {});

        assert.strictEqual(method, false);
        const result = await resultPromise;
        assert.strictEqual(result.success, false);
        assert.match(result.message, /accepts publickey/);
        assert.match(result.message, /Save it as a host/);
    });
});
