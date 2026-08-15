import { useCallback, useEffect, useState } from 'react';
import toast from 'react-hot-toast';
import { toastOptions } from '../lib/toast';

/**
 * Every running plugin's contributed UI, grouped by extension point and
 * kept live via plugin-contribution events. TerminalView and HostsPanel
 * both call `forPoint('...')` and splice the result into their own list,
 * sharing one subscription rather than each growing its own.
 */
export default function usePluginContributions() {
    const [byPoint, setByPoint] = useState(() => new Map());

    const refresh = useCallback(async () => {
        if (!window.api?.plugins) return;
        const list = await window.api.plugins.listContributions();
        setByPoint(groupByPoint(list || []));
    }, []);

    useEffect(() => {
        refresh();
        if (!window.api?.plugins) return undefined;

        // Each event carries that plugin's complete current set, so merging
        // means replacing its entries everywhere, not patching one.
        return window.api.plugins.onContributionChange(({ id, contributions }) => {
            setByPoint((prev) => {
                const rest = [...prev.values()].flat().filter(c => c.pluginId !== id);
                return groupByPoint([...rest, ...contributions]);
            });
        });
    }, [refresh]);

    const invoke = useCallback((pluginId, actionId, args) => (
        window.api.plugins.invokeAction(pluginId, actionId, args).catch((error) => {
            toast.error(error?.message || `"${actionId}" failed`, toastOptions());
        })
    ), []);

    const forPoint = useCallback((pointName) => byPoint.get(pointName) || [], [byPoint]);

    return { forPoint, invoke };
}

function groupByPoint(list) {
    const map = new Map();
    for (const contribution of list) {
        const bucket = map.get(contribution.pointName) || [];
        bucket.push(contribution);
        map.set(contribution.pointName, bucket);
    }
    return map;
}
