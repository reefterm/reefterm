/**
 * Exercises plugins/host.js and host-runtime.js: the prototype for actually
 * running a plugin's own code, in a separate process, behind a boundary that
 * is enforced rather than assumed.
 *
 * Real child processes throughout, on purpose - the entire point is proving
 * the isolation holds under Node's real `--permission` flag and this app's
 * own require-patching, not asserting against a description of what they
 * are supposed to do. Slower than a typical unit test file (each test forks
 * a real Node process); that cost is what makes the results mean something.
 *
 * Two isolation claims are tested separately, deliberately:
 *
 *   - "does forking with `--permission` and nothing granted actually stop
 *     fs/child_process" is tested against a bare probe script, independent
 *     of anything in this app, so a bug in host-runtime.js's require-patch
 *     could never hide a bug in how host.js invokes Node.
 *   - "does a real plugin, going through the normal path, get refused the
 *     same way" is tested through createPluginHost() end to end, which is
 *     what a plugin actually experiences.
 */
const { fork } = require('child_process');
const fs = require('fs');
const path = require('path');
const os = require('os');
const assert = require('assert');
const { describe, test, afterEach } = require('node:test');
const { createPluginHost } = require('../src/main/plugins/host');

const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'rt-test-plugin-host-'));
let fileCounter = 0;

/** Writes a plugin (or probe script) to a real file, since fork() needs a path. */
function writeScript(code) {
    fileCounter += 1;
    const file = path.join(tmpDir, `script-${fileCounter}.js`);
    fs.writeFileSync(file, code);
    return file;
}

const hosts = [];
function freshHost() {
    const host = createPluginHost();
    hosts.push(host);
    return host;
}

afterEach(async () => {
    await Promise.all(hosts.splice(0).map(host => host.stopAll()));
});

/* ------------------------------------------------------------------ *
 * The runtime-enforced boundary itself, independent of this app's code
 * ------------------------------------------------------------------ */

describe('the --permission flag, forked exactly as host.js forks it', () => {
    function forkProbe(code) {
        return new Promise((resolve) => {
            const child = fork(writeScript(code), [], {
                env: {},
                execArgv: ['--permission'],
                stdio: ['ignore', 'pipe', 'pipe', 'ipc'],
            });
            let output = '';
            child.stdout.on('data', (chunk) => { output += chunk; });
            child.on('exit', (code_) => resolve({ code: code_, output }));
        });
    }

    test('a filesystem read outside any --allow-fs-read grant is refused by the runtime', async () => {
        const { output } = await forkProbe(`
            try {
                require('fs').readFileSync(${JSON.stringify(__filename)}, 'utf8');
                console.log('READ_SUCCEEDED');
            } catch (error) {
                console.log('READ_BLOCKED:' + error.code);
            }
        `);
        assert.match(output, /READ_BLOCKED:ERR_ACCESS_DENIED/);
    });

    test('spawning a process is refused by the runtime', async () => {
        const { output } = await forkProbe(`
            try {
                require('child_process').execSync('echo hi');
                console.log('SPAWN_SUCCEEDED');
            } catch (error) {
                console.log('SPAWN_BLOCKED:' + error.code);
            }
        `);
        assert.match(output, /SPAWN_BLOCKED:ERR_ACCESS_DENIED/);
    });
});

/* ------------------------------------------------------------------ *
 * The capability protocol: what a plugin can actually accomplish
 * ------------------------------------------------------------------ */

describe('plugin host: capability grants', () => {
    test('a granted capability round-trips real data through the parent process', async () => {
        const host = freshHost();
        host.registerCapability('double', async (n) => n * 2);

        const entry = writeScript(`
            module.exports = {
                activate: async ({ call }) => {
                    const result = await call('double', 21);
                    if (result !== 42) throw new Error('expected 42, got ' + result);
                },
            };
        `);

        await assert.doesNotReject(host.start({ id: 'a', entryFile: entry, capabilities: ['double'] }));
    });

    test('calling a capability the plugin was not granted is refused locally, without reaching the handler', async () => {
        const host = freshHost();
        let handlerCalled = false;
        host.registerCapability('secret', async () => { handlerCalled = true; return 'nope'; });
        host.registerCapability('probe', async () => 'ok'); // something to grant instead

        const entry = writeScript(`
            module.exports = {
                activate: async ({ call }) => {
                    try {
                        await call('secret');
                        throw new Error('should have been refused');
                    } catch (error) {
                        if (!/was not granted/.test(error.message)) throw error;
                    }
                },
            };
        `);

        await assert.doesNotReject(host.start({ id: 'a', entryFile: entry, capabilities: ['probe'] }));
        assert.strictEqual(handlerCalled, false);
    });

    test('start() refuses to grant a capability that was never registered, before forking anything', async () => {
        const host = freshHost();
        const entry = writeScript('module.exports = { activate: async () => {} };');

        await assert.rejects(
            host.start({ id: 'a', entryFile: entry, capabilities: ['does-not-exist'] }),
            /unknown capability/
        );
        assert.deepStrictEqual(host.list(), []);
    });

    test('two plugins do not share capability grants', async () => {
        const host = freshHost();
        host.registerCapability('onlyForA', async () => 'a-secret');

        const grantedEntry = writeScript(`
            module.exports = { activate: async ({ call }) => { await call('onlyForA'); } };
        `);
        const notGrantedEntry = writeScript(`
            module.exports = {
                activate: async ({ call }) => {
                    try {
                        await call('onlyForA');
                        throw new Error('should have been refused');
                    } catch (error) {
                        if (!/was not granted/.test(error.message)) throw error;
                    }
                },
            };
        `);

        await assert.doesNotReject(host.start({ id: 'a', entryFile: grantedEntry, capabilities: ['onlyForA'] }));
        await assert.doesNotReject(host.start({ id: 'b', entryFile: notGrantedEntry, capabilities: [] }));
    });
});

