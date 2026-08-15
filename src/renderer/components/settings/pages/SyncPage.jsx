import { useCallback, useEffect, useState } from 'react';
import toast from 'react-hot-toast';
import { toastStyle as getToastStyle } from '../../../lib/toast';
import { Logout01Icon, RefreshIcon, Key01Icon } from 'hugeicons-react';
import SettingsPage from '../ui/SettingsPage';
import SettingCard from '../ui/SettingCard';
import SettingRow, { DIVIDED } from '../ui/SettingRow';
import Toggle from '../ui/Toggle';
import { useT } from '../../../i18n';

const INPUT = `w-full px-3 h-9 rounded-xl text-sm bg-surface-raised
    border border-surface-active/60 text-gray-900 dark:text-white
    placeholder:text-gray-400 dark:placeholder:text-gray-500
    focus:outline-none focus:ring-2 focus:ring-gray-900/20 dark:focus:ring-white/25`;

const PRIMARY_BTN = `flex items-center justify-center gap-1.5 px-4 h-9 rounded-xl text-sm font-medium
    bg-gray-900 dark:bg-white text-white dark:text-gray-900
    hover:opacity-90 disabled:opacity-50 transition-opacity`;

const GHOST_BTN = `flex items-center justify-center gap-2 px-4 h-9 rounded-xl text-sm font-medium
    text-gray-700 dark:text-gray-200 border border-surface-active/60
    hover:bg-surface-control disabled:opacity-50 transition-colors`;

const DANGER_BTN = `flex items-center gap-2 px-4 h-9 rounded-xl text-sm font-medium
    text-red-600 dark:text-red-400 border border-red-200 dark:border-red-500/30
    hover:bg-red-50 dark:hover:bg-red-500/10 disabled:opacity-50 transition-colors`;

/**
 * "5 minutes ago". Short enough to sit on one line next to a button, which a
 * full locale timestamp is not.
 */
function ago(t, iso) {
    if (!iso) return '';

    const seconds = Math.round((Date.now() - new Date(iso).getTime()) / 1000);

    if (seconds < 60) return t('settings.sync.justNow');
    if (seconds < 3600) return t('settings.sync.minutesAgo', { count: Math.floor(seconds / 60) });
    if (seconds < 86400) return t('settings.sync.hoursAgo', { count: Math.floor(seconds / 3600) });

    return t('settings.sync.daysAgo', { count: Math.floor(seconds / 86400) });
}

const DOTS = {
    on: 'bg-emerald-500',
    busy: 'bg-blue-500',
    warn: 'bg-amber-500',
    error: 'bg-red-500',
    off: 'bg-surface-hover',
};

/** What a background job is doing: one dot, one line. */
function StatusLine({ tone, text, pulse = false }) {
    if (!text) return <span />;

    return (
        <p
            title={text}
            className={`min-w-0 flex items-center gap-2 text-sm
                ${tone === 'error' ? 'text-red-600 dark:text-red-400' : 'text-gray-500 dark:text-gray-400'}`}
        >
            <span
                className={`shrink-0 w-1.5 h-1.5 rounded-full
                    ${DOTS[tone] || DOTS.off} ${pulse ? 'animate-pulse' : ''}`}
            />
            <span className="truncate">{text}</span>
        </p>
    );
}

/** The state of the synced setup. */
function snapshotState(t, snapshot, saving) {
    if (!snapshot) return { tone: 'off', text: '' };

    // Before `blocked`, which reports being switched off as a reason a sync
    // cannot run. Off is a choice, not a fault, and should not read as one.
    if (!snapshot.enabled) return { tone: 'off', text: t('common.off') };

    if (saving) return { tone: 'busy', text: t('settings.sync.saving'), pulse: true };
    if (snapshot.blocked) return { tone: 'warn', text: snapshot.blocked };
    if (snapshot.lastError) return { tone: 'error', text: snapshot.lastError };
    if (snapshot.pending) return { tone: 'busy', text: t('settings.sync.saving'), pulse: true };
    if (!snapshot.lastPushAt) return { tone: 'on', text: t('settings.sync.notSavedYet') };

    return { tone: 'on', text: t('settings.sync.savedAgo', { when: ago(t, snapshot.lastPushAt) }) };
}

