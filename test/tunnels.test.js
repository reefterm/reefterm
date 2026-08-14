/**
 * Exercises tunnels.js: local and dynamic (SOCKS5) forwarding end to end
 * over real localhost sockets, remote forwarding's dispatch-by-bound-port,
 * sync()'s reconciliation against a host's configured tunnels, and the
 * lifecycle (start/stop/startAll/stopAll/cleanup).
 *
 * `electron` is stubbed the same way sftp.test.js does it, since tunnels.js
 * pulls in store.js (for getHostTunnels) and ssh.js (for the sessions Map).
 * No ssh2 stub: a session's `client` is a plain fake exposing forwardOut/
 * forwardIn/unforwardIn/on/removeListener, set directly on `ssh.sessions`.
 *
 * `forwardOut`'s "channel" is a *real* local socket, connected to a real
 * local TCP server standing in for the SSH-side destination - tunnels.js
 * only ever treats a channel as a generic duplex stream, so this is a more
 * faithful double than a synthetic one, and it exercises the actual byte
 * pump (bridge()) end to end rather than asserting on call arguments.
 */
const Module = require('module');
const net = require('net');
const path = require('path');
const fs = require('fs');
const os = require('os');
const assert = require('assert');
const { EventEmitter } = require('events');
const { describe, test } = require('node:test');

const ROOT = path.join(__dirname, '..', 'src', 'main');

/* ------------------------------------------------------------------ *
 * Fakes
 * ------------------------------------------------------------------ */

/** A real local TCP server standing in for "whatever the SSH server reaches". */
function startDestination() {
    return new Promise((resolve) => {
        const received = [];
        const sockets = new Set();
        let totalConnections = 0;
        const server = net.createServer((socket) => {
            totalConnections += 1;
            sockets.add(socket);
            socket.on('close', () => sockets.delete(socket));
            socket.on('data', (chunk) => received.push(chunk));
            // Echo, so a test can observe a full round trip through the tunnel.
            socket.on('data', (chunk) => socket.write(chunk));
        });
        server.listen(0, '127.0.0.1', () => resolve({
            server,
            port: server.address().port,
            received,
            get totalConnections() { return totalConnections; },
            get activeConnections() { return sockets.size; },
            close: () => new Promise((r) => {
                // A test's own teardown must never depend on the code under
                // test having cleaned up correctly - that's backwards, and
                // exactly the scenario a regression test needs to survive.
                // Anything still open is force-destroyed first, so
                // server.close()'s callback (which otherwise waits for every
                // connection to end on its own) always fires promptly.
                for (const socket of sockets) socket.destroy();
                server.close(r);
            }),
        }));
    });
}

function getFreePort() {
    return new Promise((resolve) => {
        const probe = net.createServer();
        probe.listen(0, '127.0.0.1', () => {
            const { port } = probe.address();
            probe.close(() => resolve(port));
        });
    });
}

/**
 * `forwardOut` routes to whichever destination server the test registered
 * for that host:port, connecting a real socket that stands in for the
 * ssh2 Channel. `forwardIn`/`unforwardIn`/the 'tcp connection' event are
 * driven by the test directly, since there is no real server to accept
 * an inbound remote forward from.
 */
function makeFakeClient({ forwardOutDelayMs = 0 } = {}) {
    const routes = new Map();
    const client = new EventEmitter();
    client.routeTo = (host, port, destinationPort) => routes.set(`${host}:${port}`, destinationPort);
    client.forwardOut = (srcIP, srcPort, dstHost, dstPort, cb) => {
        const destinationPort = routes.get(`${dstHost}:${dstPort}`);
        if (!destinationPort) { cb(new Error(`No route to ${dstHost}:${dstPort}`)); return; }
        // Delayed so a test can call stop() while this dial is still in
        // flight, the same window a real (slower) SSH round trip leaves open.
        setTimeout(() => {
            const socket = net.connect(destinationPort, '127.0.0.1');
            socket.once('connect', () => cb(null, socket));
            socket.once('error', (error) => cb(error));
        }, forwardOutDelayMs);
    };
    client.forwardIn = (address, listenPort, cb) => {
        client._forwardInCalls = client._forwardInCalls || [];
        client._forwardInCalls.push({ address, listenPort });
        if (client._forwardInResult) { cb(...client._forwardInResult); return; }
        cb(null, listenPort || 40000);
    };
    client.unforwardIn = (address, port, cb) => {
        client._unforwardInCalls = client._unforwardInCalls || [];
        client._unforwardInCalls.push({ address, port });
        cb(null);
    };
    return client;
}