describe('plugin host: isolation from inside a normal plugin', () => {
    test('a plugin cannot require("fs")', async () => {
        const host = freshHost();
        const entry = writeScript(`
            module.exports = { activate: async () => { require('fs'); } };
        `);
        await assert.rejects(
            host.start({ id: 'a', entryFile: entry, capabilities: [] }),
            /Plugins cannot require\("fs"\)/
        );
    });

    test('a plugin cannot require("child_process")', async () => {
        const host = freshHost();
        const entry = writeScript(`
            module.exports = { activate: async () => { require('child_process'); } };
        `);
        await assert.rejects(
            host.start({ id: 'a', entryFile: entry, capabilities: [] }),
            /Plugins cannot require\("child_process"\)/
        );
    });

    test('a plugin cannot require("net"), even though --permission does not cover networking', async () => {
        const host = freshHost();
        const entry = writeScript(`
            module.exports = { activate: async () => { require('net'); } };
        `);
        await assert.rejects(
            host.start({ id: 'a', entryFile: entry, capabilities: [] }),
            /Plugins cannot require\("net"\)/
        );
    });

    test('a plugin cannot require("electron")', async () => {
        const host = freshHost();
        const entry = writeScript(`
            module.exports = { activate: async () => { require('electron'); } };
        `);
        await assert.rejects(
            host.start({ id: 'a', entryFile: entry, capabilities: [] }),
            /Plugins cannot require\("electron"\)/
        );
    });

    test('ordinary computation still works: a plugin is not a bare shell with nothing in it', async () => {
        const host = freshHost();
        let reported;
        host.registerCapability('report', async (value) => { reported = value; });

        const entry = writeScript(`
            const path = require('path');
            module.exports = {
                activate: async ({ call }) => { await call('report', path.join('a', 'b')); },
            };
        `);

        await host.start({ id: 'a', entryFile: entry, capabilities: ['report'] });
        assert.strictEqual(reported, path.join('a', 'b'));
    });
});

/* ------------------------------------------------------------------ *
 * Crashes and lifecycle
 * ------------------------------------------------------------------ */

describe('plugin host: crashes and lifecycle', () => {
    test('a plugin that throws during activation rejects start(), with the real message', async () => {
        const host = freshHost();
        const entry = writeScript(`
            module.exports = { activate: async () => { throw new Error('deliberate activation failure'); } };
        `);
        await assert.rejects(host.start({ id: 'a', entryFile: entry, capabilities: [] }), /deliberate activation failure/);
    });

    test('a plugin that crashes after starting is reported, not left silently dead', async () => {
        const host = freshHost();
        host.registerCapability('crashMe', async () => { throw new Error('handler side is fine, this is the plugin\'s own crash'); });

        const events = [];
        host.setNotifier((event, payload) => events.push({ event, payload }));

        const entry = writeScript(`
            module.exports = {
                activate: async ({ call }) => {
                    // Fires and forgets: the crash happens on an unawaited
                    // rejection, after activate() has already resolved and
                    // start() has already settled successfully.
                    setTimeout(() => { throw new Error('crashed after ready'); }, 10);
                },
            };
        `);

        await host.start({ id: 'a', entryFile: entry, capabilities: [] });
        await new Promise((resolve) => setTimeout(resolve, 200));

        assert.strictEqual(host.status('a').state, 'crashed');
        assert.ok(events.some(e => e.event === 'plugin-crash' && e.payload.id === 'a'));
    });

    test('stop() ends the process and a repeat stop() is a harmless no-op', async () => {
        const host = freshHost();
        const entry = writeScript('module.exports = { activate: async () => {} };');
        await host.start({ id: 'a', entryFile: entry, capabilities: [] });

        assert.strictEqual((await host.stop('a')).success, true);
        assert.strictEqual(host.status('a').state, 'stopped');
        assert.strictEqual((await host.stop('a')).success, true);
    });

    test('starting the same id twice is refused', async () => {
        const host = freshHost();
        const entry = writeScript('module.exports = { activate: async () => {} };');
        await host.start({ id: 'a', entryFile: entry, capabilities: [] });

        await assert.rejects(host.start({ id: 'a', entryFile: entry, capabilities: [] }), /already running/);
    });

    test('a plugin that never calls back is refused as hung, not left running forever', async () => {
        const host = freshHost();
        const entry = writeScript(`
            module.exports = { activate: async () => { while (true) {} } };
        `);
        await assert.rejects(host.start({ id: 'a', entryFile: entry, capabilities: [] }), /did not finish starting/);
    }, { timeout: 15000 });

    test('stopAll() tears every plugin down', async () => {
        const host = freshHost();
        const entry = writeScript('module.exports = { activate: async () => {} };');
        await host.start({ id: 'a', entryFile: entry, capabilities: [] });
        await host.start({ id: 'b', entryFile: entry, capabilities: [] });

        await host.stopAll();
        assert.deepStrictEqual(host.list(), []);
    });
});
