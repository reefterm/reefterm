/**
 * Exercises transfers.js: upload/download of files and directory trees,
 * the conflict policies (ask/skip/rename/overwrite/resume, including
 * "apply to all"), cancellation (both a still-queued transfer and one
 * mid-copy), retry, the MAX_ACTIVE concurrency limit, and cleanup.
 *
 * `electron` is stubbed the same way tunnels.test.js/sftp.test.js do it.
 * The local side of every transfer is a real temp directory - uploads read
 * real files, downloads write real files - so `local-path.js`'s traversal
 * guard is exercised for real rather than assumed. The remote side is a
 * small in-memory fake SFTP filesystem, the same shape sftp.test.js's is
 * but trimmed to only what transfers.js actually calls (stat/mkdir/readdir/
 * realpath/createReadStream/createWriteStream - no need for rename/chmod/
 * symlink/etc here).
 */
const Module = require('module');
const fs = require('fs');
const path = require('path');
const os = require('os');
const assert = require('assert');
const { Readable, Writable } = require('stream');
const { describe, test } = require('node:test');

const ROOT = path.join(__dirname, '..', 'src', 'main');

/* ------------------------------------------------------------------ *
 * Fake remote filesystem
 * ------------------------------------------------------------------ */

function sftpError(code, message) {
    const error = new Error(message);
    error.code = code;
    return error;
}

function makeFakeRemoteFs() {
    const nodes = new Map();
    nodes.set('/', { type: 'dir', mode: 0o755, size: 0, mtime: 0 });

    const attrsOf = (node) => ({
        mode: (node.type === 'dir' ? 0o040000 : 0o100000) | (node.mode & 0o7777),
        size: node.size || 0,
        mtime: node.mtime || 0,
    });

    return {
        _nodes: nodes,
        _putFile(p, content, mode = 0o644) {
            nodes.set(p, { type: 'file', mode, size: Buffer.byteLength(content), mtime: 0, content: Buffer.from(content) });
        },
        _putDir(p, mode = 0o755) { nodes.set(p, { type: 'dir', mode, size: 0, mtime: 0 }); },

        stat(p, cb) {
            const node = nodes.get(p);
            if (!node) { cb(sftpError('ENOENT', `No such file: ${p}`)); return; }
            cb(null, attrsOf(node));
        },
        mkdir(p, cb) {
            if (nodes.has(p)) { cb(sftpError('EEXIST', 'File exists')); return; }
            nodes.set(p, { type: 'dir', mode: 0o755, size: 0, mtime: 0 });
            cb(null);
        },
        readdir(dirPath, cb) {
            const dirNode = nodes.get(dirPath);
            if (!dirNode || dirNode.type !== 'dir') { cb(sftpError('ENOTDIR', 'Not a directory')); return; }
            const prefix = dirPath === '/' ? '/' : `${dirPath}/`;
            const entries = [];
            for (const [p, node] of nodes) {
                if (p === dirPath || !p.startsWith(prefix)) continue;
                const rest = p.slice(prefix.length);
                if (rest.includes('/')) continue;
                entries.push({ filename: rest, attrs: attrsOf(node) });
            }
            cb(null, entries);
        },
        realpath(p, cb) { cb(null, p); },
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
                    nodes.set(p, { type: 'file', mode: opts.mode || 0o644, size: content.length, mtime: 0, content });
                    cb();
                },
            });
        },
        on() {},
    };
}

function makeFakeClient() {
    const remoteFs = makeFakeRemoteFs();
    return {
        remoteFs,
        sftp(cb) { setImmediate(() => cb(null, remoteFs)); },
    };
}

/** A remote write stream that trickles one byte at a time, for the mid-copy cancel test. */
function makeSlowFakeClient({ chunkDelayMs = 15 } = {}) {
    const client = makeFakeClient();
    const realCreateWriteStream = client.remoteFs.createWriteStream.bind(client.remoteFs);
    client.remoteFs.createWriteStream = (p, opts) => {
        const real = realCreateWriteStream(p, opts);
        return new Writable({
            write(chunk, enc, cb) { setTimeout(() => real.write(chunk, enc, cb), chunkDelayMs); },
            final(cb) { real.end(cb); },
            destroy(err, cb) { real.destroy(err); cb(err); },
        });
    };
    return client;
}

