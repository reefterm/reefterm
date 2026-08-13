/**
 * Exercises sftp.js: listing (including symlink resolution), the mutation
 * operations (mkdir -p, delete-recursive, chmod -R, remote-to-remote
 * copy/move with the exec('cp') fast path and its streaming fallback), and
 * the subsystem handle's open/reopen lifecycle.
 *
 * `electron` is stubbed the same way ssh.test.js does it, since sftp.js
 * pulls in ssh.js which pulls in store.js. There is no `ssh2` stub here:
 * sftp.js only ever reaches an SFTP handle through `ssh.sessions`, so the
 * session's `client`/`sftp` are just plain fakes set directly on that Map -
 * no real ssh2.Client is ever constructed.
 *
 * The fake SFTP handle is a small in-memory POSIX filesystem: real enough to
 * exercise readdir/stat/lstat/mkdir/rename/chmod/readlink/symlink/unlink/
 * rmdir and real Node streams for createReadStream/createWriteStream,
 * without needing a real server.
 */
const Module = require('module');
const path = require('path');
const fs = require('fs');
const os = require('os');
const assert = require('assert');
const { Readable, Writable } = require('stream');
const { describe, test } = require('node:test');

const ROOT = path.join(__dirname, '..', 'src', 'main');

/* ------------------------------------------------------------------ *
 * Fake SFTP filesystem
 * ------------------------------------------------------------------ */

function sftpError(code, message) {
    const error = new Error(message);
    error.code = code;
    return error;
}

