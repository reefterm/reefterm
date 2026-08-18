import { useCallback, useEffect, useState } from 'react';

/**
 * The credential mapping a settings page reads and edits: which saved key,
 * or the user's own SSH agent, a plugin's host group should connect with
 * (see plugins/credentials.js). The plugin that contributed the host never
 * sees this - only PluginsSection and the connect path (ipc/hosts.js) do.
 */
export default function usePluginCredentials() {
    const [config, setConfig] = useState({});

    const refresh = useCallback(async () => {
        if (!window.api?.plugins) return;
        setConfig(await window.api.plugins.getCredentialConfig() || {});
    }, []);

    useEffect(() => { refresh(); }, [refresh]);

    const setMapping = useCallback(async (pluginId, group, entry) => {
        const result = await window.api.plugins.setCredentialMapping(pluginId, group, entry);
        if (result?.success) await refresh();
        return result;
    }, [refresh]);

    return { config, setMapping };
}