function freshTunnels() {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'rt-test-tunnels-'));
    const electronStub = {
        app: { getPath: (what) => (what === 'userData' ? dir : os.tmpdir()), getVersion: () => '1.0.0', on: () => {} },
        safeStorage: {
            isEncryptionAvailable: () => false,
            encryptString: () => { throw new Error('unavailable'); },
            decryptString: () => { throw new Error('unavailable'); },
        },
        powerMonitor: { on: () => {} },
        MessageChannelMain: class {},
    };

    const realLoad = Module._load;
    Module._load = function (request, parent, isMain) {
        if (request === 'electron') return electronStub;
        return realLoad.call(this, request, parent, isMain);
    };
    try {
        for (const key of Object.keys(require.cache)) {
            if (key.includes(`${path.sep}main${path.sep}`)) delete require.cache[key];
        }
        return {
            tunnels: require(path.join(ROOT, 'tunnels')),
            ssh: require(path.join(ROOT, 'ssh')),
            store: require(path.join(ROOT, 'store')),
        };
    } finally {
        Module._load = realLoad;
    }
}

function withSession(ssh, tabId, client) {
    ssh.sessions.set(tabId, { client, hostId: 'h1', hostName: 'h1', address: 'h1:22' });
    return client;
}

const waitFor = async (predicate, { timeout = 2000, interval = 10 } = {}) => {
    const start = Date.now();
    while (!predicate()) {
        if (Date.now() - start > timeout) throw new Error('timed out waiting for condition');
        await new Promise((r) => setTimeout(r, interval));
    }
};

/* ------------------------------------------------------------------ *
 * sync() / autoStart()
 * ------------------------------------------------------------------ */

describe('tunnels: sync', () => {
    test('creates a stopped runtime for each configured tunnel', () => {
        const { tunnels, store } = freshTunnels();
        const h = store.saveHost({
            name: 'h1', host: 'h1.example.com',
            tunnels: [{ type: 'local', listenPort: 12345, destHost: 'db', destPort: 5432 }],
        });

        const list = tunnels.sync('t1', h.id);
        assert.strictEqual(list.length, 1);
        assert.strictEqual(list[0].state, 'stopped');
        assert.strictEqual(list[0].destHost, 'db');
    });

    test('a tunnel removed from the host config is stopped and dropped', () => {
        const { tunnels, store } = freshTunnels();
        const h = store.saveHost({
            name: 'h1', host: 'h1.example.com',
            tunnels: [{ id: 'a', type: 'local', listenPort: 12345, destHost: 'db', destPort: 5432 }],
        });
        tunnels.sync('t1', h.id);

        store.saveHost({ ...h, tunnels: [] });
        const list = tunnels.sync('t1', h.id);
        assert.strictEqual(list.length, 0);
    });

    test('a running tunnel whose definition changed is restarted with the new config', async () => {
        const { tunnels, store, ssh } = freshTunnels();
        withSession(ssh, 't1', makeFakeClient());
        const portA = await getFreePort();
        const portB = await getFreePort();
        const h = store.saveHost({
            name: 'h1', host: 'h1.example.com',
            tunnels: [{ id: 'a', type: 'local', listenPort: portA, destHost: 'db', destPort: 5432 }],
        });
        tunnels.sync('t1', h.id);
        tunnels.start('t1', 'a');
        await waitFor(() => tunnels.list('t1')[0].state === 'active');

        store.saveHost({ ...h, tunnels: [{ id: 'a', type: 'local', listenPort: portB, destHost: 'db', destPort: 5432 }] });
        tunnels.sync('t1', h.id);
        await waitFor(() => tunnels.list('t1')[0].listenPort === portB && tunnels.list('t1')[0].state === 'active');

        assert.strictEqual(tunnels.list('t1')[0].boundPort, portB);
        tunnels.stopAll('t1');
    });
});