/* ------------------------------------------------------------------ *
 * Setup
 * ------------------------------------------------------------------ */

function freshTransfers() {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'rt-test-transfers-'));
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
            transfers: require(path.join(ROOT, 'transfers')),
            ssh: require(path.join(ROOT, 'ssh')),
            activity: require(path.join(ROOT, 'activity')),
        };
    } finally {
        Module._load = realLoad;
    }
}

function withSession(ssh, tabId, client) {
    ssh.sessions.set(tabId, { client, hostId: 'h1', hostName: 'h1', address: 'h1:22' });
    return client;
}

function tempLocalDir() {
    return fs.mkdtempSync(path.join(os.tmpdir(), 'rt-test-local-'));
}

const waitFor = async (predicate, { timeout = 2000, interval = 10 } = {}) => {
    const start = Date.now();
    while (!predicate()) {
        if (Date.now() - start > timeout) throw new Error('timed out waiting for condition');
        await new Promise((r) => setTimeout(r, interval));
    }
};

const waitFinished = (transfers, tabId, id) =>
    waitFor(() => {
        const t = transfers.list(tabId).find(x => x.id === id);
        return t && ['done', 'error', 'canceled'].includes(t.state);
    });

const findLast = (transfers, tabId, id) => transfers.list(tabId).find(x => x.id === id);

/* ------------------------------------------------------------------ *
 * Upload
 * ------------------------------------------------------------------ */

describe('transfers: upload', () => {
    test('a single file is copied to the remote path with the right content and mode', async () => {
        const { transfers, ssh, activity } = freshTransfers();
        const client = withSession(ssh, 't1', makeFakeClient());
        client.remoteFs._putDir('/remote');
        const localDir = tempLocalDir();
        fs.writeFileSync(path.join(localDir, 'a.txt'), 'hello world', { mode: 0o644 });

        const result = transfers.enqueue('t1', {
            direction: 'upload', sources: [path.join(localDir, 'a.txt')], destinationDir: '/remote',
        });
        assert.strictEqual(result.success, true);
        await waitFinished(transfers, 't1', result.ids[0]);

        const final = findLast(transfers, 't1', result.ids[0]);
        assert.strictEqual(final.state, 'done');
        assert.strictEqual(client.remoteFs._nodes.get('/remote/a.txt').content.toString(), 'hello world');

        const { entries } = activity.list({ category: 'files' });
        assert.ok(entries.some(e => e.action === 'file.upload' && e.outcome === 'success'));
    });

    test('a directory tree is replicated: subdirectories are created and files copied', async () => {
        const { transfers, ssh } = freshTransfers();
        const client = withSession(ssh, 't1', makeFakeClient());
        client.remoteFs._putDir('/remote');
        const localDir = tempLocalDir();
        fs.mkdirSync(path.join(localDir, 'src', 'sub'), { recursive: true });
        fs.writeFileSync(path.join(localDir, 'src', 'top.txt'), 'top');
        fs.writeFileSync(path.join(localDir, 'src', 'sub', 'nested.txt'), 'nested');

        const result = transfers.enqueue('t1', {
            direction: 'upload', sources: [path.join(localDir, 'src')], destinationDir: '/remote',
        });
        await waitFinished(transfers, 't1', result.ids[0]);

        assert.strictEqual(findLast(transfers, 't1', result.ids[0]).state, 'done');
        assert.strictEqual(client.remoteFs._nodes.get('/remote/src').type, 'dir');
        assert.strictEqual(client.remoteFs._nodes.get('/remote/src/top.txt').content.toString(), 'top');
        assert.strictEqual(client.remoteFs._nodes.get('/remote/src/sub/nested.txt').content.toString(), 'nested');
    });
});

/* ------------------------------------------------------------------ *
 * Download
 * ------------------------------------------------------------------ */

