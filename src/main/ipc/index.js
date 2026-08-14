const { ipcMain, powerMonitor } = require('electron');
const vault = require('../vault');
const transfers = require('../transfers');
const monitor = require('../monitor');
const cloudSnapshot = require('../cloud-snapshot');
const updates = require('../updates');
const remoteEdit = require('../remote-edit');
const assistant = require('../ai');
const tunnels = require('../tunnels');
const vnc = require('../vnc');
const rdp = require('../rdp');
const bmc = require('../bmc');
const activity = require('../activity');
const ssh = require('../ssh');
const plugins = require('../plugins');

const hostsIpc = require('./hosts');
const keysIpc = require('./keys');
const snippetsIpc = require('./snippets');
const proxiesIpc = require('./proxies');
const lockIpc = require('./lock');
const sshIpc = require('./ssh');
const tunnelsIpc = require('./tunnels');
const vncIpc = require('./vnc');
const bmcIpc = require('./bmc');
const rdpIpc = require('./rdp');
const importIpc = require('./import');
const backupIpc = require('./backup');
const syncIpc = require('./sync');
const monitoringIpc = require('./monitoring');
const sftpIpc = require('./sftp');
const auditIpc = require('./audit');
const osIntegrationIpc = require('./os-integration');
const updatesIpc = require('./updates');
const assistantIpc = require('./assistant');
const pluginsIpc = require('./plugins');

/**
 * Channels that still answer while the app is locked: the unlock flow itself,
 * and the status the lock screen reads to know it should be showing.
 */
const ALLOWED_WHILE_LOCKED = new Set(['app-lock-status', 'app-lock-unlock']);

/**
 * Register a channel behind the lock.
 *
 * Refusing here rather than in the renderer is the whole point: the lock screen
 * is a React component, and a component can be stepped around by anything with
 * a handle on the page. A locked main process cannot be, so no host list, key
 * or session is reachable until the password has actually been proven.
 *
 * A throw is deliberate over an error object. A caller that ignores the result
 * gets a rejected promise rather than something it might render as data.
 */
function handle(channel, listener) {
    ipcMain.handle(channel, (event, ...args) => {
        if (vault.isLocked() && !ALLOWED_WHILE_LOCKED.has(channel)) {
            throw new Error('The app is locked');
        }
        return listener(event, ...args);
    });
}

// requestId -> resolve, for host key prompts awaiting a user decision.
const pendingHostKeyPrompts = new Map();
// requestId -> resolve, for BMC certificate prompts awaiting one. Separate from
// the host key map because a page load is held open on each of these, so
// cancelling them has to deny the load rather than leave Chromium waiting.
const pendingCertPrompts = new Map();
// requestId -> resolve, for keyboard-interactive rounds awaiting answers.
const pendingAuthPrompts = new Map();
let promptCounter = 0;

/**
 * Wires up every feature's IPC surface behind one lock check and one notifier,
 * then hands each feature module a small context (`handle`, `getWindow`,
 * `notify`, and the two user-prompt helpers) rather than a shared closure over
 * everything in this file. Splitting the channels out this way is what a
 * future plugin surface would mirror: a feature registers itself against this
 * same context instead of editing a single file that knows about all of them.
 */