/** `sharedNodes` lets two handles opened at different times act on the same backing filesystem. */
function makeFakeSftp(sharedNodes) {
    const nodes = sharedNodes || new Map([['/', { type: 'dir', mode: 0o755, size: 0, mtime: 0, atime: 0 }]]);
    let nextHandle = 1;

    function resolve(p, followLinks, depth = 0) {
        if (depth > 20) throw sftpError('ELOOP', 'Too many levels of symbolic links');
        const node = nodes.get(p);
        if (!node) throw sftpError('ENOENT', `No such file: ${p}`);
        if (followLinks && node.type === 'symlink') {
            const target = node.target.startsWith('/')
                ? node.target
                : path.posix.join(path.posix.dirname(p), node.target);
            return resolve(target, true, depth + 1);
        }
        return node;
    }

    function attrsOf(node) {
        const kind = node.type === 'dir' ? 0o040000 : node.type === 'symlink' ? 0o120000 : 0o100000;
        return {
            mode: kind | (node.mode & 0o7777),
            size: node.size || 0,
            mtime: node.mtime || 0,
            atime: node.atime || 0,
            uid: 0,
            gid: 0,
        };
    }

    return {
        _nodes: nodes,
        _put(p, node) { nodes.set(p, node); },

        readdir(dirPath, cb) {
            try {
                const dirNode = resolve(dirPath, true);
                if (dirNode.type !== 'dir') { cb(sftpError('ENOTDIR', 'Not a directory')); return; }
                const prefix = dirPath === '/' ? '/' : `${dirPath}/`;
                const entries = [];
                for (const [p, node] of nodes) {
                    if (p === dirPath || !p.startsWith(prefix)) continue;
                    const rest = p.slice(prefix.length);
                    if (rest.includes('/')) continue;
                    entries.push({ filename: rest, attrs: attrsOf(node) });
                }
                cb(null, entries);
            } catch (error) { cb(error); }
        },
        stat(p, cb) {
            try { cb(null, attrsOf(resolve(p, true))); } catch (error) { cb(error); }
        },
        lstat(p, cb) {
            try { cb(null, attrsOf(resolve(p, false))); } catch (error) { cb(error); }
        },
        realpath(p, cb) {
            try { resolve(p, true); cb(null, p); } catch (error) { cb(error); }
        },
        mkdir(p, cb) {
            if (nodes.has(p)) { cb(sftpError('EEXIST', 'File exists')); return; }
            const parent = nodes.get(path.posix.dirname(p));
            if (!parent || parent.type !== 'dir') { cb(sftpError('ENOENT', 'No such file or directory')); return; }
            nodes.set(p, { type: 'dir', mode: 0o755, size: 0, mtime: 0, atime: 0 });
            cb(null);
        },
        open(p, flags, cb) {
            if (flags === 'wx' && nodes.has(p)) { cb(sftpError('EEXIST', 'File exists')); return; }
            if (!nodes.has(p)) nodes.set(p, { type: 'file', mode: 0o644, size: 0, mtime: 0, atime: 0, content: Buffer.alloc(0) });
            const handle = nextHandle++;
            cb(null, handle);
        },
        close(handle, cb) { cb(null); },
        rename(oldPath, newPath, cb) {
            if (!nodes.has(oldPath)) { cb(sftpError('ENOENT', 'No such file')); return; }
            if (nodes.has(newPath)) { cb(sftpError('EEXIST', 'File exists')); return; }
            for (const [p, node] of [...nodes]) {
                if (p !== oldPath && !p.startsWith(`${oldPath}/`)) continue;
                nodes.delete(p);
                nodes.set(newPath + p.slice(oldPath.length), node);
            }
            cb(null);
        },
        chmod(p, mode, cb) {
            const node = nodes.get(p);
            if (!node) { cb(sftpError('ENOENT', 'No such file')); return; }
            node.mode = mode;
            cb(null);
        },
        readlink(p, cb) {
            const node = nodes.get(p);
            if (!node || node.type !== 'symlink') { cb(sftpError('EINVAL', 'Not a symlink')); return; }
            cb(null, node.target);
        },
        symlink(target, p, cb) {
            nodes.set(p, { type: 'symlink', mode: 0o777, target, size: target.length, mtime: 0, atime: 0 });
            cb(null);
        },
        unlink(p, cb) {
            if (!nodes.has(p)) { cb(sftpError('ENOENT', 'No such file')); return; }
            nodes.delete(p);
            cb(null);
        },
        rmdir(p, cb) {
            const node = nodes.get(p);
            if (!node || node.type !== 'dir') { cb(sftpError('ENOTDIR', 'Not a directory')); return; }
            const prefix = `${p}/`;
            for (const key of nodes.keys()) {
                if (key.startsWith(prefix)) { cb(sftpError('ENOTEMPTY', 'Directory not empty')); return; }
            }
            nodes.delete(p);
            cb(null);
        },
        ext_openssh_statvfs(p, cb) {
            if (!nodes.has(p)) { cb(sftpError('ENOENT', 'No such file')); return; }
            cb(null, { f_frsize: 4096, f_blocks: 1000, f_bavail: 500 });
        },
        createReadStream(p, opts = {}) {
            const node = nodes.get(p);
            if (!node) {
                const r = new Readable({ read() {} });
                process.nextTick(() => r.emit('error', sftpError('ENOENT', 'No such file')));
                return r;
            }
            const start = opts.start || 0;
            const data = node.content.subarray(start);
            return Readable.from(data.length ? [data] : [Buffer.alloc(0)]);
        },
        createWriteStream(p, opts = {}) {
            const flags = opts.flags || 'w';
            const chunks = [];
            return new Writable({
                write(chunk, enc, cb) { chunks.push(chunk); cb(); },
                final(cb) {
                    const existing = flags === 'a' && nodes.has(p) ? nodes.get(p).content : Buffer.alloc(0);
                    const content = Buffer.concat([existing, ...chunks]);
                    nodes.set(p, {
                        type: 'file', mode: opts.mode || 0o644, size: content.length,
                        mtime: 0, atime: 0, content,
                    });
                    cb();
                },
            });
        },
        on() {},
    };
}

function makeFakeClient({ execHandler = null } = {}) {
    const nodes = new Map([['/', { type: 'dir', mode: 0o755, size: 0, mtime: 0, atime: 0 }]]);
    return {
        // Stable handle for test setup (`_put`), backed by the same nodes
        // every `.sftp()` call below hands out a fresh wrapper over.
        sftpHandle: makeFakeSftp(nodes),
        sftp(cb) {
            // Deferred, not synchronous: opening a real SFTP subsystem is
            // always a network round trip. A synchronous callback here let
            // init()'s `session.sftpOpening = null` (set inside the
            // callback) run before the *outer* `session.sftpOpening = new
            // Promise(...)` assignment had finished, so the outer one
            // silently overwrote it with an already-resolved promise -
            // every later reopen then short-circuited on that stale promise
            // instead of calling .sftp() again. Not a bug in sftp.js: ssh2
            // itself can never call back this fast.
            setImmediate(() => cb(null, makeFakeSftp(nodes)));
        },
        exec(command, cb) {
            if (!execHandler) { cb(new Error('exec not supported by this fake')); return; }
            execHandler(command, cb);
        },
    };
}