describe('transfers: download', () => {
    test('a single remote file lands intact in the local directory', async () => {
        const { transfers, ssh } = freshTransfers();
        const client = withSession(ssh, 't1', makeFakeClient());
        client.remoteFs._putFile('/remote/report.csv', 'a,b,c\n1,2,3');
        const localDir = tempLocalDir();

        const result = transfers.enqueue('t1', {
            direction: 'download', sources: ['/remote/report.csv'], destinationDir: localDir,
        });
        await waitFinished(transfers, 't1', result.ids[0]);

        assert.strictEqual(findLast(transfers, 't1', result.ids[0]).state, 'done');
        assert.strictEqual(fs.readFileSync(path.join(localDir, 'report.csv'), 'utf8'), 'a,b,c\n1,2,3');
    });

    test('a remote directory tree is replicated locally, and a hostile filename is sanitised', async () => {
        const { transfers, ssh } = freshTransfers();
        const client = withSession(ssh, 't1', makeFakeClient());
        client.remoteFs._putDir('/remote/pkg');
        client.remoteFs._putFile('/remote/pkg/readme.txt', 'read me');
        // A server-supplied name is not trusted: safeLocalSegment neuters the
        // separators before this ever reaches the local filesystem.
        client.remoteFs._putFile('/remote/pkg/..\\..\\evil.txt', 'should not escape');
        const localDir = tempLocalDir();

        const result = transfers.enqueue('t1', {
            direction: 'download', sources: ['/remote/pkg'], destinationDir: localDir,
        });
        await waitFinished(transfers, 't1', result.ids[0]);

        assert.strictEqual(findLast(transfers, 't1', result.ids[0]).state, 'done');
        assert.strictEqual(fs.readFileSync(path.join(localDir, 'pkg', 'readme.txt'), 'utf8'), 'read me');
        assert.strictEqual(fs.existsSync(path.join(localDir, '..', 'evil.txt')), false);
        // The sanitised name is still written, just inside the chosen folder.
        const files = fs.readdirSync(path.join(localDir, 'pkg'));
        assert.ok(files.some(f => f !== 'readme.txt'));
    });
});

/* ------------------------------------------------------------------ *
 * Conflicts
 * ------------------------------------------------------------------ */