function register(getWindow) {
    const notify = (channel, payload) => {
        const window = getWindow();
        if (window && !window.isDestroyed()) {
            window.webContents.send(channel, payload);
        }
    };

    transfers.setNotifier(notify);

    // The reachability poller. Given the window as well as the notifier because
    // it raises Windows notifications of its own, and a toast that is clicked
    // has to be able to bring the app forward.
    monitor.start(notify, getWindow);

    // Registers the store hooks that queue an upload, and pulls whatever another
    // device saved. Same tolerance for being signed out or locked.
    cloudSnapshot.start(notify);

    // Schedules the daily release check. Unlike the two above it does not care
    // about the sync connection at all, so a locked or disconnected app still
    // finds out there is a new build.
    updates.start(notify);

    remoteEdit.setNotifier(notify);
    assistant.setNotifier(notify);
    tunnels.setNotifier(notify);
    vnc.setNotifier(notify);
    rdp.setNotifier(notify);
    bmc.setNotifier(notify);
    activity.setNotifier(notify);
    plugins.setNotifier(notify);

    // Waking from sleep is when a session is most likely to be dead and a
    // retry most likely to succeed, so tabs are told rather than waiting out
    // their keepalive timeout.
    powerMonitor.on('resume', () => notify('system-resume', { reason: 'resume' }));
    powerMonitor.on('unlock-screen', () => notify('system-resume', { reason: 'unlock' }));

    // Closing a tab must stop its in-flight transfers, drop its scratch files,
    // tear down its port forwards and end any desktop riding the connection;
    // all of them outlive the IPC call that started them, and a forward left
    // running would hold its local port.
    ssh.onDestroy((tabId) => {
        transfers.cleanup(tabId);
        remoteEdit.cleanup(tabId);
        tunnels.cleanup(tabId);
        vnc.cleanup(tabId);
        rdp.cleanup(tabId);
        bmc.cleanup(tabId);
    });

    /**
     * Ask the user whether to trust an unknown or changed host key. Resolves
     * false if the window is gone, so a connection can never be silently
     * trusted without a human decision.
     */
    const requestTrust = (details) => new Promise((resolve) => {
        const window = getWindow();
        if (!window || window.isDestroyed()) {
            resolve(false);
            return;
        }
        const requestId = `hk-${++promptCounter}`;
        pendingHostKeyPrompts.set(requestId, resolve);
        window.webContents.send('host-key-prompt', { requestId, ...details });
    });

    /**
     * The same question for a BMC's TLS certificate. Resolves false with no
     * window, so a page load is never silently trusted either.
     *
     * Handed to bmc.js rather than called from it, so that module stays free of
     * any knowledge of how a prompt reaches a person, exactly as ssh.js is.
     */
    bmc.setTrustRequester((details) => new Promise((resolve) => {
        const window = getWindow();
        if (!window || window.isDestroyed()) {
            resolve(false);
            return;
        }
        const requestId = `bc-${++promptCounter}`;
        pendingCertPrompts.set(requestId, resolve);
        window.webContents.send('bmc-cert-prompt', { requestId, ...details });
    }));

    /**
     * Put a keyboard-interactive round in front of the user: a one-time code,
     * a push-approval choice, an expired-password change. Resolves null if the
     * window is gone, which the connection layer treats as a cancellation
     * rather than sending the server an empty answer.
     *
     * This is the one path where a secret travels renderer → main. The store's
     * rule is that secrets never travel the *other* way; an answer the user has
     * just typed has to start where the keyboard is. It is passed straight to
     * the server and never persisted.
     */
    const requestKeyboardInteractive = (details) => new Promise((resolve) => {
        const window = getWindow();
        if (!window || window.isDestroyed()) {
            resolve(null);
            return;
        }
        const requestId = `ki-${++promptCounter}`;
        pendingAuthPrompts.set(requestId, resolve);
        window.webContents.send('auth-prompt', { requestId, ...details });
    });

    handle('auth-prompt-response', (event, { requestId, answers }) => {
        const resolve = pendingAuthPrompts.get(requestId);
        if (!resolve) return false;

        pendingAuthPrompts.delete(requestId);
        // A cancel sends no answers at all, which is distinct from answering
        // with empty strings, since the former ends the attempt, the latter spends it.
        resolve(Array.isArray(answers) ? answers.map(answer => String(answer ?? '')) : null);
        return true;
    });

    handle('host-key-response', (event, { requestId, accepted }) => {
        const resolve = pendingHostKeyPrompts.get(requestId);
        if (resolve) {
            pendingHostKeyPrompts.delete(requestId);
            resolve(Boolean(accepted));
        }
        return true;
    });

    handle('bmc-cert-response', (event, { requestId, accepted }) => {
        const resolve = pendingCertPrompts.get(requestId);
        if (resolve) {
            pendingCertPrompts.delete(requestId);
            resolve(Boolean(accepted));
        }
        return true;
    });

    const ctx = { handle, getWindow, notify, requestTrust, requestKeyboardInteractive };

    hostsIpc.register(ctx);
    keysIpc.register(ctx);
    snippetsIpc.register(ctx);
    proxiesIpc.register(ctx);
    lockIpc.register(ctx);
    sshIpc.register(ctx);
    tunnelsIpc.register(ctx);
    vncIpc.register(ctx);
    bmcIpc.register(ctx);
    rdpIpc.register(ctx);
    importIpc.register(ctx);
    backupIpc.register(ctx);
    syncIpc.register(ctx);
    monitoringIpc.register(ctx);
    sftpIpc.register(ctx);
    auditIpc.register(ctx);
    osIntegrationIpc.register(ctx);
    updatesIpc.register(ctx);
    assistantIpc.register(ctx);
    pluginsIpc.register(ctx);
}

/** Deny any prompt still waiting when the window goes away, and drop unsaved keys. */
function cancelPendingPrompts() {
    for (const resolve of pendingHostKeyPrompts.values()) resolve(false);
    pendingHostKeyPrompts.clear();
    // Each of these is a page load held open waiting for an answer. Denying
    // them lets those loads fail instead of hanging on a window that has gone.
    for (const resolve of pendingCertPrompts.values()) resolve(false);
    pendingCertPrompts.clear();
    // null, not an empty answer set: a round nobody can answer must end the
    // attempt rather than hand the server blanks and spend a login try.
    for (const resolve of pendingAuthPrompts.values()) resolve(null);
    pendingAuthPrompts.clear();
    keysIpc.clearPending();
    // Decrypted credentials from a backup nobody is going to restore now.
    backupIpc.clearPending();
    // A tool call waiting on an approval nobody can give any more. Ending the
    // conversations denies them, which is the right answer once the window
    // that would have said yes has gone.
    assistant.shutdown();
}

module.exports = { register, cancelPendingPrompts };
