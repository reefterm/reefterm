/**
 * Exercises sync-connection.js against a small in-memory fake server that
 * mirrors reefterm/sync-server's actual behavior closely enough to verify
 * the request/response handling: URLs, headers, status-code branching, and
 * error parsing. `electron` is stubbed so it runs under plain node.
 */
const Module = require('module');
const path = require('path');
const fs = require('fs');
const os = require('os');
const assert = require('assert');

const ROOT = path.join(__dirname, '..', 'src', 'main');
let userData = fs.mkdtempSync(path.join(os.tmpdir(), 'cb-test-sync-conn-'));

/** A fresh fake server: enough of reefterm/sync-server's behavior to test against. */
function createFakeServer() {
    const users = new Map(); // email -> { userId, password, wrappedPassphrase, wrappedRecovery }
    const sessions = new Map(); // token -> userId
    const snapshots = new Map(); // userId -> { revision, payload, stats, deviceName }
    const recoveryTokens = new Map(); // token -> { email, used }
    let nextId = 1;
    let nextRecoveryToken = 1;

    const respond = (status, payload) => ({
        ok: status >= 200 && status < 300,
        status,
        text: async () => (payload === null ? '' : JSON.stringify(payload)),
    });

    const userByID = (userId) => [...users.entries()].find(([, v]) => v.userId === userId);

    return async function fakeFetch(url, options = {}) {
        const u = new URL(url);
        const method = options.method || 'GET';
        const routePath = u.pathname;
        const body = options.body ? JSON.parse(options.body) : null;
        const authHeader = (options.headers && options.headers.Authorization) || '';
        const token = authHeader.startsWith('Bearer ') ? authHeader.slice(7) : null;
        const userId = token ? sessions.get(token) : null;

        if (method === 'POST' && routePath === '/api/v1/register') {
            if (users.has(body.email)) return respond(409, { error: { message: 'already exists' } });
            const id = `user-${nextId++}`;
            users.set(body.email, {
                userId: id,
                password: body.login_password,
                wrappedPassphrase: body.wrapped_key_passphrase,
                wrappedRecovery: body.wrapped_key_recovery,
            });
            const newToken = `token-${id}-${Math.random()}`;
            sessions.set(newToken, id);
            return respond(201, { user_id: id, session_token: newToken, expires_at: new Date().toISOString() });
        }

        if (method === 'POST' && routePath === '/api/v1/login') {
            const user = users.get(body.email);
            if (!user || user.password !== body.login_password) {
                return respond(401, { error: { message: 'incorrect email or password' } });
            }
            const newToken = `token-${user.userId}-${Math.random()}`;
            sessions.set(newToken, user.userId);
            return respond(200, { user_id: user.userId, session_token: newToken, expires_at: new Date().toISOString() });
        }

        if (method === 'POST' && routePath === '/api/v1/logout') {
            sessions.delete(token);
            return respond(204, null);
        }

        if (method === 'POST' && routePath === '/api/v1/recover/start') {
            const generic = { message: 'If that email has an account, recovery instructions have been sent to it.' };
            const user = users.get(body.email);
            if (user) {
                // Invalidate any earlier unused token for this account, same as the real server.
                for (const [t, entry] of recoveryTokens) {
                    if (entry.email === body.email && !entry.used) recoveryTokens.delete(t);
                }
                const recoveryToken = `recovery-token-${nextRecoveryToken++}`;
                recoveryTokens.set(recoveryToken, { email: body.email, used: false });
                fakeFetch.lastRecoveryToken = recoveryToken;
            }
            return respond(200, generic);
        }

        if (method === 'POST' && routePath === '/api/v1/recover/keys') {
            const entry = recoveryTokens.get(body.token);
            if (!entry || entry.used) return respond(401, { error: { message: 'invalid or expired recovery link' } });
            const user = users.get(entry.email);
            return respond(200, { wrapped_key_recovery: user.wrappedRecovery });
        }

        if (method === 'POST' && routePath === '/api/v1/recover/complete') {
            const entry = recoveryTokens.get(body.token);
            if (!entry || entry.used) return respond(401, { error: { message: 'invalid or expired recovery link' } });
            entry.used = true;

            const user = users.get(entry.email);
            user.password = body.new_login_password;
            user.wrappedPassphrase = body.wrapped_key_passphrase;
            user.wrappedRecovery = body.wrapped_key_recovery;

            // Revoke every existing session for this account, same as the real server.
            for (const [t, uid] of sessions) {
                if (uid === user.userId) sessions.delete(t);
            }

            const newToken = `token-${user.userId}-${Math.random()}`;
            sessions.set(newToken, user.userId);
            return respond(200, { user_id: user.userId, session_token: newToken, expires_at: new Date().toISOString() });
        }

        if (!userId && !routePath.startsWith('/api/v1/recover/')
            && routePath !== '/api/v1/register' && routePath !== '/api/v1/login') {
            return respond(401, { error: { message: 'missing or invalid session' } });
        }

        if (method === 'GET' && routePath === '/api/v1/account') {
            const entry = userByID(userId);
            return respond(200, { user_id: userId, email: entry ? entry[0] : '', created_at: new Date().toISOString() });
        }

        if (method === 'PUT' && routePath === '/api/v1/account/password') {
            const entry = userByID(userId);
            if (!entry || entry[1].password !== body.current_login_password) {
                return respond(401, { error: { message: 'current password is incorrect' } });
            }
            entry[1].password = body.new_login_password;
            entry[1].wrappedPassphrase = body.wrapped_key_passphrase;
            return respond(204, null);
        }

        if (method === 'GET' && routePath === '/api/v1/sync/keys') {
            const entry = userByID(userId);
            return respond(200, {
                wrapped_key_passphrase: entry[1].wrappedPassphrase,
                wrapped_key_recovery: entry[1].wrappedRecovery,
            });
        }

        if (method === 'PUT' && routePath === '/api/v1/sync/keys/recovery') {
            const entry = userByID(userId);
            entry[1].wrappedRecovery = body.envelope;
            return respond(204, null);
        }

        if (method === 'GET' && routePath === '/api/v1/sync/snapshot/meta') {
            const snap = snapshots.get(userId);
            if (!snap) return respond(200, { exists: false, revision: 0 });
            return respond(200, { exists: true, revision: snap.revision, size_bytes: 0 });
        }

        if (method === 'GET' && routePath === '/api/v1/sync/snapshot') {
            const snap = snapshots.get(userId);
            if (!snap) return respond(404, { error: { message: 'nothing saved yet' } });
            return respond(200, { payload: snap.payload, revision: snap.revision });
        }

        if (method === 'POST' && routePath === '/api/v1/sync/snapshot') {
            const existing = snapshots.get(userId);
            const currentRev = existing ? existing.revision : 0;
            if (currentRev !== body.base_revision) {
                return respond(409, { error: { message: 'another device saved first', revision: currentRev } });
            }
            const nextRev = currentRev + 1;
            snapshots.set(userId, {
                revision: nextRev, payload: body.payload, stats: body.stats, deviceName: body.device_name,
            });
            return respond(200, { revision: nextRev });
        }

        return respond(404, { error: { message: `no such route: ${method} ${routePath}` } });
    };
}