describe('tunnels: autoStart', () => {
    test('only starts the tunnels marked autoStart', async () => {
        const { tunnels, store, ssh } = freshTunnels();
        withSession(ssh, 't1', makeFakeClient());
        const port = await getFreePort();
        const h = store.saveHost({
            name: 'h1', host: 'h1.example.com',
            tunnels: [
                { id: 'auto', type: 'local', listenPort: port, destHost: 'db', destPort: 5432, autoStart: true },
                { id: 'manual', type: 'local', listenPort: await getFreePort(), destHost: 'db', destPort: 5432, autoStart: false },
            ],
        });

        tunnels.autoStart('t1', h.id);
        await waitFor(() => tunnels.list('t1').find(t => t.id === 'auto').state === 'active');

        assert.strictEqual(tunnels.list('t1').find(t => t.id === 'manual').state, 'stopped');
        tunnels.stopAll('t1');
    });
});

/* ------------------------------------------------------------------ *
 * Local forwarding
 * ------------------------------------------------------------------ */

describe('tunnels: local forward', () => {
    test('a byte round trip through a real local listener, over the fake channel, to a real destination', async () => {
        const { tunnels, store, ssh } = freshTunnels();
        const client = withSession(ssh, 't1', makeFakeClient());
        const destination = await startDestination();
        client.routeTo('db', 5432, destination.port);

        const port = await getFreePort();
        const h = store.saveHost({
            name: 'h1', host: 'h1.example.com',
            tunnels: [{ id: 'a', type: 'local', listenPort: port, destHost: 'db', destPort: 5432 }],
        });
        tunnels.sync('t1', h.id);
        const started = tunnels.start('t1', 'a');
        assert.strictEqual(started.success, true);
        await waitFor(() => tunnels.list('t1')[0].state === 'active');

        const client1 = net.connect(port, '127.0.0.1');
        const reply = await new Promise((resolve, reject) => {
            client1.on('connect', () => client1.write('hello'));
            client1.on('data', (chunk) => resolve(chunk.toString()));
            client1.on('error', reject);
        });
        assert.strictEqual(reply, 'hello');

        await waitFor(() => tunnels.list('t1')[0].bytesUp >= 5 && tunnels.list('t1')[0].bytesDown >= 5);
        assert.strictEqual(tunnels.list('t1')[0].activeConnections, 1);

        client1.destroy();
        await waitFor(() => tunnels.list('t1')[0].activeConnections === 0);

        tunnels.stop('t1', 'a');
        await destination.close();
    });

    test('start() refuses an invalid config without ever opening a listener', () => {
        const { tunnels, store, ssh } = freshTunnels();
        withSession(ssh, 't1', makeFakeClient());
        const h = store.saveHost({
            name: 'h1', host: 'h1.example.com',
            tunnels: [{ id: 'a', type: 'local', listenPort: 12345, destHost: '', destPort: 5432 }],
        });
        tunnels.sync('t1', h.id);

        const result = tunnels.start('t1', 'a');
        assert.strictEqual(result.success, false);
        assert.match(result.message, /Destination host is required/);
        assert.strictEqual(tunnels.list('t1')[0].state, 'error');
    });

    test('start() refuses to run without a live SSH session', async () => {
        const { tunnels, store } = freshTunnels();
        const port = await getFreePort();
        const h = store.saveHost({
            name: 'h1', host: 'h1.example.com',
            tunnels: [{ id: 'a', type: 'local', listenPort: port, destHost: 'db', destPort: 5432 }],
        });
        tunnels.sync('t1', h.id);

        const result = tunnels.start('t1', 'a');
        assert.strictEqual(result.success, false);
        assert.match(result.message, /Not connected/);
    });

    test('a channel the destination refuses tears the local socket down without wedging the tunnel', async () => {
        const { tunnels, store, ssh } = freshTunnels();
        const client = withSession(ssh, 't1', makeFakeClient());
        // No route registered for db:5432, so forwardOut always errors.
        const port = await getFreePort();
        const h = store.saveHost({
            name: 'h1', host: 'h1.example.com',
            tunnels: [{ id: 'a', type: 'local', listenPort: port, destHost: 'db', destPort: 5432 }],
        });
        tunnels.sync('t1', h.id);
        tunnels.start('t1', 'a');
        await waitFor(() => tunnels.list('t1')[0].state === 'active');
        void client;

        const socket = net.connect(port, '127.0.0.1');
        await new Promise((resolve) => socket.on('close', resolve));

        assert.strictEqual(tunnels.list('t1')[0].activeConnections, 0);
        tunnels.stop('t1', 'a');
    });

    test('stop() closes the listener and drops active connections', async () => {
        const { tunnels, store, ssh } = freshTunnels();
        const client = withSession(ssh, 't1', makeFakeClient());
        const destination = await startDestination();
        client.routeTo('db', 5432, destination.port);
        const port = await getFreePort();
        const h = store.saveHost({
            name: 'h1', host: 'h1.example.com',
            tunnels: [{ id: 'a', type: 'local', listenPort: port, destHost: 'db', destPort: 5432 }],
        });
        tunnels.sync('t1', h.id);
        tunnels.start('t1', 'a');
        await waitFor(() => tunnels.list('t1')[0].state === 'active');

        const socket = net.connect(port, '127.0.0.1');
        await new Promise((resolve) => socket.on('connect', resolve));
        // Wait for the bridge, not just the client-side TCP handshake: the
        // server still has to dial the destination asynchronously. This test
        // is specifically about a *bridged* connection getting torn down;
        // stopping mid-dial is its own test below.
        await waitFor(() => tunnels.list('t1')[0].activeConnections === 1);

        const stopped = tunnels.stop('t1', 'a');
        assert.strictEqual(stopped.success, true);
        assert.strictEqual(tunnels.list('t1')[0].state, 'stopped');

        // The listener is gone: a fresh connection attempt is refused.
        await assert.rejects(() => new Promise((resolve, reject) => {
            const probe = net.connect(port, '127.0.0.1');
            probe.on('connect', resolve);
            probe.on('error', reject);
        }));

        await destination.close();
    });

    // A regression here doesn't fail fast: an un-cleaned-up connection makes
    // this test's own destination.close() (in the finally below) hang too,
    // since net.Server#close() waits for every open connection to end. An
    // explicit timeout is what turns that back into a reported failure
    // instead of a stuck CI job.
    test('stopping while a connection is still mid-dial does not leak it', { timeout: 5000 }, async () => {
        // Regression test: stop() used to only walk runtime.connections as it
        // existed at that moment. A connection whose forwardOut dial was still
        // in flight landed in that set *after* stop() had already run its
        // cleanup loop, so nothing ever destroyed it - the socket to the
        // destination lived for as long as the process did. Fixed via a
        // generation counter: every async step from a start() carries the
        // generation it began under, and checks it is still current before
        // touching the runtime.
        const { tunnels, store, ssh } = freshTunnels();
        const client = withSession(ssh, 't1', makeFakeClient({ forwardOutDelayMs: 100 }));
        const destination = await startDestination();
        // Closed in a finally: a wrong assertion here must not leave this
        // server open for the rest of the process's life - that is exactly
        // the shape of hang this test exists to catch in tunnels.js itself,
        // and it is just as capable of happening by accident in the test.
        try {
            client.routeTo('db', 5432, destination.port);
            const port = await getFreePort();
            const h = store.saveHost({
                name: 'h1', host: 'h1.example.com',
                tunnels: [{ id: 'a', type: 'local', listenPort: port, destHost: 'db', destPort: 5432 }],
            });
            tunnels.sync('t1', h.id);
            tunnels.start('t1', 'a');
            await waitFor(() => tunnels.list('t1')[0].state === 'active');

            const socket = net.connect(port, '127.0.0.1');
            await new Promise((resolve) => socket.on('connect', resolve));
            // The dial to the destination is still pending (forwardOutDelayMs):
            // stop() lands squarely inside the window that used to leak.
            assert.strictEqual(tunnels.list('t1')[0].activeConnections, 0);

            tunnels.stop('t1', 'a');

            // The destination has to stay reachable past forwardOutDelayMs, or
            // the stale dial fails for an unrelated reason (nothing listening)
            // and the bug never gets a chance to reproduce.
            await new Promise((r) => setTimeout(r, 200));

            // The TCP connect to the destination still completes - that part
            // isn't ours to prevent, the dial was already in flight - but it
            // must never have been bridged, and it must not still be open:
            // tunnels.js has to have destroyed it once it recognised the dial
            // as stale.
            assert.strictEqual(destination.totalConnections, 1);
            assert.strictEqual(destination.activeConnections, 0);
            assert.strictEqual(tunnels.list('t1')[0].activeConnections, 0);
        } finally {
            await destination.close();
        }
    });
});

