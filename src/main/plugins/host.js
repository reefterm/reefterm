const { fork } = require('child_process');
const path = require('path');
const uiExtensions = require('./ui-extensions');

/**
 * Runs a plugin's own code in a separate, locked-down process, and is the
 * only door between that process and anything this app actually holds.
 *
 * This is the prototype for the boundary Phase 3b needs and Phase 3a never
 * built: everything registered through plugins/registry.js so far
 * (AI providers, import sources) is still first-party code, `require()`'d
 * directly, with the same access to the store and the vault as any other
 * file in this app. A community plugin cannot be given that. This module is
 * where a plugin's code actually runs once it is not first-party any more -
 * see host-runtime.js for what runs on the other end of the fork, and its
 * own header for exactly what a plugin is and is not able to reach from
 * inside it.
 *
 * A plugin never gets a reference to `store`, `ssh`, or anything else this
 * app owns. It gets a `call(name, ...args)` function, and `name` has to be
 * a capability this module was told about via `registerCapability` *and*
 * the specific plugin was granted at `start()` time. That is the one seam:
 * whatever a capability handler is written to do, in this trusted process,
 * with this process's own judgement about the caller, is the whole of what
 * a plugin can accomplish. Nothing here decides what those handlers should
 * be for a real feature (a host list, a mediated SSH command) - this module
 * only owns the transport and the grant check, the same separation
 * ai/tools.js already draws between what a tool is allowed to do and how a
 * call reaches it.
 */

/** How long a plugin gets to activate before it is treated as hung. */
const START_TIMEOUT = 10000;

/** How long a stop() gets to end cleanly before the process is killed outright. */
const STOP_TIMEOUT = 3000;

/** How long a plugin gets to answer an invoked action before it is treated as hung. */
const ACTION_TIMEOUT = 10000;

const RUNTIME_FILE = path.join(__dirname, 'host-runtime.js');