// The stub's fetch delegates to whichever fake server the current test
// installed, so each test can have its own isolated in-memory backend.
let currentFetch = createFakeServer();

const electronStub = {
    app: { getPath: () => userData, getVersion: () => '1.0.0' },
    safeStorage: {
        isEncryptionAvailable: () => false,
        encryptString: () => { throw new Error('unavailable'); },
        decryptString: () => { throw new Error('unavailable'); },
    },
    net: { fetch: (...args) => currentFetch(...args) },
};

const realLoad = Module._load;
Module._load = function (request, parent, isMain) {
    if (request === 'electron') return electronStub;
    return realLoad.call(this, request, parent, isMain);
};

const fresh = () => {
    for (const key of Object.keys(require.cache)) {
        if (key.includes(`${path.sep}main${path.sep}`)) delete require.cache[key];
    }
    return require(path.join(ROOT, 'sync-connection.js'));
};

/** A clean slate: a fresh fake server, a fresh userData dir, a fresh module. */
function reset() {
    currentFetch = createFakeServer();
    userData = fs.mkdtempSync(path.join(os.tmpdir(), 'cb-test-sync-conn-'));
    return fresh();
}

let passed = 0;
const checkAsync = async (label, fn) => {
    try {
        await fn();
        console.log(`  ok   ${label}`);
        passed++;
    } catch (error) {
        console.log(`  FAIL ${label}`);
        console.log(`       ${error.message}`);
        process.exitCode = 1;
    }
};