/**
 * A one-time recovery code, shown once and only once. The parent clears it
 * from state the moment this closes -- it is never written back to disk
 * here or anywhere downstream of it.
 */
function RecoveryCodeCard({ code, onDismiss, t }) {
    return (
        <SettingCard className="border-amber-300 dark:border-amber-500/40">
            <h4 className="text-base font-semibold text-gray-900 dark:text-white">
                {t('settings.sync.recoveryCodeTitle')}
            </h4>
            <p className="text-sm text-gray-500 dark:text-gray-400 mt-1">
                {t('settings.sync.recoveryCodeDesc')}
            </p>
            <p className="mt-4 px-4 py-3 rounded-xl bg-gray-900 text-white dark:bg-black
                font-mono text-base tracking-wider text-center select-all">
                {code}
            </p>
            <button type="button" onClick={onDismiss} className={`${PRIMARY_BTN} w-full mt-4`}>
                {t('settings.sync.recoveryCodeSaved')}
            </button>
        </SettingCard>
    );
}

export default function SyncPage() {
    const t = useT();
    const [status, setStatus] = useState(null);
    const [snapshot, setSnapshot] = useState(null);
    const [busy, setBusy] = useState('');
    const [recoveryCode, setRecoveryCode] = useState(null);

    const [serverUrlInput, setServerUrlInput] = useState('');
    const [mode, setMode] = useState('login'); // 'login' | 'register', which form is showing
    const [email, setEmail] = useState('');
    const [passphrase, setPassphrase] = useState('');
    const [confirmPassphrase, setConfirmPassphrase] = useState('');
    const [recoveryInput, setRecoveryInput] = useState('');
    const [showRecoveryForm, setShowRecoveryForm] = useState(false);
    const [currentPassphrase, setCurrentPassphrase] = useState('');
    const [newPassphrase, setNewPassphrase] = useState('');

    // Recovering from a fully logged-out state: no session anywhere, needs
    // both an emailed token and the account recovery code together.
    const [showForgotFlow, setShowForgotFlow] = useState(false);
    const [forgotStep, setForgotStep] = useState('request'); // 'request' | 'complete'
    const [forgotToken, setForgotToken] = useState('');

    const notify = useCallback((kind, message) => {
        toast[kind](message, { style: getToastStyle() });
    }, []);

    useEffect(() => {
        window.api.syncConnection.status().then(setStatus);
        window.api.cloudSnapshot.status().then(setSnapshot);
    }, []);

    useEffect(() => window.api.syncConnection.onState(setStatus), []);
    useEffect(() => window.api.cloudSnapshot.onState(setSnapshot), []);

    const handleConfigure = useCallback(async (event) => {
        event.preventDefault();
        setBusy('configure');

        try {
            const result = await window.api.syncConnection.configure(serverUrlInput);
            if (!result.success) {
                notify('error', result.message);
                return;
            }
            setStatus(result.status);
        } finally {
            setBusy('');
        }
    }, [serverUrlInput, notify]);

    const handleRegister = useCallback(async (event) => {
        event.preventDefault();

        if (passphrase !== confirmPassphrase) {
            notify('error', t('settings.sync.passphraseMismatch'));
            return;
        }

        setBusy('register');

        try {
            const result = await window.api.syncConnection.register(email, passphrase);
            if (!result.success) {
                notify('error', result.message);
                return;
            }
            setStatus(result.status);
            setRecoveryCode(result.recoveryCode);
            setPassphrase('');
            setConfirmPassphrase('');
        } finally {
            setBusy('');
        }
    }, [email, passphrase, confirmPassphrase, notify, t]);

    const handleLogin = useCallback(async (event) => {
        event.preventDefault();
        setBusy('login');

        try {
            const result = await window.api.syncConnection.login(email, passphrase);
            if (!result.success) {
                notify('error', result.message);
                return;
            }
            setStatus(result.status);
            setPassphrase('');
        } finally {
            setBusy('');
        }
    }, [email, passphrase, notify]);

    const handleRecoveryUnlock = useCallback(async (event) => {
        event.preventDefault();
        setBusy('recovery');

        try {
            const result = await window.api.syncConnection.unlockWithRecoveryCode(recoveryInput);
            if (!result.success) {
                notify('error', result.message);
                return;
            }
            setStatus(result.status);
            setRecoveryInput('');
            setShowRecoveryForm(false);
            if (result.recoveryCode) setRecoveryCode(result.recoveryCode);
        } finally {
            setBusy('');
        }
    }, [recoveryInput, notify]);

    const handleForgotStart = useCallback(async (event) => {
        event.preventDefault();
        setBusy('forgotStart');

        try {
            const result = await window.api.syncConnection.recoverStart(email);
            if (!result.success) {
                notify('error', result.message);
                return;
            }
            notify('success', result.message);
            setForgotStep('complete');
        } finally {
            setBusy('');
        }
    }, [email, notify]);

    const handleForgotComplete = useCallback(async (event) => {
        event.preventDefault();

        if (newPassphrase !== confirmPassphrase) {
            notify('error', t('settings.sync.passphraseMismatch'));
            return;
        }

        setBusy('forgotComplete');

        try {
            const result = await window.api.syncConnection.recoverComplete(
                email, forgotToken, recoveryInput, newPassphrase,
            );
            if (!result.success) {
                notify('error', result.message);
                return;
            }
            setStatus(result.status);
            if (result.recoveryCode) setRecoveryCode(result.recoveryCode);

            setShowForgotFlow(false);
            setForgotStep('request');
            setForgotToken('');
            setRecoveryInput('');
            setNewPassphrase('');
            setConfirmPassphrase('');
        } finally {
            setBusy('');
        }
    }, [email, forgotToken, recoveryInput, newPassphrase, confirmPassphrase, notify, t]);

    const handleDisconnect = useCallback(async () => {
        setBusy('disconnect');

        try {
            const result = await window.api.syncConnection.logout();
            setStatus(result.status);
            notify(result.revoked ? 'success' : 'error', result.revoked
                ? t('settings.sync.disconnected')
                : t('settings.sync.disconnectedLocally'));
        } finally {
            setBusy('');
        }
    }, [notify, t]);

    const handleChangePassphrase = useCallback(async (event) => {
        event.preventDefault();
        setBusy('changePassphrase');

        try {
            const result = await window.api.syncConnection.changePassphrase(currentPassphrase, newPassphrase);
            if (!result.success) {
                notify('error', result.message);
                return;
            }
            setStatus(result.status);
            setCurrentPassphrase('');
            setNewPassphrase('');
            notify('success', t('settings.sync.passphraseChanged'));
        } finally {
            setBusy('');
        }
    }, [currentPassphrase, newPassphrase, notify, t]);

    const handleToggleSnapshot = useCallback(async (enabled) => {
        setSnapshot(await window.api.cloudSnapshot.setEnabled(enabled));
        notify('success', enabled ? t('settings.sync.syncOn') : t('settings.sync.syncOff'));
    }, [notify, t]);

    const handleSnapshotPush = useCallback(async () => {
        setBusy('snapshot');

        try {
            const { result, status: next } = await window.api.cloudSnapshot.push();
            setSnapshot(next);

            if (result?.error) notify('error', result.error);
            else if (result?.skipped) notify('error', result.skipped);
            else notify('success', t('settings.sync.savedNow'));
        } finally {
            setBusy('');
        }
    }, [notify, t]);

    if (!status) return <SettingsPage title={t('settings.sync.title')} />;

    // The one-time recovery code takes over the whole page until it's
    // dismissed -- it must not be possible to navigate away and lose sight
    // of it by accident.
    if (recoveryCode) {
        return (
            <SettingsPage title={t('settings.sync.title')}>
                <RecoveryCodeCard code={recoveryCode} onDismiss={() => setRecoveryCode(null)} t={t} />
            </SettingsPage>
        );
    }

    /* ---------------- no server configured yet ---------------- */

    if (!status.serverUrl) {
        return (
            <SettingsPage title={t('settings.sync.title')} description={t('settings.sync.intro')}>
                <SettingCard>
                    <form onSubmit={handleConfigure} className="flex flex-col gap-3">
                        <h4 className="text-base font-semibold text-gray-900 dark:text-white">
                            {t('settings.sync.serverTitle')}
                        </h4>
                        <p className="text-sm text-gray-500 dark:text-gray-400">
                            {t('settings.sync.serverDesc')}
                        </p>
                        <input
                            type="text"
                            value={serverUrlInput}
                            onChange={(event) => setServerUrlInput(event.target.value)}
                            placeholder={t('settings.sync.serverPlaceholder')}
                            className={INPUT}
                            autoFocus
                        />
                        <button type="submit" disabled={Boolean(busy)} className={`${PRIMARY_BTN} self-start`}>
                            {t('settings.sync.serverConnect')}
                        </button>
                    </form>
                </SettingCard>
            </SettingsPage>
        );
    }

    const serverHost = (() => {
        try {
            return new URL(status.serverUrl).host;
        } catch {
            return status.serverUrl;
        }
    })();

    /* ---------------- configured, but not signed in ---------------- */

    if (!status.connected) {
        return (
            <SettingsPage title={t('settings.sync.title')}>
                <SettingCard>
                    <p className="text-sm text-gray-500 dark:text-gray-400">
                        {t('settings.sync.connectedTo', { server: serverHost })}
                    </p>

                    {!showForgotFlow ? (
                        <>
                            <div className="flex gap-1 mt-4 p-1 rounded-xl bg-surface-raised w-fit">
                                {['login', 'register'].map((option) => (
                                    <button
                                        key={option}
                                        type="button"
                                        onClick={() => setMode(option)}
                                        className={`px-4 h-8 rounded-lg text-sm font-medium transition-colors
                                            ${mode === option
                                                ? 'bg-surface-active text-gray-900 dark:text-white shadow-sm'
                                                : 'text-gray-500 dark:text-gray-400'}`}
                                    >
                                        {t(`settings.sync.${option === 'login' ? 'loginTab' : 'registerTab'}`)}
                                    </button>
                                ))}
                            </div>

                            <form
                                onSubmit={mode === 'login' ? handleLogin : handleRegister}
                                className="flex flex-col gap-3 mt-4"
                            >
                                <input
                                    type="email"
                                    required
                                    value={email}
                                    onChange={(event) => setEmail(event.target.value)}
                                    placeholder={t('settings.sync.emailPlaceholder')}
                                    className={INPUT}
                                    autoComplete="email"
                                />
                                <input
                                    type="password"
                                    required
                                    value={passphrase}
                                    onChange={(event) => setPassphrase(event.target.value)}
                                    placeholder={t('settings.sync.passphrasePlaceholder')}
                                    className={INPUT}
                                    autoComplete={mode === 'login' ? 'current-password' : 'new-password'}
                                />
                                {mode === 'register' && (
                                    <input
                                        type="password"
                                        required
                                        value={confirmPassphrase}
                                        onChange={(event) => setConfirmPassphrase(event.target.value)}
                                        placeholder={t('settings.sync.confirmPassphrasePlaceholder')}
                                        className={INPUT}
                                        autoComplete="new-password"
                                    />
                                )}
                                <div className="flex items-center gap-3">
                                    <button
                                        type="submit"
                                        disabled={Boolean(busy)}
                                        className={PRIMARY_BTN}
                                    >
                                        {mode === 'login'
                                            ? t('settings.sync.loginAction')
                                            : t('settings.sync.registerAction')}
                                    </button>
                                    {mode === 'login' && (
                                        <button
                                            type="button"
                                            onClick={() => setShowForgotFlow(true)}
                                            className="text-sm text-gray-500 dark:text-gray-400 hover:text-gray-900 dark:hover:text-white"
                                        >
                                            {t('settings.sync.forgotPassphrase')}
                                        </button>
                                    )}
                                </div>
                            </form>
                        </>
                    ) : forgotStep === 'request' ? (
                        <form onSubmit={handleForgotStart} className="flex flex-col gap-3 mt-4">
                            <p className="text-sm text-gray-500 dark:text-gray-400">
                                {t('settings.sync.forgotRequestDesc')}
                            </p>
                            <input
                                type="email"
                                required
                                value={email}
                                onChange={(event) => setEmail(event.target.value)}
                                placeholder={t('settings.sync.emailPlaceholder')}
                                className={INPUT}
                                autoComplete="email"
                                autoFocus
                            />
                            <div className="flex items-center gap-3">
                                <button type="submit" disabled={Boolean(busy)} className={PRIMARY_BTN}>
                                    {t('settings.sync.forgotSendAction')}
                                </button>
                                <button
                                    type="button"
                                    onClick={() => setShowForgotFlow(false)}
                                    className="text-sm text-gray-500 dark:text-gray-400 hover:text-gray-900 dark:hover:text-white"
                                >
                                    {t('common.cancel')}
                                </button>
                            </div>
                        </form>
                    ) : (
                        <form onSubmit={handleForgotComplete} className="flex flex-col gap-3 mt-4">
                            <p className="text-sm text-gray-500 dark:text-gray-400">
                                {t('settings.sync.forgotCompleteDesc')}
                            </p>
                            <input
                                type="text"
                                required
                                value={forgotToken}
                                onChange={(event) => setForgotToken(event.target.value)}
                                placeholder={t('settings.sync.forgotTokenPlaceholder')}
                                className={INPUT}
                                autoFocus
                            />
                            <input
                                type="text"
                                required
                                value={recoveryInput}
                                onChange={(event) => setRecoveryInput(event.target.value)}
                                placeholder={t('settings.sync.recoveryCodePlaceholder')}
                                className={`${INPUT} font-mono`}
                            />
                            <input
                                type="password"
                                required
                                value={newPassphrase}
                                onChange={(event) => setNewPassphrase(event.target.value)}
                                placeholder={t('settings.sync.newPassphrasePlaceholder')}
                                className={INPUT}
                                autoComplete="new-password"
                            />
                            <input
                                type="password"
                                required
                                value={confirmPassphrase}
                                onChange={(event) => setConfirmPassphrase(event.target.value)}
                                placeholder={t('settings.sync.confirmPassphrasePlaceholder')}
                                className={INPUT}
                                autoComplete="new-password"
                            />
                            <div className="flex items-center gap-3">
                                <button type="submit" disabled={Boolean(busy)} className={PRIMARY_BTN}>
                                    {t('settings.sync.forgotCompleteAction')}
                                </button>
                                <button
                                    type="button"
                                    onClick={() => { setShowForgotFlow(false); setForgotStep('request'); }}
                                    className="text-sm text-gray-500 dark:text-gray-400 hover:text-gray-900 dark:hover:text-white"
                                >
                                    {t('common.cancel')}
                                </button>
                            </div>
                        </form>
                    )}
                </SettingCard>
            </SettingsPage>
        );
    }

    /* ---------------- signed in, but not unlocked ---------------- */

    if (!status.unlocked) {
        return (
            <SettingsPage title={t('settings.sync.title')}>
                <SettingCard>
                    <h4 className="text-base font-semibold text-gray-900 dark:text-white">
                        {t('settings.sync.unlockTitle')}
                    </h4>
                    <p className="text-sm text-gray-500 dark:text-gray-400 mt-1">
                        {t('settings.sync.unlockDesc')}
                    </p>

                    {!showRecoveryForm ? (
                        <form onSubmit={handleLogin} className="flex flex-col gap-3 mt-4">
                            <input type="hidden" value={email} readOnly />
                            <input
                                type="email"
                                required
                                value={email}
                                onChange={(event) => setEmail(event.target.value)}
                                placeholder={t('settings.sync.emailPlaceholder')}
                                className={INPUT}
                                autoComplete="email"
                            />
                            <input
                                type="password"
                                required
                                value={passphrase}
                                onChange={(event) => setPassphrase(event.target.value)}
                                placeholder={t('settings.sync.passphrasePlaceholder')}
                                className={INPUT}
                                autoComplete="current-password"
                                autoFocus
                            />
                            <div className="flex items-center gap-3">
                                <button type="submit" disabled={Boolean(busy)} className={PRIMARY_BTN}>
                                    {t('settings.sync.unlockAction')}
                                </button>
                                <button
                                    type="button"
                                    onClick={() => setShowRecoveryForm(true)}
                                    className="text-sm text-gray-500 dark:text-gray-400 hover:text-gray-900 dark:hover:text-white"
                                >
                                    {t('settings.sync.useRecoveryCode')}
                                </button>
                            </div>
                        </form>
                    ) : (
                        <form onSubmit={handleRecoveryUnlock} className="flex flex-col gap-3 mt-4">
                            <input
                                type="text"
                                required
                                value={recoveryInput}
                                onChange={(event) => setRecoveryInput(event.target.value)}
                                placeholder={t('settings.sync.recoveryCodePlaceholder')}
                                className={`${INPUT} font-mono`}
                                autoFocus
                            />
                            <div className="flex items-center gap-3">
                                <button type="submit" disabled={Boolean(busy)} className={PRIMARY_BTN}>
                                    {t('settings.sync.unlockAction')}
                                </button>
                                <button
                                    type="button"
                                    onClick={() => setShowRecoveryForm(false)}
                                    className="text-sm text-gray-500 dark:text-gray-400 hover:text-gray-900 dark:hover:text-white"
                                >
                                    {t('common.cancel')}
                                </button>
                            </div>
                        </form>
                    )}
                </SettingCard>
            </SettingsPage>
        );
    }

    /* ---------------- connected and unlocked ---------------- */

    return (
        <SettingsPage title={t('settings.sync.title')}>
            <SettingCard>
                <div className="flex items-center gap-3">
                    <span
                        aria-hidden="true"
                        className="w-10 h-10 shrink-0 rounded-full flex items-center justify-center
                            text-sm font-semibold bg-gray-900 text-white dark:bg-white dark:text-gray-900"
                    >
                        {(status.email || '?').trim().charAt(0).toUpperCase()}
                    </span>

                    <div className="min-w-0 flex-1">
                        <p className="text-base font-semibold text-gray-900 dark:text-white truncate">
                            {status.email}
                        </p>
                        <p className="text-sm text-gray-500 dark:text-gray-400 truncate">{serverHost}</p>
                    </div>

                    <button
                        type="button"
                        onClick={handleDisconnect}
                        disabled={Boolean(busy)}
                        className={DANGER_BTN}
                    >
                        <Logout01Icon size={16} strokeWidth={1.8} />
                        {busy === 'disconnect' ? t('settings.sync.disconnecting') : t('settings.sync.disconnect')}
                    </button>
                </div>

                <SettingRow
                    className={DIVIDED}
                    title={t('settings.sync.enableSync')}
                    description={t('settings.sync.enableSyncDesc')}
                    align="center"
                    control={
                        <Toggle
                            checked={Boolean(snapshot?.enabled)}
                            onChange={handleToggleSnapshot}
                            disabled={Boolean(busy) || !snapshot}
                            ariaLabel={t('settings.sync.enableSync')}
                        />
                    }
                >
                    <div className="flex items-center justify-between gap-4">
                        <StatusLine {...snapshotState(t, snapshot, busy === 'snapshot')} />

                        <button
                            type="button"
                            onClick={handleSnapshotPush}
                            disabled={Boolean(busy) || !snapshot?.enabled}
                            className={GHOST_BTN}
                        >
                            <RefreshIcon size={16} strokeWidth={1.8} />
                            {busy === 'snapshot' ? t('settings.sync.saving') : t('settings.sync.saveNow')}
                        </button>
                    </div>
                </SettingRow>
            </SettingCard>

            <SettingCard>
                <h4 className="text-base font-semibold text-gray-900 dark:text-white">
                    {t('settings.sync.changePassphraseTitle')}
                </h4>
                <p className="text-sm text-gray-500 dark:text-gray-400 mt-1">
                    {t('settings.sync.changePassphraseDesc')}
                </p>
                <form onSubmit={handleChangePassphrase} className="flex flex-col gap-3 mt-4">
                    <input
                        type="password"
                        required
                        value={currentPassphrase}
                        onChange={(event) => setCurrentPassphrase(event.target.value)}
                        placeholder={t('settings.sync.currentPassphrasePlaceholder')}
                        className={INPUT}
                        autoComplete="current-password"
                    />
                    <input
                        type="password"
                        required
                        value={newPassphrase}
                        onChange={(event) => setNewPassphrase(event.target.value)}
                        placeholder={t('settings.sync.newPassphrasePlaceholder')}
                        className={INPUT}
                        autoComplete="new-password"
                    />
                    <button type="submit" disabled={Boolean(busy)} className={`${PRIMARY_BTN} self-start`}>
                        <Key01Icon size={16} strokeWidth={1.8} />
                        {t('settings.sync.changePassphraseAction')}
                    </button>
                </form>
            </SettingCard>
        </SettingsPage>
    );
}
