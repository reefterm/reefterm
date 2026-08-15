const activity = require('../activity');

function register({ handle, notify }) {
    // Required here, not at module load, so requiring this file doesn't
    // pull in ai/index.js unless register() actually runs.
    const assistant = require('../ai');

    /* ---------------- Assistant ---------------- */

    handle('ai-status', () => assistant.status());
    // Brings the runtime up on its own if it has not been asked yet, so a
    // model menu is right the first time it is opened rather than after the
    // first message. Cached from then on; `ai-models` announces the answer.
    handle('ai-model-list', (event, options) => assistant.models(options || {}));
    handle('ai-settings-set', (event, patch) => {
        const before = assistant.settings.get();
        const next = assistant.settings.set(patch);
        // Tells any live conversation which of these it has to restart for.
        // The model chip in the composer is expected to change the answer to
        // the next question, not to the next conversation.
        assistant.reconfigure(before, next);

        // Only the two that widen what the assistant may do unattended are
        // logged. The model and the effort are changed from a chip in the
        // composer several times an hour, and a security log that fills up
        // with them is a security log nobody reads.
        const changes = [];
        if (before.approval !== next.approval) {
            changes.push({ field: 'approvals', from: before.approval, to: next.approval });
        }
        if (before.allowLocalTools !== next.allowLocalTools) {
            changes.push({
                field: 'local tools',
                from: before.allowLocalTools ? 'allowed' : 'blocked',
                to: next.allowLocalTools ? 'allowed' : 'blocked',
            });
        }
        if (changes.length > 0) {
            activity.record({
                category: 'security',
                action: 'assistant.configure',
                outcome: 'info',
                target: 'Assistant',
                detail: `Approvals: ${next.approval}`
                    + `${next.allowLocalTools ? ', local tools allowed' : ''}`,
                changes,
            });
        }

        // The settings page and the panel both show some of this, and they are
        // on screen at the same time. Whoever did not make the change hears
        // about it here rather than showing a stale copy until it is reopened.
        notify('ai-settings', next);

        return next;
    });
    // Write-only, like every other credential in the app: it goes in, and only
    // whether one exists ever comes back.
    handle('ai-set-key', (event, value) => assistant.settings.setApiKey(value));

    handle('ai-conversation-start', (event, payload) => assistant.create(payload || {}));
    handle('ai-conversation-list', () => assistant.list());
    handle('ai-conversation-history', (event, conversationId) => assistant.history(conversationId));
    handle('ai-conversation-park', (event, conversationId) => assistant.park(conversationId));
    handle('ai-conversation-close', (event, conversationId) => assistant.close(conversationId));
    handle('ai-scope', (event, payload) => assistant.setScope(payload?.conversationId, payload || {}));
    handle('ai-send', (event, payload) => assistant.send(payload?.conversationId, payload?.text));
    handle('ai-interrupt', (event, conversationId) => assistant.interrupt(conversationId));

    // The two answers the window owes the main process: whether a tool call may
    // go ahead, and whether it managed to open or close the session it was
    // asked to.
    handle('ai-approval-response', (event, payload) => assistant.respondToApproval(payload || {}));
    handle('ai-action-response', (event, payload) => assistant.respondToAction(payload || {}));
}

module.exports = { register };