/** Loads a fresh sftp.js (plus ssh.js, same instance) under a stubbed electron. */
function freshSftp() {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'rt-test-sftp-'));
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
        return { sftp: require(path.join(ROOT, 'sftp')), ssh: require(path.join(ROOT, 'ssh')) };
    } finally {
        Module._load = realLoad;
    }
}

/** Registers a tab with a live fake client, so sftp.init() can open a handle. */
function withSession(ssh, tabId, client) {
    ssh.sessions.set(tabId, { client, sftp: null, hostId: 'h1', hostName: 'h1', address: 'h1:22' });
    return client;
}

const file = (content = '', mode = 0o644) =>
    ({ type: 'file', mode, size: Buffer.byteLength(content), mtime: 0, atime: 0, content: Buffer.from(content) });
const dir = (mode = 0o755) => ({ type: 'dir', mode, size: 0, mtime: 0, atime: 0 });
const symlink = (target) => ({ type: 'symlink', mode: 0o777, target, size: target.length, mtime: 0, atime: 0 });

/* ------------------------------------------------------------------ *
 * Handle lifecycle
 * ------------------------------------------------------------------ */

describe('sftp: handle lifecycle', () => {
    test('init fails cleanly with no SSH session at all', async () => {
        const { sftp } = freshSftp();
        const result = await sftp.init('nope');
        assert.strictEqual(result.success, false);
        assert.match(result.message, /No SSH connection/);
    });

    test('init opens the subsystem once and reuses it on a second call', async () => {
        const { sftp, ssh } = freshSftp();
        const client = withSession(ssh, 't1', makeFakeClient());
        let opens = 0;
        const realSftp = client.sftp.bind(client);
        client.sftp = (cb) => { opens += 1; realSftp(cb); };

        assert.strictEqual((await sftp.init('t1')).success, true);
        assert.strictEqual((await sftp.init('t1')).success, true);
        assert.strictEqual(opens, 1);
    });

    test('two callers racing to open the subsystem share the same in-flight attempt', async () => {
        const { sftp, ssh } = freshSftp();
        const client = withSession(ssh, 't1', makeFakeClient());
        let opens = 0;
        const realSftp = client.sftp.bind(client);
        client.sftp = (cb) => { opens += 1; setImmediate(() => realSftp(cb)); };

        const [a, b] = await Promise.all([sftp.init('t1'), sftp.init('t1')]);
        assert.strictEqual(a.success, true);
        assert.strictEqual(b.success, true);
        assert.strictEqual(opens, 1);
    });

    test('a channel that goes away is transparently reopened on the next call', async () => {
        const { sftp, ssh } = freshSftp();
        withSession(ssh, 't1', makeFakeClient());
        await sftp.init('t1');

        const session = ssh.sessions.get('t1');
        const dropped = session.sftp;
        session.sftp.emit = undefined; // not used, just marking it dead below
        session.sftp = null; // simulates the 'close'/'end'/'error' handler firing

        const result = await sftp.list('t1', '/');
        assert.strictEqual(result.success, true);
        assert.notStrictEqual(ssh.sessions.get('t1').sftp, dropped);
    });

    test('close() ends the handle and clears it from the session', () => {
        const { sftp, ssh } = freshSftp();
        withSession(ssh, 't1', makeFakeClient());
        const handle = { ended: false, end() { this.ended = true; } };
        ssh.sessions.get('t1').sftp = handle;

        assert.strictEqual(sftp.close('t1').success, true);
        assert.strictEqual(handle.ended, true);
        assert.strictEqual(ssh.sessions.get('t1').sftp, null);
    });
});

/* ------------------------------------------------------------------ *
 * Listing
 * ------------------------------------------------------------------ */