describe('transfers: conflict policy', () => {
    test('"ask" blocks on a prompt, and "skip" leaves the existing file untouched', async () => {
        const { transfers, ssh } = freshTransfers();
        const client = withSession(ssh, 't1', makeFakeClient());
        client.remoteFs._putDir('/remote');
        client.remoteFs._putFile('/remote/a.txt', 'already there');
        const localDir = tempLocalDir();
        fs.writeFileSync(path.join(localDir, 'a.txt'), 'new content');

        let prompted = null;
        transfers.setNotifier((event, payload) => { if (event === 'sftp-conflict') prompted = payload; });

        const result = transfers.enqueue('t1', {
            direction: 'upload', sources: [path.join(localDir, 'a.txt')], destinationDir: '/remote', conflictPolicy: 'ask',
        });
        await waitFor(() => prompted !== null);
        assert.strictEqual(prompted.name, 'a.txt');

        transfers.resolveConflict(prompted.requestId, { action: 'skip' });
        await waitFinished(transfers, 't1', result.ids[0]);

        assert.strictEqual(findLast(transfers, 't1', result.ids[0]).state, 'done');
        assert.strictEqual(findLast(transfers, 't1', result.ids[0]).skippedFiles, 1);
        assert.strictEqual(client.remoteFs._nodes.get('/remote/a.txt').content.toString(), 'already there');
    });

    test('"rename" writes alongside the existing file with a " (2)" suffix', async () => {
        const { transfers, ssh } = freshTransfers();
        const client = withSession(ssh, 't1', makeFakeClient());
        client.remoteFs._putDir('/remote');
        client.remoteFs._putFile('/remote/a.txt', 'already there');
        const localDir = tempLocalDir();
        fs.writeFileSync(path.join(localDir, 'a.txt'), 'new content');

        transfers.setNotifier((event, payload) => {
            if (event === 'sftp-conflict') transfers.resolveConflict(payload.requestId, { action: 'rename' });
        });

        const result = transfers.enqueue('t1', {
            direction: 'upload', sources: [path.join(localDir, 'a.txt')], destinationDir: '/remote', conflictPolicy: 'ask',
        });
        await waitFinished(transfers, 't1', result.ids[0]);

        assert.strictEqual(client.remoteFs._nodes.get('/remote/a.txt').content.toString(), 'already there');
        assert.strictEqual(client.remoteFs._nodes.get('/remote/a (2).txt').content.toString(), 'new content');
    });

    test('"applyToAll" answers every later conflict in the same transfer without asking again', async () => {
        const { transfers, ssh } = freshTransfers();
        const client = withSession(ssh, 't1', makeFakeClient());
        client.remoteFs._putDir('/remote');
        client.remoteFs._putFile('/remote/src', ''); // placeholder, overwritten below as a dir
        client.remoteFs._nodes.delete('/remote/src');
        client.remoteFs._putDir('/remote/src');
        client.remoteFs._putFile('/remote/src/a.txt', 'old a');
        client.remoteFs._putFile('/remote/src/b.txt', 'old b');

        const localDir = tempLocalDir();
        fs.mkdirSync(path.join(localDir, 'src'));
        fs.writeFileSync(path.join(localDir, 'src', 'a.txt'), 'new a');
        fs.writeFileSync(path.join(localDir, 'src', 'b.txt'), 'new b');

        let prompts = 0;
        transfers.setNotifier((event, payload) => {
            if (event !== 'sftp-conflict') return;
            prompts += 1;
            transfers.resolveConflict(payload.requestId, { action: 'skip', applyToAll: true });
        });

        const result = transfers.enqueue('t1', {
            direction: 'upload', sources: [path.join(localDir, 'src')], destinationDir: '/remote', conflictPolicy: 'ask',
        });
        await waitFinished(transfers, 't1', result.ids[0]);

        assert.strictEqual(prompts, 1);
        assert.strictEqual(client.remoteFs._nodes.get('/remote/src/a.txt').content.toString(), 'old a');
        assert.strictEqual(client.remoteFs._nodes.get('/remote/src/b.txt').content.toString(), 'old b');
    });

    test('"resume" continues a partial file from its existing length', async () => {
        const { transfers, ssh } = freshTransfers();
        const client = withSession(ssh, 't1', makeFakeClient());
        client.remoteFs._putDir('/remote');
        client.remoteFs._putFile('/remote/a.txt', 'hello ');
        const localDir = tempLocalDir();
        fs.writeFileSync(path.join(localDir, 'a.txt'), 'hello world');

        const result = transfers.enqueue('t1', {
            direction: 'upload', sources: [path.join(localDir, 'a.txt')], destinationDir: '/remote', conflictPolicy: 'resume',
        });
        await waitFinished(transfers, 't1', result.ids[0]);

        assert.strictEqual(client.remoteFs._nodes.get('/remote/a.txt').content.toString(), 'hello world');
    });
});

/* ------------------------------------------------------------------ *
 * Cancellation
 * ------------------------------------------------------------------ */