/* ------------------------------------------------------------------ *
 * Dynamic forwarding (SOCKS5)
 * ------------------------------------------------------------------ */

describe('tunnels: dynamic forward (SOCKS5)', () => {
    async function socksHandshake(port, host, targetPort) {
        const socket = net.connect(port, '127.0.0.1');
        await new Promise((resolve) => socket.on('connect', resolve));

        socket.write(Buffer.from([0x05, 0x01, 0x00])); // version 5, 1 method, no-auth
        await new Promise((resolve) => socket.once('data', resolve)); // 05 00

        const hostBuf = Buffer.from(host, 'utf8');
        const request = Buffer.concat([
            Buffer.from([0x05, 0x01, 0x00, 0x03, hostBuf.length]),
            hostBuf,
            Buffer.from([targetPort >> 8, targetPort & 0xff]),
        ]);
        socket.write(request);
        const reply = await new Promise((resolve) => socket.once('data', resolve));
        return { socket, reply };
    }

    test('a CONNECT request is relayed to the named destination and the reply says OK', async () => {
        const { tunnels, store, ssh } = freshTunnels();
        const client = withSession(ssh, 't1', makeFakeClient());
        const destination = await startDestination();
        client.routeTo('example.com', 80, destination.port);

        const port = await getFreePort();
        const h = store.saveHost({
            name: 'h1', host: 'h1.example.com',
            tunnels: [{ id: 'a', type: 'dynamic', listenPort: port }],
        });
        tunnels.sync('t1', h.id);
        tunnels.start('t1', 'a');
        await waitFor(() => tunnels.list('t1')[0].state === 'active');

        const { socket, reply } = await socksHandshake(port, 'example.com', 80);
        assert.strictEqual(reply[1], 0x00); // SOCKS OK

        const echoed = await new Promise((resolve) => {
            socket.write('ping');
            socket.on('data', resolve);
        });
        assert.strictEqual(echoed.toString(), 'ping');

        socket.destroy();
        tunnels.stop('t1', 'a');
        await destination.close();
    });

    test('an unreachable destination gets a REFUSED reply, not a hang', async () => {
        const { tunnels, store, ssh } = freshTunnels();
        withSession(ssh, 't1', makeFakeClient()); // no routes registered

        const port = await getFreePort();
        const h = store.saveHost({
            name: 'h1', host: 'h1.example.com',
            tunnels: [{ id: 'a', type: 'dynamic', listenPort: port }],
        });
        tunnels.sync('t1', h.id);
        tunnels.start('t1', 'a');
        await waitFor(() => tunnels.list('t1')[0].state === 'active');

        const { reply } = await socksHandshake(port, 'nowhere.invalid', 80);
        assert.strictEqual(reply[1], 0x05); // SOCKS REFUSED

        tunnels.stop('t1', 'a');
    });
});

