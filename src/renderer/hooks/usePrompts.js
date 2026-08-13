import { useState, useCallback, useEffect } from 'react';
import { collectPanes } from '../lib/panes';

/**
 * The queue of host-key confirmations and keyboard-interactive rounds raised
 * mid-handshake by the main process, and where each one is answered.
 *
 * Takes `locatePane`/`tabsRef`/`activeTabIdRef`/`setActiveTabId` rather than
 * owning tabs itself: routing a prompt to a pane needs to read the live tab
 * list and can switch which one is in front, but the tab system is App.jsx's
 * to own, not this hook's.
 */
export default function usePrompts({ locatePane, tabsRef, activeTabIdRef, setActiveTabId }) {
    // Pending host key confirmations, oldest first
    const [hostKeyPrompts, setHostKeyPrompts] = useState([]);

    // Pending keyboard-interactive rounds, oldest first. Queued rather than
    // held one at a time: two tabs can be mid-handshake at once, and a
    // one-time code is worth nothing by the time the other finishes timing out.
    const [authPrompts, setAuthPrompts] = useState([]);

    /**
     * Put a prompt raised mid-handshake in front of the pane that raised it.
     *
     * Both kinds are stamped with the pane that was dialling (see ipc.js), and
     * both are answered on that pane's own screen rather than in a modal over
     * the window. Which means the tab holding it has to be the tab in front:
     * the session cannot go any further until the question is answered, so
     * there is nothing to be gained by leaving it asking in the background.
     *
     * A prompt that names no pane, or names one that has since closed, is still
     * queued. It is asked over the window instead (see `strayPrompt` in App.jsx).
     * Nothing here ever answers on the user's behalf: a question about a host
     * key that quietly declines itself is a connection that fails for no
     * visible reason, which is worse than asking it in the wrong place.
     */
    const routePrompt = useCallback((prompt, queue) => {
        const named = prompt?.tabId ? locatePane(prompt.tabId) : null;

        // No pane named, or one that has closed. Fall back to the pane in
        // front, which is where a dial the user has just started is: a question
        // in the wrong pane can still be read and answered, and it is the same
        // question either way.
        const fallback = named ? null : (() => {
            const tabs = tabsRef.current.filter(tab => tab.type === 'terminal');
            const active = tabs.find(tab => tab.id === activeTabIdRef.current) || tabs[0];
            if (!active) return null;
            const paneId = active.focusedPaneId || collectPanes(active.layout)[0]?.id;
            return paneId ? { tab: active, pane: { id: paneId } } : null;
        })();

        const found = named || fallback;
        if (found) setActiveTabId(found.tab.id);

        // Stamped with the pane it will be asked in, so everything downstream
        // is keyed on one thing whether it was named or guessed at.
        queue(current => [...current, { ...prompt, tabId: found?.pane.id || prompt.tabId }]);
    }, [locatePane, tabsRef, activeTabIdRef, setActiveTabId]);

    // Host key confirmations raised by the main process mid-handshake
    useEffect(() => window.api.hostKeys.onPrompt((prompt) => {
        routePrompt(prompt, setHostKeyPrompts);
    }), [routePrompt]);

    const handleHostKeyResponse = useCallback((requestId, accepted) => {
        window.api.hostKeys.respond(requestId, accepted);
        setHostKeyPrompts(prev => prev.filter(p => p.requestId !== requestId));
    }, []);

    // Keyboard-interactive rounds the main process could not answer on its own
    // (a one-time code, a push approval, an expired password).
    useEffect(() => window.api.auth.onPrompt((prompt) => {
        routePrompt(prompt, setAuthPrompts);
    }), [routePrompt]);

    const handleAuthPromptResponse = useCallback((requestId, answers) => {
        window.api.auth.respond(requestId, answers);
        setAuthPrompts(prev => prev.filter(p => p.requestId !== requestId));
    }, []);

    /**
     * The question a given pane is being held up by, if any.
     *
     * A host key comes before a keyboard-interactive round for the same pane,
     * because it is asked first and answering the second one would be typing a
     * one-time code into a server that has not been identified yet.
     */
    const hostKeyPromptFor = useCallback(
        (paneId) => hostKeyPrompts.find(prompt => prompt.tabId === paneId) || null,
        [hostKeyPrompts]
    );

    const authPromptFor = useCallback(
        (paneId) => (
            hostKeyPrompts.some(prompt => prompt.tabId === paneId)
                ? null
                : authPrompts.find(prompt => prompt.tabId === paneId) || null
        ),
        [hostKeyPrompts, authPrompts]
    );

    return {
        hostKeyPrompts,
        authPrompts,
        handleHostKeyResponse,
        handleAuthPromptResponse,
        hostKeyPromptFor,
        authPromptFor,
    };
}
