const { ipcRenderer, subscribe } = require('./channel');

/**
 * The assistant. Named `ai` rather than `agent`, which is already taken by
 * the SSH agent and means something entirely different.
 *
 * A conversation lives in the main process, not here. This surface starts
 * one, feeds it text, and subscribes to the event stream it produces; a
 * window reload loses the panel and none of the conversation, which is why
 * `history` exists.
 */
const ai = {
    status: () => ipcRenderer.invoke('ai-status'),
    setSettings: (patch) => ipcRenderer.invoke('ai-settings-set', patch),
    // The settings, whenever anything changes them. Both the panel and the
    // settings page show some of these and can be open at once.
    onSettings: (callback) => subscribe('ai-settings', callback),
    // The models the installed Claude Code reports it can run, and the
    // effort levels each of them takes. Arrives once the runtime has
    // started, which is the first time it can be asked, so it is pushed
    // rather than only being read from `status`.
    onModels: (callback) => subscribe('ai-models', callback),
    // Asks for the list, starting the runtime briefly if that is what it
    // takes. Resolves null when this machine's Claude Code cannot say.
    // `refresh` throws away what was read for this agent and asks again,
    // for the button the menu shows when a read came back empty.
    models: ({ refresh = false } = {}) => ipcRenderer.invoke('ai-model-list', { refresh }),
    // Write-only. The key goes in and never comes back out.
    setApiKey: (value) => ipcRenderer.invoke('ai-set-key', value),

    // `sessionIds` and `hostIds` are the explicit set a pinned scope fences
    // the conversation to. Empty for the two modes that are not a set.
    start: ({ scope, sessionId, sessionIds, hostIds } = {}) =>
        ipcRenderer.invoke('ai-conversation-start', { scope, sessionId, sessionIds, hostIds }),
    list: () => ipcRenderer.invoke('ai-conversation-list'),
    history: (conversationId) => ipcRenderer.invoke('ai-conversation-history', conversationId),
    // Releases the running query and keeps the transcript, so the
    // conversation can be picked up again from the history menu.
    park: (conversationId) => ipcRenderer.invoke('ai-conversation-park', conversationId),
    close: (conversationId) => ipcRenderer.invoke('ai-conversation-close', conversationId),
    // Which servers the panel is pointed at: the session in front, every
    // host, or a pinned set of sessions and saved hosts.
    setScope: (conversationId, target) =>
        ipcRenderer.invoke('ai-scope', { conversationId, ...(target || {}) }),

    send: (conversationId, text) => ipcRenderer.invoke('ai-send', { conversationId, text }),
    interrupt: (conversationId) => ipcRenderer.invoke('ai-interrupt', conversationId),

    // Every message, tool call and result for a conversation.
    onEvent: (callback) => subscribe('ai-event', callback),

    // A tool call waiting on the user. The panel draws it; the answer goes
    // back on the matching request id.
    // How an approval was settled, including a timeout, arrives on the
    // ordinary event stream, so there is no second channel to watch.
    approve: (requestId, approved, message) =>
        ipcRenderer.invoke('ai-approval-response', { requestId, approved, message }),

    // Main asking the window to open or close a session, which only the
    // window can do because that means touching the tab tree.
    onAction: (callback) => subscribe('ai-action', callback),
    respondToAction: (requestId, result) =>
        ipcRenderer.invoke('ai-action-response', { requestId, ...result }),
};

module.exports = { ai };
