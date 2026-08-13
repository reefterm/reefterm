const { ipcRenderer, subscribe } = require('./channel');

/* ------------------------------------------------------------------ *
 * Terminal data channel
 *
 * MessagePorts cannot cross the context bridge, so the preload owns them and
 * exposes a callback API instead. Keystrokes that arrive before the port is
 * established are queued rather than dropped.
 * ------------------------------------------------------------------ */

const ports = new Map();        // tabId -> MessagePort
const handlers = new Map();     // tabId -> callback
const pending = new Map();      // tabId -> queued messages

// Every open tab subscribes to the broadcast channels (disconnects, transfer
// updates, resume). The default ceiling of 10 would start warning at five tabs.
ipcRenderer.setMaxListeners(200);

ipcRenderer.on('ssh-port', (event, { tabId }) => {
    const port = event.ports?.[0];
    if (!port) return;

    // A reconnect hands out a fresh port for the same tab; the old one has to
    // go or it leaks and its queued messages never land anywhere.
    const previous = ports.get(tabId);
    if (previous) {
        previous.onmessage = null;
        try {
            previous.close();
        } catch {
            // Already closed with the session it belonged to.
        }
    }

    ports.set(tabId, port);

    port.onmessage = (message) => {
        const handler = handlers.get(tabId);
        if (!handler) return;
        if (typeof message.data === 'string') {
            handler({ type: 'data', data: message.data });
        } else if (message.data?.type === 'disconnected') {
            handler({ type: 'disconnected' });
        }
    };
    port.start();

    const queued = pending.get(tabId);
    if (queued) {
        for (const message of queued) port.postMessage(message);
        pending.delete(tabId);
    }
});

function post(tabId, message) {
    const port = ports.get(tabId);
    if (port) {
        port.postMessage(message);
        return;
    }
    const queue = pending.get(tabId) || [];
    queue.push(message);
    pending.set(tabId, queue);
}

function closePort(tabId) {
    const port = ports.get(tabId);
    if (port) {
        port.close();
        ports.delete(tabId);
    }
    handlers.delete(tabId);
    pending.delete(tabId);
}

// A pane's session, whatever it runs over. Named for SSH because that is
// what every session was when this was written and what almost all of them
// still are; main reads the host record and picks between SSH, telnet and a
// serial port. Nothing on this side has to know which it got: the port
// carries bytes either way.
const ssh = {
    connect: ({ tabId, hostId, cols, rows }) =>
        ipcRenderer.invoke('ssh-connect', { tabId, hostId, cols, rows }),
    disconnect: (tabId) => ipcRenderer.invoke('ssh-disconnect', tabId),
    detectOS: (tabId) => ipcRenderer.invoke('ssh-detect-os', tabId),

    sendInput: (tabId, data) => post(tabId, { type: 'input', data }),
    resize: (tabId, cols, rows) => post(tabId, { type: 'resize', cols, rows }),

    onData: (tabId, callback) => {
        handlers.set(tabId, callback);
        return () => handlers.delete(tabId);
    },
    release: (tabId) => closePort(tabId),

    onDisconnected: (callback) => subscribe('ssh-disconnected', callback),
};

const agent = {
    // `agentPath` blank means "auto-detect"; main resolves it.
    status: (agentPath) => ipcRenderer.invoke('agent-status', agentPath || ''),
    defaultPath: () => ipcRenderer.invoke('agent-default-path'),
};

// The serial ports this machine can see, for the picker in the host editor.
// Answers `{ available, message, ports }` rather than throwing when the
// serial binding is missing, so the editor can say why the list is empty.
const serial = {
    listPorts: () => ipcRenderer.invoke('serial-list-ports'),
};

const auth = {
    // Keyboard-interactive rounds the app cannot answer on its own: a
    // one-time code, a push approval, an expired password.
    onPrompt: (callback) => subscribe('auth-prompt', callback),
    // `answers` omitted (or null) cancels the attempt.
    respond: (requestId, answers) =>
        ipcRenderer.invoke('auth-prompt-response', { requestId, answers }),
};

module.exports = { ssh, agent, serial, auth };