describe('sftp: list', () => {
    test('lists a directory, flattening ssh2 attrs to the IPC shape', async () => {
        const { sftp, ssh } = freshSftp();
        const client = withSession(ssh, 't1', makeFakeClient());
        client.sftpHandle._put('/a.txt', file('hello', 0o644));
        client.sftpHandle._put('/sub', dir());

        const result = await sftp.list('t1', '/');
        assert.strictEqual(result.success, true);
        const names = result.files.map(f => f.name).sort();
        assert.deepStrictEqual(names, ['a.txt', 'sub']);
        const entry = result.files.find(f => f.name === 'a.txt');
        assert.strictEqual(entry.isDirectory, false);
        assert.strictEqual(entry.size, 5);
        assert.strictEqual(entry.permissions, 0o644);
    });

    test('resolves a symlink to a directory, following it', async () => {
        const { sftp, ssh } = freshSftp();
        const client = withSession(ssh, 't1', makeFakeClient());
        client.sftpHandle._put('/real', dir());
        client.sftpHandle._put('/link', symlink('/real'));

        const result = await sftp.list('t1', '/');
        const link = result.files.find(f => f.name === 'link');
        assert.strictEqual(link.isSymlink, true);
        assert.strictEqual(link.linkTarget, '/real');
        assert.strictEqual(link.targetIsDirectory, true);
    });

    test('a broken symlink is reported rather than failing the whole listing', async () => {
        const { sftp, ssh } = freshSftp();
        const client = withSession(ssh, 't1', makeFakeClient());
        client.sftpHandle._put('/dangling', symlink('/does-not-exist'));

        const result = await sftp.list('t1', '/');
        assert.strictEqual(result.success, true);
        const link = result.files.find(f => f.name === 'dangling');
        assert.strictEqual(link.broken, true);
    });

    test('a listing failure is reported rather than thrown', async () => {
        const { sftp, ssh } = freshSftp();
        withSession(ssh, 't1', makeFakeClient());

        const result = await sftp.list('t1', '/nope');
        assert.strictEqual(result.success, false);
    });
});

describe('sftp: home / realpath / stat', () => {
    test('stat follows a symlink by default, and lstat does not', async () => {
        const { sftp, ssh } = freshSftp();
        const client = withSession(ssh, 't1', makeFakeClient());
        client.sftpHandle._put('/real', file('hi'));
        client.sftpHandle._put('/link', symlink('/real'));

        const followed = await sftp.stat('t1', '/link');
        assert.strictEqual(followed.stats.isSymlink, false);

        const notFollowed = await sftp.stat('t1', '/link', { follow: false });
        assert.strictEqual(notFollowed.stats.isSymlink, true);
    });
});

/* ------------------------------------------------------------------ *
 * Mutations
 * ------------------------------------------------------------------ */

describe('sftp: mkdir (recursive)', () => {
    test('creates every missing ancestor', async () => {
        const { sftp, ssh } = freshSftp();
        const client = withSession(ssh, 't1', makeFakeClient());

        const result = await sftp.mkdir('t1', '/a/b/c');
        assert.strictEqual(result.success, true);
        assert.strictEqual(client.sftpHandle._nodes.get('/a').type, 'dir');
        assert.strictEqual(client.sftpHandle._nodes.get('/a/b').type, 'dir');
        assert.strictEqual(client.sftpHandle._nodes.get('/a/b/c').type, 'dir');
    });

    test('refuses to walk through a path segment that is a file', async () => {
        const { sftp, ssh } = freshSftp();
        const client = withSession(ssh, 't1', makeFakeClient());
        client.sftpHandle._put('/a', file('not a directory'));

        const result = await sftp.mkdir('t1', '/a/b');
        assert.strictEqual(result.success, false);
        assert.match(result.message, /is not a directory/);
    });
});

describe('sftp: createFile', () => {
    test('creates an empty file and never overwrites an existing one', async () => {
        const { sftp, ssh } = freshSftp();
        const client = withSession(ssh, 't1', makeFakeClient());

        assert.strictEqual((await sftp.createFile('t1', '/new.txt')).success, true);
        assert.strictEqual(client.sftpHandle._nodes.get('/new.txt').type, 'file');

        const second = await sftp.createFile('t1', '/new.txt');
        assert.strictEqual(second.success, false);
    });
});

