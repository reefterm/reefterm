import SettingsPage from '../ui/SettingsPage';
import PluginsSection from '../PluginsSection';
import { useT } from '../../../i18n';

/** What's installed under the plugins folder, its consent state, and the on/off switch for each. */
export default function PluginsPage() {
    const t = useT();

    return (
        <SettingsPage title={t('settings.plugins.title')} description={t('settings.plugins.desc')}>
            <PluginsSection />
        </SettingsPage>
    );
}
