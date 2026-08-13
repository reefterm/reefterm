const transport = require('../transport');
const ssh = require('../ssh');
const serial = require('../serial');
const agent = require('../agent');
const tunnels = require('../tunnels');

function register({ handle, getWindow, requestTrust, requestKeyboardInteractive }) {
    /* ---------------- Sessions ---------------- */

    // Still named for SSH because these are the channels a pane's session runs
    // on, whatever it turns out to be: the dispatcher reads the host record and
    // picks between ssh.js, telnet.js and serial.js. See transport.js.
    handle('ssh-connect', async (event, payload) => {
        // Both prompts below are raised mid-handshake, so they are stamped with
        // the pane that is dialling. The renderer asks the question inside that
        // pane rather than over the whole window, and a question with no pane
        // left to ask it in can be answered for: see App.jsx.
        const tabId = payload?.tabId || null;

        const result = await transport.connect(payload, {
            window: getWindow(),
            requestTrust: (details) => requestTrust({ tabId, ...details }),
            requestKeyboardInteractive: (details) =>
                requestKeyboardInteractive({ tabId, ...details }),
        });
        // Forwards belong to the session, not the app run, so they are armed on
        // every successful dial, including the reconnect after a drop, where
        // the previous session's listeners have already been torn down.
        //
        // Only SSH carries them: a forward is a channel on an SSH connection,
        // and there is nothing to open one on over telnet or a serial line.
        if (result.success && transport.protocolOf(payload.tabId) === 'ssh') {
            tunnels.autoStart(payload.tabId, payload.hostId);
        }
        return result;
    });

    handle('ssh-disconnect', (event, tabId) => transport.destroy(tabId));
    handle('ssh-detect-os', (event, tabId) => ssh.detectOS(tabId));

    /* ---------------- Serial ports ---------------- */

    // Read live on every call rather than cached: a USB adapter enumerates
    // under a different name each time it is plugged into a different socket,
    // so a remembered list would offer ports that stopped existing when the
    // cable moved.
    handle('serial-list-ports', () => serial.listPorts());

    /* ---------------- SSH agent ---------------- */

    handle('agent-status', (event, agentPath) => agent.probe(agentPath));
    handle('agent-default-path', () => ({
        path: agent.defaultAgentPath(),
        location: agent.describeLocation(agent.defaultAgentPath()),
    }));
    // Resize travels over the session's MessagePort, not IPC.
}

module.exports = { register };