describe('sftp: chmod', () => {
    test('changes a single file', async () => {
        const { sftp, ssh } = freshSftp();
        const client = withSession(ssh, 't1', makeFakeClient());
        client.sftpHandle._put('/a.txt', file('x', 0o644));

        await sftp.chmod('t1', '/a.txt', 0o600);
        assert.strictEqual(client.sftpHandle._nodes.get('/a.txt').mode, 0o600);
    });

    test('recursive chmod walks a directory tree but never follows a symlink into it', async () => {
        const { sftp, ssh } = freshSftp();
        const client = withSession(ssh, 't1', makeFakeClient());
        client.sftpHandle._put('/dir', dir(0o755));
        client.sftpHandle._put('/dir/a.txt', file('x', 0o644));
        client.sftpHandle._put('/dir/link', symlink('/dir/a.txt'));
        client.sftpHandle._put('/outside', file('untouched', 0o644));

        await sftp.chmod('t1', '/dir', 0o700, { recursive: true });

        assert.strictEqual(client.sftpHandle._nodes.get('/dir').mode, 0o700);
        assert.strictEqual(client.sftpHandle._nodes.get('/dir/a.txt').mode, 0o700);
        // The symlink's own mode is left alone: chmodTree returns as soon as
        // isLinkMode is true, before calling chmod on it.
        assert.strictEqual(client.sftpHandle._nodes.get('/dir/link').mode, 0o777);
        assert.strictEqual(client.sftpHandle._nodes.get('/outside').mode, 0o644);
    });
});

describe('sftp: remove', () => {
    test('deletes a file', async () => {
        const { sftp, ssh } = freshSftp();
        const client = withSession(ssh, 't1', makeFakeClient());
        client.sftpHandle._put('/a.txt', file('x'));

        const result = await sftp.remove('t1', ['/a.txt']);
        assert.strictEqual(result.success, true);
        assert.strictEqual(client.sftpHandle._nodes.has('/a.txt'), false);
    });

    test('empties a directory depth-first before removing it', async () => {
        const { sftp, ssh } = freshSftp();
        const client = withSession(ssh, 't1', makeFakeClient());
        client.sftpHandle._put('/dir', dir());
        client.sftpHandle._put('/dir/sub', dir());
        client.sftpHandle._put('/dir/sub/a.txt', file('x'));

        const result = await sftp.remove('t1', ['/dir']);
        assert.strictEqual(result.success, true);
        assert.strictEqual(client.sftpHandle._nodes.has('/dir'), false);
        assert.strictEqual(client.sftpHandle._nodes.has('/dir/sub'), false);
    });

    test('unlinks a symlink rather than deleting what it points to', async () => {
        const { sftp, ssh } = freshSftp();
        const client = withSession(ssh, 't1', makeFakeClient());
        client.sftpHandle._put('/real', file('keep me'));
        client.sftpHandle._put('/link', symlink('/real'));

        await sftp.remove('t1', ['/link']);
        assert.strictEqual(client.sftpHandle._nodes.has('/link'), false);
        assert.strictEqual(client.sftpHandle._nodes.has('/real'), true);
    });

    test('one failure does not stop the rest, and both are reported', async () => {
        const { sftp, ssh } = freshSftp();
        const client = withSession(ssh, 't1', makeFakeClient());
        client.sftpHandle._put('/exists.txt', file('x'));

        const result = await sftp.remove('t1', ['/missing.txt', '/exists.txt']);
        assert.strictEqual(result.success, false);
        assert.strictEqual(result.deleted, 1);
        assert.strictEqual(client.sftpHandle._nodes.has('/exists.txt'), false);
    });
});

describe('sftp: diskUsage', () => {
    test('reports total and free bytes when the server supports the extension', async () => {
        const { sftp, ssh } = freshSftp();
        withSession(ssh, 't1', makeFakeClient());

        const result = await sftp.diskUsage('t1', '/');
        assert.strictEqual(result.success, true);
        assert.strictEqual(result.total, 4096 * 1000);
        assert.strictEqual(result.free, 4096 * 500);
    });

    test('fails soft when the server does not advertise the extension', async () => {
        const { sftp, ssh } = freshSftp();
        const client = withSession(ssh, 't1', makeFakeClient());
        // Patched on the handle as it is actually handed out: `.sftp()` gives
        // a fresh wrapper each call, so `client.sftpHandle` (test setup only)
        // is not the instance diskUsage() will end up calling.
        const openSftp = client.sftp.bind(client);
        client.sftp = (cb) => openSftp((err, handle) => {
            if (handle) handle.ext_openssh_statvfs = () => { throw new Error('unsupported'); };
            cb(err, handle);
        });

        const result = await sftp.diskUsage('t1', '/');
        assert.strictEqual(result.success, false);
    });
});