// Wrapped in an async IIFE: this file is CommonJS, not a module, so
// top-level await isn't available -- same pattern cloud-snapshot.test.js
// uses for the same reason.
(async () => {

/* ---------------- configure ---------------- */

console.log('\nsync-connection: configuring a server');

await checkAsync('rejects an empty address', async () => {
    const sc = reset();
    assert.throws(() => sc.configure(''));
});

await checkAsync('rejects an address with no scheme', async () => {
    const sc = reset();
    assert.throws(() => sc.configure('sync.example.com'));
});

await checkAsync('accepts and normalizes a trailing slash', async () => {
    const sc = reset();
    const status = sc.configure('https://sync.example.com/');
    assert.strictEqual(status.serverUrl, 'https://sync.example.com');
});

/* ---------------- register ---------------- */

console.log('\nsync-connection: registering');

await checkAsync('register connects and returns a recovery code once', async () => {
    const sc = reset();
    sc.configure('https://sync.example.com');

    const { status, recoveryCode } = await sc.register('alice@example.com', 'a good passphrase');

    assert.strictEqual(status.connected, true);
    assert.strictEqual(status.unlocked, true);
    assert.strictEqual(status.email, 'alice@example.com');
    assert.match(recoveryCode, /^[0-9A-Z-]+$/);
});

await checkAsync('refuses to register with no server configured', async () => {
    const sc = reset();
    await assert.rejects(() => sc.register('alice@example.com', 'a good passphrase'));
});

await checkAsync('the server rejects a duplicate email', async () => {
    const sc = reset();
    sc.configure('https://sync.example.com');
    await sc.register('dup@example.com', 'a good passphrase');
    await assert.rejects(() => sc.register('dup@example.com', 'a different passphrase'));
});

/* ---------------- login ---------------- */

console.log('\nsync-connection: logging in');

await checkAsync('a second device logs in and unlocks with the same passphrase', async () => {
    const server = createFakeServer();
    currentFetch = server;

    userData = fs.mkdtempSync(path.join(os.tmpdir(), 'cb-test-sync-conn-'));
    const deviceA = fresh();
    deviceA.configure('https://sync.example.com');
    await deviceA.register('shared@example.com', 'a good passphrase');

    userData = fs.mkdtempSync(path.join(os.tmpdir(), 'cb-test-sync-conn-'));
    const deviceB = fresh();
    deviceB.configure('https://sync.example.com');
    const status = await deviceB.login('shared@example.com', 'a good passphrase');

    assert.strictEqual(status.connected, true);
    assert.strictEqual(status.unlocked, true);
});

await checkAsync('rejects the wrong password', async () => {
    const sc = reset();
    sc.configure('https://sync.example.com');
    await sc.register('bob@example.com', 'a good passphrase');
    await sc.logout();

    await assert.rejects(() => sc.login('bob@example.com', 'the wrong passphrase entirely'));
});

/* ---------------- logout ---------------- */

console.log('\nsync-connection: logging out');

await checkAsync('clears connection state but keeps the configured server', async () => {
    const sc = reset();
    sc.configure('https://sync.example.com');
    await sc.register('logout@example.com', 'a good passphrase');

    const { status, revoked } = await sc.logout();

    assert.strictEqual(revoked, true, 'the fake server should have accepted the revoke');
    assert.strictEqual(status.connected, false);
    assert.strictEqual(status.unlocked, false);
    assert.strictEqual(status.serverUrl, 'https://sync.example.com');
});

/* ---------------- recovery ---------------- */

console.log('\nsync-connection: recovery code');

await checkAsync('unlocks with the recovery code and rotates it', async () => {
    const sc = reset();
    sc.configure('https://sync.example.com');
    const { recoveryCode: firstCode } = await sc.register('recover@example.com', 'a good passphrase');

    const { status, recoveryCode: secondCode } = await sc.unlockWithRecoveryCode(firstCode);

    assert.strictEqual(status.unlocked, true);
    assert.ok(secondCode, 'a new recovery code should be issued');
    assert.notStrictEqual(secondCode, firstCode);
});

await checkAsync('the old recovery code no longer works after rotation', async () => {
    const sc = reset();
    sc.configure('https://sync.example.com');
    const { recoveryCode: firstCode } = await sc.register('recover2@example.com', 'a good passphrase');
    await sc.unlockWithRecoveryCode(firstCode);

    await assert.rejects(() => sc.unlockWithRecoveryCode(firstCode));
});

/* ---------------- changing the passphrase ---------------- */

console.log('\nsync-connection: changing the passphrase');

await checkAsync('the new passphrase logs in; the old one no longer does', async () => {
    const sc = reset();
    sc.configure('https://sync.example.com');
    await sc.register('change@example.com', 'the old passphrase');

    await sc.changePassphrase('the old passphrase', 'the new passphrase');
    await sc.logout();

    await assert.rejects(() => sc.login('change@example.com', 'the old passphrase'));
    const status = await sc.login('change@example.com', 'the new passphrase');
    assert.strictEqual(status.unlocked, true);
});

/* ---------------- email-based recovery, from a fully logged-out state ---------------- */

console.log('\nsync-connection: email-based recovery');

await checkAsync('recovers with the token and the recovery code, and logs in fresh', async () => {
    const sc = reset();
    sc.configure('https://sync.example.com');
    const { recoveryCode } = await sc.register('forgot@example.com', 'the forgotten passphrase');
    await sc.logout();

    await sc.recoverStart('forgot@example.com');
    const emailToken = currentFetch.lastRecoveryToken;

    const { status, recoveryCode: newCode } = await sc.recoverComplete(
        'forgot@example.com', emailToken, recoveryCode, 'a brand new passphrase',
    );

    assert.strictEqual(status.connected, true);
    assert.strictEqual(status.unlocked, true);
    assert.ok(newCode, 'a fresh recovery code should be issued');
    assert.notStrictEqual(newCode, recoveryCode);
});

await checkAsync('the recovered passphrase logs in afterward; the old one does not', async () => {
    const sc = reset();
    sc.configure('https://sync.example.com');
    const { recoveryCode } = await sc.register('forgot2@example.com', 'the forgotten passphrase');
    await sc.logout();

    await sc.recoverStart('forgot2@example.com');
    const emailToken = currentFetch.lastRecoveryToken;
    await sc.recoverComplete('forgot2@example.com', emailToken, recoveryCode, 'a brand new passphrase');
    await sc.logout();

    await assert.rejects(() => sc.login('forgot2@example.com', 'the forgotten passphrase'));
    const status = await sc.login('forgot2@example.com', 'a brand new passphrase');
    assert.strictEqual(status.unlocked, true);
});

await checkAsync('rejects the wrong recovery code even with a valid email token', async () => {
    const sc = reset();
    sc.configure('https://sync.example.com');
    await sc.register('forgot3@example.com', 'the forgotten passphrase');
    await sc.logout();

    await sc.recoverStart('forgot3@example.com');
    const emailToken = currentFetch.lastRecoveryToken;

    await assert.rejects(
        () => sc.recoverComplete('forgot3@example.com', emailToken, 'WRONG-CODE-ENTIRELY-HERE-XX', 'a new passphrase'),
    );
});

await checkAsync('rejects an invalid or already-used email token', async () => {
    const sc = reset();
    sc.configure('https://sync.example.com');
    const { recoveryCode } = await sc.register('forgot4@example.com', 'the forgotten passphrase');
    await sc.logout();

    await assert.rejects(() => sc.recoverComplete('forgot4@example.com', 'not-a-real-token', recoveryCode, 'x'));

    await sc.recoverStart('forgot4@example.com');
    const emailToken = currentFetch.lastRecoveryToken;
    await sc.recoverComplete('forgot4@example.com', emailToken, recoveryCode, 'a new passphrase');

    // The same token, used again, must not work a second time.
    await assert.rejects(
        () => sc.recoverComplete('forgot4@example.com', emailToken, recoveryCode, 'yet another passphrase'),
    );
});

/* ---------------- snapshot ---------------- */

console.log('\nsync-connection: the synced snapshot');

await checkAsync('meta reports nothing saved for a fresh account', async () => {
    const sc = reset();
    sc.configure('https://sync.example.com');
    await sc.register('fresh@example.com', 'a good passphrase');

    const meta = await sc.snapshotMeta();
    assert.strictEqual(meta.exists, false);
});

await checkAsync('push then pull round trips the payload untouched', async () => {
    const sc = reset();
    sc.configure('https://sync.example.com');
    await sc.register('snap@example.com', 'a good passphrase');

    const push = await sc.snapshotPut({
        payload: { cipher: 'opaque-ciphertext' }, baseRevision: 0, deviceName: 'laptop', stats: { hosts: 2 },
    });
    assert.strictEqual(push.conflict, false);
    assert.strictEqual(push.revision, 1);

    const pulled = await sc.snapshotGet();
    assert.deepStrictEqual(pulled.payload, { cipher: 'opaque-ciphertext' });
    assert.strictEqual(pulled.revision, 1);
});

await checkAsync('a stale base revision reports a conflict with the current revision', async () => {
    const sc = reset();
    sc.configure('https://sync.example.com');
    await sc.register('conflict@example.com', 'a good passphrase');

    await sc.snapshotPut({ payload: { v: 1 }, baseRevision: 0 });

    const result = await sc.snapshotPut({ payload: { v: 2 }, baseRevision: 0 });
    assert.strictEqual(result.conflict, true);
    assert.strictEqual(result.revision, 1);
});

console.log(`\n${passed} checks passed${process.exitCode ? ', with failures above' : ''}`);

})();