/* ------------------------------------------------------------------ *
 * Remote forwarding
 * ------------------------------------------------------------------ */

describe('tunnels: remote forward', () => {
    test('start() asks the server to bind, and records the port it actually assigned', async () => {
        const { tunnels, store, ssh } = freshTunnels();
        const client = withSession(ssh, 't1', makeFakeClient());
        client._forwardInResult = [null, 41234];

        const h = store.saveHost({
            name: 'h1', host: 'h1.example.com',
            tunnels: [{ id: 'a', type: 'remote', listenPort: 0, destHost: 'localhost', destPort: 3000 }],
        });
        tunnels.sync('t1', h.id);
        tunnels.start('t1', 'a');
        await waitFor(() => tunnels.list('t1')[0].state === 'active');

        assert.strictEqual(tunnels.list('t1')[0].boundPort, 41234);
        assert.strictEqual(client._forwardInCalls.length, 1);
    });

    test('a bind failure is reported with the common cause named', async () => {
        const { tunnels, store, ssh } = freshTunnels();
        const client = withSession(ssh, 't1', makeFakeClient());
        client._forwardInResult = [new Error('Administratively prohibited')];

        const h = store.saveHost({
            name: 'h1', host: 'h1.example.com',
            tunnels: [{ id: 'a', type: 'remote', listenPort: 9000, destHost: 'localhost', destPort: 3000 }],
        });
        tunnels.sync('t1', h.id);
        const started = tunnels.start('t1', 'a');
        assert.strictEqual(started.success, true); // starting is async; the error lands in state
        await waitFor(() => tunnels.list('t1')[0].state === 'error');

        assert.match(tunnels.list('t1')[0].message, /GatewayPorts yes/);
    });

    test('an inbound connection on the bound port is dialled to the destination and bridged', async () => {
        const { tunnels, store, ssh } = freshTunnels();
        const client = withSession(ssh, 't1', makeFakeClient());
        const destination = await startDestination();
        client._forwardInResult = [null, 9001];

        const h = store.saveHost({
            name: 'h1', host: 'h1.example.com',
            tunnels: [{ id: 'a', type: 'remote', listenPort: 0, destHost: '127.0.0.1', destPort: destination.port }],
        });
        tunnels.sync('t1', h.id);
        tunnels.start('t1', 'a');
        await waitFor(() => tunnels.list('t1')[0].state === 'active');

        const accepted = await new Promise((resolve) => {
            client.emit('tcp connection', { destPort: 9001 }, () => {
                const [d1, d2] = require('stream').duplexPair();
                resolve(d2);
                return d1;
            }, () => resolve(null));
        });

        assert.ok(accepted, 'expected the connection to be accepted');
        const echoed = await new Promise((resolve) => {
            accepted.write('remote-ping');
            accepted.on('data', resolve);
        });
        assert.strictEqual(echoed.toString(), 'remote-ping');

        tunnels.stop('t1', 'a');
        await destination.close();
    });

    test('a connection on a port with no matching active tunnel is rejected', async () => {
        const { tunnels, store, ssh } = freshTunnels();
        const client = withSession(ssh, 't1', makeFakeClient());
        client._forwardInResult = [null, 9002];

        const h = store.saveHost({
            name: 'h1', host: 'h1.example.com',
            tunnels: [{ id: 'a', type: 'remote', listenPort: 0, destHost: '127.0.0.1', destPort: 3000 }],
        });
        tunnels.sync('t1', h.id);
        tunnels.start('t1', 'a');
        await waitFor(() => tunnels.list('t1')[0].state === 'active');

        let rejected = false;
        client.emit('tcp connection', { destPort: 9999 }, () => { throw new Error('must not accept'); }, () => { rejected = true; });
        assert.strictEqual(rejected, true);
    });

    test('stop() unbinds the remote forward', async () => {
        const { tunnels, store, ssh } = freshTunnels();
        const client = withSession(ssh, 't1', makeFakeClient());
        client._forwardInResult = [null, 9003];

        const h = store.saveHost({
            name: 'h1', host: 'h1.example.com',
            tunnels: [{ id: 'a', type: 'remote', listenPort: 0, destHost: '127.0.0.1', destPort: 3000 }],
        });
        tunnels.sync('t1', h.id);
        tunnels.start('t1', 'a');
        await waitFor(() => tunnels.list('t1')[0].state === 'active');

        tunnels.stop('t1', 'a');
        assert.strictEqual(client._unforwardInCalls.length, 1);
        assert.strictEqual(client._unforwardInCalls[0].port, 9003);
    });
});