describe('transfers: cancel', () => {
    test('cancelling a still-queued transfer settles it immediately, with no copy attempted', async () => {
        const { transfers, ssh } = freshTransfers();
        const client = withSession(ssh, 't1', makeSlowFakeClient({ chunkDelayMs: 200 }));
        client.remoteFs._putDir('/remote');
        const localDir = tempLocalDir();
        // Two large-ish files so the first two fill MAX_ACTIVE and the third
        // is genuinely left queued to cancel.
        for (const name of ['a.txt', 'b.txt', 'c.txt']) {
            fs.writeFileSync(path.join(localDir, name), 'x'.repeat(50));
        }

        const result = transfers.enqueue('t1', {
            direction: 'upload',
            sources: ['a.txt', 'b.txt', 'c.txt'].map(n => path.join(localDir, n)),
            destinationDir: '/remote',
        });
        const thirdId = result.ids[2];
        assert.strictEqual(findLast(transfers, 't1', thirdId).state, 'queued');

        const canceled = transfers.cancel(thirdId);
        assert.strictEqual(canceled.success, true);
        assert.strictEqual(findLast(transfers, 't1', thirdId).state, 'canceled');
        assert.strictEqual(client.remoteFs._nodes.has('/remote/c.txt'), false);

        transfers.cancelAll('t1');
    });

    test('cancelling an active transfer tears down its streams and settles as canceled', async () => {
        const { transfers, ssh } = freshTransfers();
        const client = withSession(ssh, 't1', makeSlowFakeClient({ chunkDelayMs: 30 }));
        client.remoteFs._putDir('/remote');
        const localDir = tempLocalDir();
        fs.writeFileSync(path.join(localDir, 'big.txt'), 'x'.repeat(4096));

        const result = transfers.enqueue('t1', {
            direction: 'upload', sources: [path.join(localDir, 'big.txt')], destinationDir: '/remote',
        });
        const id = result.ids[0];
        await waitFor(() => findLast(transfers, 't1', id).state === 'running');

        transfers.cancel(id);
        await waitFinished(transfers, 't1', id);

        assert.strictEqual(findLast(transfers, 't1', id).state, 'canceled');
    });
});

/* ------------------------------------------------------------------ *
 * Retry
 * ------------------------------------------------------------------ */

describe('transfers: retry', () => {
    test('retrying a failed transfer resets it and switches "ask" to "resume"', async () => {
        const { transfers, ssh } = freshTransfers();
        const client = withSession(ssh, 't1', makeFakeClient());
        // mkdirRecursive auto-creates a missing directory ("-p" semantics), so
        // a destination that merely doesn't exist yet is not enough to make
        // this fail. A *file* sitting where the directory needs to go is:
        // mkdirRecursive finds it, sees it is not a directory, and throws.
        client.remoteFs._putFile('/remote', 'not a directory');
        const localDir = tempLocalDir();
        fs.writeFileSync(path.join(localDir, 'a.txt'), 'content');

        const result = transfers.enqueue('t1', {
            direction: 'upload', sources: [path.join(localDir, 'a.txt')], destinationDir: '/remote', conflictPolicy: 'ask',
        });
        await waitFinished(transfers, 't1', result.ids[0]);
        assert.strictEqual(findLast(transfers, 't1', result.ids[0]).state, 'error');

        client.remoteFs._nodes.delete('/remote');
        client.remoteFs._putDir('/remote');
        const retried = transfers.retry(result.ids[0]);
        assert.strictEqual(retried.success, true);
        await waitFinished(transfers, 't1', result.ids[0]);

        assert.strictEqual(findLast(transfers, 't1', result.ids[0]).state, 'done');
        assert.strictEqual(client.remoteFs._nodes.get('/remote/a.txt').content.toString(), 'content');
    });

    test('refuses to retry a transfer that is already running', async () => {
        const { transfers, ssh } = freshTransfers();
        const client = withSession(ssh, 't1', makeSlowFakeClient({ chunkDelayMs: 100 }));
        client.remoteFs._putDir('/remote');
        const localDir = tempLocalDir();
        fs.writeFileSync(path.join(localDir, 'a.txt'), 'x'.repeat(2048));

        const result = transfers.enqueue('t1', {
            direction: 'upload', sources: [path.join(localDir, 'a.txt')], destinationDir: '/remote',
        });
        await waitFor(() => findLast(transfers, 't1', result.ids[0]).state === 'running');

        const retried = transfers.retry(result.ids[0]);
        assert.strictEqual(retried.success, false);

        transfers.cancel(result.ids[0]);
    });
});

/* ------------------------------------------------------------------ *
 * Concurrency
 * ------------------------------------------------------------------ */

