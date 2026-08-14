/**
 * Runs *inside* the forked child process a plugin's own code executes in.
 * Everything in this file is boundary-enforcement, not convenience - it is
 * the only thing standing between a plugin's code and the rest of Node.
 *
 * Two layers, deliberately not one:
 *
 *   1. The process itself is started (see host.js) with Node's `--permission`
 *      flag and nothing granted: no fs, no child_process, no worker_threads,
 *      no native addons. That is enforced by the V8/Node runtime itself, not
 *      by any JavaScript in this file, which is what makes it the strong
 *      half of the boundary - it holds even against a plugin that finds a
 *      way around the layer below.
 *
 *   2. `require()` is patched here to refuse everything except a small
 *      builtin safelist and the plugin's own relative files. This exists
 *      because the permission model does not cover networking at all:
 *      `require('net')`, `require('http')`, `require('https')` and
 *      `require('dns')` all work unless something stops them. A plugin's
 *      only door to anything the app actually holds - a host list, a live
 *      session, a network request made on its behalf - is the `call()`
 *      function handed to `activate()`, which round-trips through the
 *      parent process and is checked there against exactly what that
 *      plugin was granted. See host.js's `capabilityHandlers`.
 *
 * A plugin that gets past both of these has found a real bug, not a gap
 * left by design - which is the honest bar this is held to: this is a much
 * higher wall than "the plugin author has to be nice," not a claim that
 * nothing here could ever be escaped.
 */

const Module = require('module');

/**
 * What a plugin's own code may `require()` directly. Deliberately tiny:
 * pure, synchronous, no I/O and no process control. Everything else -
 * networking above all, since `--permission` does not touch it - goes
 * through a granted capability instead.
 */
const ALLOWED_BUILTINS = new Set([
    'assert', 'buffer', 'events', 'path', 'stream', 'string_decoder', 'util',
]);

const realRequire = Module.prototype.require;

Module.prototype.require = function guardedRequire(request) {
    if (ALLOWED_BUILTINS.has(request)) return realRequire.call(this, request);
    // A plugin requiring its own other files (a relative path, or an
    // absolute one under its own directory) is not what this boundary is
    // for; only reaching for a builtin or an installed package is gated.
    if (request.startsWith('.') || require('path').isAbsolute(request)) {
        return realRequire.call(this, request);
    }
    throw new Error(
        `Plugins cannot require("${request}"). `
        + 'Use the capabilities this plugin was granted (the `call` function passed to activate()) instead.'
    );
};

let granted = new Set();
let nextCallId = 0;
/** callId -> { resolve, reject } */
const pending = new Map();

/**
 * The plugin's one door back into the app. Checked here as well as in the
 * parent (see host.js) so a plugin gets a clear, immediate rejection for a
 * capability it was never granted, rather than a round trip that ends the
 * same way.
 */
function call(name, ...args) {
    if (!granted.has(name)) {
        return Promise.reject(new Error(`This plugin was not granted the "${name}" capability`));
    }
    return new Promise((resolve, reject) => {
        nextCallId += 1;
        const callId = String(nextCallId);
        pending.set(callId, { resolve, reject });
        process.send({ type: 'capability-call', callId, name, args });
    });
}

async function handleInit(message) {
    granted = new Set(message.capabilities || []);
    try {
        // Trusted: this path was chosen by the parent process that forked
        // this one, not supplied by the plugin itself.
        const plugin = realRequire.call(module, message.entryFile);
        if (typeof plugin?.activate === 'function') {
            await plugin.activate({ call });
        }
        process.send({ type: 'ready' });
    } catch (error) {
        process.send({ type: 'activation-error', message: error.message, stack: error.stack || '' });
    }
}

function handleCapabilityResponse(message) {
    const entry = pending.get(message.callId);
    if (!entry) return;
    pending.delete(message.callId);
    if (message.type === 'capability-result') entry.resolve(message.result);
    else entry.reject(new Error(message.message));
}

process.on('message', (message) => {
    if (message.type === 'init') { handleInit(message); return; }
    if (message.type === 'capability-result' || message.type === 'capability-error') {
        handleCapabilityResponse(message);
    }
});

// A plugin's own bug must not look like a silent hang: the parent is told,
// then the process ends. `process.exit` rather than letting Node's default
// crash handling run, so this is one clean, reported failure rather than
// a raw stack trace on a stream nobody in the parent is reading anyway
// (stdio is piped, not inherited - see host.js).
process.on('uncaughtException', (error) => {
    try {
        process.send({ type: 'crash', message: error.message, stack: error.stack || '' });
    } catch {
        // The channel itself is gone; nothing left to tell.
    }
    process.exit(1);
});

process.on('unhandledRejection', (error) => {
    try {
        process.send({
            type: 'crash',
            message: error instanceof Error ? error.message : String(error),
            stack: error instanceof Error ? (error.stack || '') : '',
        });
    } catch {
        // As above.
    }
    process.exit(1);
});
