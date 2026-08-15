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
 *      only doors out are `call()` (checked against granted capabilities,
 *      see host.js) and `contribute()` (checked against ui-extensions.js's
 *      node shapes), both round-tripped through the parent. A contributed
 *      node's `onAction` names a handler the plugin registered on itself
 *      via `onAction()`, never a capability or a raw function.
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
/** callId -> { resolve, reject }, for a request this process is waiting on a reply to. */
const pending = new Map();
/** actionId -> async (...args) => result, registered by the plugin's own code via onAction(). */
const actionHandlers = new Map();

/** Sends a request to the parent, resolved or rejected once its callId-matched reply arrives. */
function sendRequest(type, payload) {
    return new Promise((resolve, reject) => {
        nextCallId += 1;
        const callId = String(nextCallId);
        pending.set(callId, { resolve, reject });
        process.send({ type, callId, ...payload });
    });
}

/**
 * The plugin's door to whatever the app already holds. Checked here as well
 * as in the parent (see host.js) so a plugin gets a clear, immediate
 * rejection for a capability it was never granted, rather than a round trip
 * that ends the same way.
 */
function call(name, ...args) {
    if (!granted.has(name)) {
        return Promise.reject(new Error(`This plugin was not granted the "${name}" capability`));
    }
    return sendRequest('capability-call', { name, args });
}

/**
 * Declares, or updates (call again with the same `id`), one piece of UI
 * this plugin wants shown at `pointName`. Rejects if the parent refuses
 * `node`'s shape - see host.js's `contribute` handling.
 */
function contribute(pointName, id, node) {
    return sendRequest('contribute', { pointName, id, node });
}

/** Registers what runs when `actionId` (named from a contributed node's `onAction`) is invoked from the UI. */
function onAction(actionId, handler) {
    if (!actionId || typeof actionId !== 'string') {
        throw new Error('onAction needs a non-empty string actionId');
    }
    if (typeof handler !== 'function') {
        throw new Error(`onAction("${actionId}") needs a handler function`);
    }
    actionHandlers.set(actionId, handler);
}

async function handleInit(message) {
    granted = new Set(message.capabilities || []);
    try {
        // Trusted: this path was chosen by the parent process that forked
        // this one, not supplied by the plugin itself.
        const plugin = realRequire.call(module, message.entryFile);
        if (typeof plugin?.activate === 'function') {
            await plugin.activate({ call, contribute, onAction });
        }
        process.send({ type: 'ready' });
    } catch (error) {
        process.send({ type: 'activation-error', message: error.message, stack: error.stack || '' });
    }
}

/** A reply to something this process itself asked for - see sendRequest(). */
function handleResponse(message) {
    const entry = pending.get(message.callId);
    if (!entry) return;
    pending.delete(message.callId);
    if (message.type.endsWith('-result')) entry.resolve(message.result);
    else entry.reject(new Error(message.message));
}

/** The parent invoking a handler this plugin registered via onAction() - unprompted, not a reply. */
async function handleInvokeAction({ callId, actionId, args }) {
    const handler = actionHandlers.get(actionId);
    if (!handler) {
        process.send({ type: 'action-error', callId, message: `No handler registered for action "${actionId}"` });
        return;
    }
    try {
        const result = await handler(...(args || []));
        process.send({ type: 'action-result', callId, result });
    } catch (error) {
        process.send({ type: 'action-error', callId, message: error.message });
    }
}

const RESPONSE_TYPES = new Set([
    'capability-result', 'capability-error', 'contribute-result', 'contribute-error',
]);

process.on('message', (message) => {
    if (message.type === 'init') { handleInit(message); return; }
    if (RESPONSE_TYPES.has(message.type)) { handleResponse(message); return; }
    if (message.type === 'invoke-action') { handleInvokeAction(message); }
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