describe('transfers: concurrency', () => {
    test('at most MAX_ACTIVE transfers run at once; the rest wait their turn', async () => {
        const { transfers, ssh } = freshTransfers();
        const client = withSession(ssh, 't1', makeSlowFakeClient({ chunkDelayMs: 40 }));
        client.remoteFs._putDir('/remote');
        const localDir = tempLocalDir();
        const names = ['a.txt', 'b.txt', 'c.txt', 'd.txt'];
        for (const name of names) fs.writeFileSync(path.join(localDir, name), 'x'.repeat(200));

        const result = transfers.enqueue('t1', {
            direction: 'upload', sources: names.map(n => path.join(localDir, n)), destinationDir: '/remote',
        });

        await waitFor(() => {
            const active = transfers.list('t1').filter(t => ['scanning', 'running'].includes(t.state)).length;
            return active >= 1;
        });
        const activeCount = transfers.list('t1').filter(t => ['scanning', 'running'].includes(t.state)).length;
        assert.ok(activeCount <= 2, `expected at most 2 active transfers, got ${activeCount}`);
        assert.ok(transfers.list('t1').some(t => t.state === 'queued'));

        await Promise.all(result.ids.map(id => waitFinished(transfers, 't1', id)));
        assert.ok(result.ids.every(id => findLast(transfers, 't1', id).state === 'done'));
    });
});

/* ------------------------------------------------------------------ *
 * Cleanup
 * ------------------------------------------------------------------ */

describe('transfers: clearFinished / cancelAll / cleanup', () => {
    test('clearFinished drops only finished transfers for the tab', async () => {
        const { transfers, ssh } = freshTransfers();
        const client = withSession(ssh, 't1', makeFakeClient());
        client.remoteFs._putDir('/remote');
        const localDir = tempLocalDir();
        fs.writeFileSync(path.join(localDir, 'a.txt'), 'x');

        const result = transfers.enqueue('t1', {
            direction: 'upload', sources: [path.join(localDir, 'a.txt')], destinationDir: '/remote',
        });
        await waitFinished(transfers, 't1', result.ids[0]);

        transfers.clearFinished('t1');
        assert.strictEqual(transfers.list('t1').length, 0);
    });

    test('cancelAll cancels every unfinished transfer for the tab, and releases its conflict prompts', async () => {
        const { transfers, ssh } = freshTransfers();
        const client = withSession(ssh, 't1', makeSlowFakeClient({ chunkDelayMs: 100 }));
        client.remoteFs._putDir('/remote');
        const localDir = tempLocalDir();
        fs.writeFileSync(path.join(localDir, 'a.txt'), 'x'.repeat(2048));
        fs.writeFileSync(path.join(localDir, 'b.txt'), 'x'.repeat(2048));

        const result = transfers.enqueue('t1', {
            direction: 'upload',
            sources: [path.join(localDir, 'a.txt'), path.join(localDir, 'b.txt')],
            destinationDir: '/remote',
        });

        transfers.cancelAll('t1');
        await Promise.all(result.ids.map(id => waitFinished(transfers, 't1', id)));
        assert.ok(result.ids.every(id => findLast(transfers, 't1', id).state === 'canceled'));
    });

    test('cleanup drops everything for the tab and destroys any active stream', async () => {
        const { transfers, ssh } = freshTransfers();
        const client = withSession(ssh, 't1', makeSlowFakeClient({ chunkDelayMs: 100 }));
        client.remoteFs._putDir('/remote');
        const localDir = tempLocalDir();
        fs.writeFileSync(path.join(localDir, 'a.txt'), 'x'.repeat(2048));

        transfers.enqueue('t1', { direction: 'upload', sources: [path.join(localDir, 'a.txt')], destinationDir: '/remote' });
        await waitFor(() => transfers.list('t1')[0]?.state === 'running');

        transfers.cleanup('t1');
        assert.strictEqual(transfers.list('t1').length, 0);
    });
});

/* ------------------------------------------------------------------ *
 * enqueue validation
 * ------------------------------------------------------------------ */

describe('transfers: enqueue validation', () => {
    test('refuses an empty source list', () => {
        const { transfers } = freshTransfers();
        const result = transfers.enqueue('t1', { direction: 'upload', sources: [], destinationDir: '/remote' });
        assert.strictEqual(result.success, false);
    });

    test('refuses with no destination given', () => {
        const { transfers } = freshTransfers();
        const result = transfers.enqueue('t1', { direction: 'upload', sources: ['/local/a.txt'] });
        assert.strictEqual(result.success, false);
    });
});