/* ------------------------------------------------------------------ *
 * Remote-to-remote copy / move
 * ------------------------------------------------------------------ */

describe('sftp: transferRemote', () => {
    test('a copy prefers the server-side cp and never touches SFTP for the bytes', async () => {
        const { sftp, ssh } = freshSftp();
        const execCommands = [];
        const client = withSession(ssh, 't1', makeFakeClient({
            execHandler: (command, cb) => {
                execCommands.push(command);
                const stream = new (require('events').EventEmitter)();
                stream.stderr = new (require('events').EventEmitter)();
                cb(null, stream);
                process.nextTick(() => stream.emit('close', 0));
            },
        }));
        client.sftpHandle._put('/src.txt', file('hello'));
        client.sftpHandle._put('/dst', dir());

        const result = await sftp.transferRemote('t1', ['/src.txt'], '/dst');
        assert.strictEqual(result.success, true);
        assert.strictEqual(execCommands.length, 1);
        assert.match(execCommands[0], /^cp -a --/);
        // Never actually written through SFTP: no file node exists yet, the
        // fake exec just reported success without touching the filesystem.
        assert.strictEqual(client.sftpHandle._nodes.has('/dst/src.txt'), false);
    });

    test('falls back to a streaming copy when the server has no cp (exit 127)', async () => {
        const { sftp, ssh } = freshSftp();
        const client = withSession(ssh, 't1', makeFakeClient({
            execHandler: (command, cb) => {
                const stream = new (require('events').EventEmitter)();
                stream.stderr = new (require('events').EventEmitter)();
                cb(null, stream);
                process.nextTick(() => stream.emit('close', 127));
            },
        }));
        client.sftpHandle._put('/src.txt', file('hello'));
        client.sftpHandle._put('/dst', dir());

        const result = await sftp.transferRemote('t1', ['/src.txt'], '/dst');
        assert.strictEqual(result.success, true);
        const copied = client.sftpHandle._nodes.get('/dst/src.txt');
        assert.strictEqual(copied.content.toString(), 'hello');
    });

    test('a name collision in the destination is given a " (2)" suffix, not overwritten', async () => {
        const { sftp, ssh } = freshSftp();
        const client = withSession(ssh, 't1', makeFakeClient({
            execHandler: (command, cb) => {
                const stream = new (require('events').EventEmitter)();
                stream.stderr = new (require('events').EventEmitter)();
                cb(null, stream);
                process.nextTick(() => stream.emit('close', 127));
            },
        }));
        client.sftpHandle._put('/src.txt', file('new'));
        client.sftpHandle._put('/dst', dir());
        client.sftpHandle._put('/dst/src.txt', file('already here'));

        const result = await sftp.transferRemote('t1', ['/src.txt'], '/dst');
        assert.strictEqual(result.success, true);
        assert.strictEqual(client.sftpHandle._nodes.get('/dst/src.txt').content.toString(), 'already here');
        assert.strictEqual(client.sftpHandle._nodes.get('/dst/src (2).txt').content.toString(), 'new');
    });

    test('a move renames in place when the destination is on the same host, and skips a no-op move', async () => {
        const { sftp, ssh } = freshSftp();
        const client = withSession(ssh, 't1', makeFakeClient());
        client.sftpHandle._put('/a.txt', file('x'));
        client.sftpHandle._put('/dst', dir());
        client.sftpHandle._put('/dst/already-there.txt', file('y'));

        const result = await sftp.transferRemote('t1', ['/a.txt', '/dst/already-there.txt'], '/dst', { move: true });
        assert.strictEqual(result.success, true);
        assert.strictEqual(client.sftpHandle._nodes.has('/a.txt'), false);
        assert.strictEqual(client.sftpHandle._nodes.get('/dst/a.txt').content.toString(), 'x');
        // Already in the destination directory: left untouched, not renamed onto itself.
        assert.strictEqual(client.sftpHandle._nodes.get('/dst/already-there.txt').content.toString(), 'y');
    });
});