function createPluginHost() {
    /** name -> async (...args) => result, registered by trusted app code only. */
    const capabilityHandlers = new Map();
    /** id -> { child, state, granted, pending: Map<callId, {resolve,reject}> } */
    const plugins = new Map();

    let notify = () => {};
    function setNotifier(fn) {
        notify = fn;
    }

    /**
     * What a capability actually does, in this process. `name` is what a
     * plugin's `call()` names; `handler` receives exactly the arguments the
     * plugin passed, with no further mediation of its own - anything a
     * handler needs to check (scope, approval, rate limits) is the
     * handler's job, the same way a tool handler in ai/tools.js is trusted
     * to enforce its own rules once it is running.
     */
    function registerCapability(name, handler) {
        if (!name || typeof name !== 'string') {
            throw new Error('plugin host: registerCapability needs a non-empty string name');
        }
        if (typeof handler !== 'function') {
            throw new Error(`plugin host: capability "${name}" needs a handler function`);
        }
        if (capabilityHandlers.has(name)) {
            throw new Error(`plugin host: capability "${name}" is already registered`);
        }
        capabilityHandlers.set(name, handler);
    }

    /**
     * Start a plugin's code in its own process. Resolves once the plugin has
     * activated and reported ready; rejects if it fails to activate, crashes
     * before then, or does not report in within `START_TIMEOUT`, in which
     * case the process is killed rather than left running unobserved.
     */
    function start({ id, entryFile, capabilities = [] }) {
        if (!id || typeof id !== 'string') {
            return Promise.reject(new Error('plugin host: start() needs a non-empty string id'));
        }
        // A crashed record is kept around (see the exit handler below) so
        // status()/list() can still say why the plugin is gone, but it is
        // not a reason to refuse restarting it - only an actually live one is.
        const existing = plugins.get(id);
        if (existing && existing.state !== 'crashed') {
            return Promise.reject(new Error(`plugin host: "${id}" is already running`));
        }
        for (const name of capabilities) {
            if (!capabilityHandlers.has(name)) {
                return Promise.reject(new Error(`plugin host: cannot grant unknown capability "${name}" to "${id}"`));
            }
        }

        return new Promise((resolve, reject) => {
            const child = fork(RUNTIME_FILE, [], {
                // Nothing inherited: an env var is as much a leak as a file
                // handle would be, and a plugin gets only what it was
                // explicitly handed, which today is nothing at all.
                env: {},
                // The runtime-enforced half of the boundary (see this file's
                // own header and host-runtime.js). Nothing is granted beyond
                // the two reads Node's own module loader cannot function
                // without - this file (so the process can boot at all) and
                // the plugin's own directory (so `require(entryFile)`, and
                // any relative require of a sibling file, can succeed). No
                // --allow-fs-write, no --allow-child-process, no
                // --allow-worker, no --allow-addons, and no other path is
                // readable: not the vault, not another plugin's directory,
                // not the rest of this machine.
                execArgv: [
                    '--permission',
                    `--allow-fs-read=${RUNTIME_FILE}`,
                    `--allow-fs-read=${path.join(path.dirname(entryFile), '*')}`,
                ],
                stdio: ['ignore', 'pipe', 'pipe', 'ipc'],
                serialization: 'json',
            });

            const record = {
                child,
                state: 'starting',
                granted: new Set(capabilities),
                // key (`${pointName}:${contributionId}`) -> { pointName, id, node }.
                contributions: new Map(),
                // callId -> { resolve, reject }, for an invokeAction() this process is
                // still waiting on a reply to - the mirror image of host-runtime.js's
                // own `pending`, one direction earlier down the same round trip.
                pendingActions: new Map(),
                nextActionCallId: 0,
            };
            plugins.set(id, record);

            let settled = false;
            const settle = (error) => {
                if (settled) return;
                settled = true;
                clearTimeout(timer);
                if (error) {
                    plugins.delete(id);
                    try { child.kill(); } catch { /* already gone */ }
                    reject(error);
                } else {
                    record.state = 'ready';
                    resolve({ id });
                }
            };

            const timer = setTimeout(() => {
                settle(new Error(`Plugin "${id}" did not finish starting in time`));
            }, START_TIMEOUT);

            // Piped rather than inherited, and read here rather than ignored:
            // a plugin's console.log is not nothing, but it does not belong
            // mixed into this process's own stdout unlabelled.
            child.stdout?.on('data', (chunk) => notify('plugin-log', { id, stream: 'stdout', text: chunk.toString() }));
            child.stderr?.on('data', (chunk) => notify('plugin-log', { id, stream: 'stderr', text: chunk.toString() }));

            child.on('message', (message) => handleMessage(id, record, message, settle));

            child.on('exit', (code, signal) => {
                record.exited = true;
                if (!settled) {
                    plugins.delete(id);
                    settle(new Error(`Plugin "${id}" exited before starting (code ${code}, signal ${signal})`));
                    return;
                }
                // A stop() in progress already knows why this process is
                // ending and owns the record's fate; an unexpected exit is
                // the only case this handler reports and keeps around, so a
                // later status()/list() call still says *why* the plugin is
                // gone rather than falling back to the generic "stopped".
                if (record.state !== 'stopping' && plugins.get(id) === record) {
                    record.state = 'crashed';
                    notify('plugin-exit', { id, code, signal, expected: false });
                    clearContributions(id, record);
                }
            });

            child.send({ type: 'init', entryFile, capabilities });
        });
    }

    function handleMessage(id, record, message, settle) {
        if (message.type === 'ready') {
            settle(null);
            return;
        }
        if (message.type === 'activation-error') {
            settle(new Error(message.message));
            return;
        }
        if (message.type === 'crash') {
            record.state = 'crashed';
            notify('plugin-crash', { id, message: message.message, stack: message.stack });
            settle(new Error(message.message));
            return;
        }
        if (message.type === 'capability-call') {
            handleCapabilityCall(id, record, message);
            return;
        }
        if (message.type === 'contribute') {
            handleContribute(id, record, message);
            return;
        }
        if (message.type === 'action-result' || message.type === 'action-error') {
            handleActionResponse(record, message);
        }
    }

    async function handleCapabilityCall(id, record, { callId, name, args }) {
        const { child } = record;
        // Checked again here, against this specific plugin's grant, not just
        // "is this name registered at all": a capability another plugin has
        // is not one this one gets for free.
        if (!record.granted.has(name)) {
            child.send({ type: 'capability-error', callId, message: `Capability "${name}" was not granted to this plugin` });
            return;
        }
        const handler = capabilityHandlers.get(name);
        if (!handler) {
            child.send({ type: 'capability-error', callId, message: `Capability "${name}" is no longer available` });
            return;
        }
        try {
            const result = await handler(...(args || []));
            child.send({ type: 'capability-result', callId, result });
        } catch (error) {
            child.send({ type: 'capability-error', callId, message: error.message });
        }
    }

    /** Every current contribution for one plugin, in the shape listContributions() also uses. */
    function pluginContributions(id, record) {
        return [...record.contributions.values()].map(({ pointName, id: contributionId, node }) => (
            { pluginId: id, pointName, id: contributionId, node }
        ));
    }

    function clearContributions(id, record) {
        if (record.contributions.size === 0) return;
        record.contributions.clear();
        notify('plugin-contribution', { id, contributions: [] });
    }

    /** A plugin declaring or updating one piece of UI - validated here, not trusted from the child's own shape-check. */
    function handleContribute(id, record, { callId, pointName, id: contributionId, node }) {
        const { child } = record;
        const error = uiExtensions.validateNode(pointName, node);
        if (error) {
            child.send({ type: 'contribute-error', callId, message: error });
            return;
        }
        record.contributions.set(`${pointName}:${contributionId}`, { pointName, id: contributionId, node });
        child.send({ type: 'contribute-result', callId, result: { success: true } });
        notify('plugin-contribution', { id, contributions: pluginContributions(id, record) });
    }

    /** A reply to an invokeAction() this process itself sent - see invokeAction() below. */
    function handleActionResponse(record, message) {
        const entry = record.pendingActions.get(message.callId);
        if (!entry) return;
        record.pendingActions.delete(message.callId);
        if (message.type === 'action-result') entry.resolve(message.result);
        else entry.reject(new Error(message.message));
    }

    /** The app-initiated mirror of handleCapabilityCall: invokes a handler the plugin registered via onAction(). */
    function invokeAction(id, actionId, args) {
        const record = plugins.get(id);
        if (!record || record.state !== 'ready') {
            return Promise.reject(new Error(`Plugin "${id}" is not running`));
        }

        return new Promise((resolve, reject) => {
            record.nextActionCallId += 1;
            const callId = `a${record.nextActionCallId}`;

            const timer = setTimeout(() => {
                record.pendingActions.delete(callId);
                reject(new Error(`Plugin "${id}" did not respond to action "${actionId}" in time`));
            }, ACTION_TIMEOUT);

            record.pendingActions.set(callId, {
                resolve: (result) => { clearTimeout(timer); resolve(result); },
                reject: (error) => { clearTimeout(timer); reject(error); },
            });
            record.child.send({ type: 'invoke-action', callId, actionId, args });
        });
    }

    /** Every plugin's current contributions, flattened, for the renderer to draw from. */
    function listContributions() {
        return [...plugins.entries()].flatMap(([id, record]) => pluginContributions(id, record));
    }

    /** End a plugin's process. Resolves once it is gone, however that happened. */
    function stop(id) {
        const record = plugins.get(id);
        if (!record) return Promise.resolve({ success: true });

        // Already gone (a crash beat this call to it): an 'exit' listener
        // attached now would wait forever for an event that already fired.
        if (record.exited) {
            plugins.delete(id);
            return Promise.resolve({ success: true });
        }

        record.state = 'stopping';
        return new Promise((resolve) => {
            const { child } = record;
            let done = false;
            const finish = () => {
                if (done) return;
                done = true;
                clearContributions(id, record);
                plugins.delete(id);
                resolve({ success: true });
            };

            child.once('exit', finish);
            child.kill();
            // A plugin's own code cannot intercept or delay a SIGTERM the way
            // it could a message it chooses not to answer, but the process
            // itself might simply be slow to unwind; this is the same
            // "ask nicely, then insist" shape connect()/close() use elsewhere
            // in this app (see ai/index.js's ACTION_TIMEOUT).
            setTimeout(() => {
                if (done) return;
                try { child.kill('SIGKILL'); } catch { /* already gone */ }
            }, STOP_TIMEOUT);
        });
    }

    function status(id) {
        const record = plugins.get(id);
        return record ? { id, state: record.state } : { id, state: 'stopped' };
    }

    function list() {
        return [...plugins.entries()].map(([id, record]) => ({ id, state: record.state }));
    }

    /** Tear every running plugin down, for a quit. */
    async function stopAll() {
        await Promise.all([...plugins.keys()].map(stop));
    }

    return {
        setNotifier,
        registerCapability,
        start,
        stop,
        stopAll,
        status,
        list,
        invokeAction,
        listContributions,
    };
}

module.exports = { createPluginHost };