/* ------------------------------------------------------------------ *
 * Lifecycle
 * ------------------------------------------------------------------ */

describe('tunnels: startAll / stopAll / cleanup', () => {
    test('startAll and stopAll act on every tunnel for the tab', async () => {
        const { tunnels, store, ssh } = freshTunnels();
        withSession(ssh, 't1', makeFakeClient());
        const h = store.saveHost({
            name: 'h1', host: 'h1.example.com',
            tunnels: [
                { id: 'a', type: 'local', listenPort: await getFreePort(), destHost: 'db', destPort: 5432 },
                { id: 'b', type: 'local', listenPort: await getFreePort(), destHost: 'db', destPort: 5432 },
            ],
        });
        tunnels.sync('t1', h.id);

        tunnels.startAll('t1');
        await waitFor(() => tunnels.list('t1').every(t => t.state === 'active'));

        tunnels.stopAll('t1');
        await waitFor(() => tunnels.list('t1').every(t => t.state === 'stopped'));
    });

    test('cleanup drops everything for the tab, including the client listener', async () => {
        const { tunnels, store, ssh } = freshTunnels();
        const client = withSession(ssh, 't1', makeFakeClient());
        const h = store.saveHost({
            name: 'h1', host: 'h1.example.com',
            tunnels: [{ id: 'a', type: 'remote', listenPort: 0, destHost: '127.0.0.1', destPort: 3000 }],
        });
        tunnels.sync('t1', h.id);
        tunnels.start('t1', 'a');
        await waitFor(() => tunnels.list('t1')[0].state === 'active');
        assert.strictEqual(client.listenerCount('tcp connection'), 1);

        tunnels.cleanup('t1');
        assert.strictEqual(tunnels.list('t1').length, 0);
        assert.strictEqual(client.listenerCount('tcp connection'), 0);
    });
});
