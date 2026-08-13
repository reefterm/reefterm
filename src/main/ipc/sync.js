const syncConnection = require('../sync-connection');
const cloudSnapshot = require('../cloud-snapshot');
const activity = require('../activity');

function register({ handle, notify }) {
    /* ---------------- Sync server connection ----------------
     *
     * A connection to a self-hosted sync server -- not an account this app
     * manages, and nothing here is required. The whole exchange happens in
     * main: the passphrase, the recovery code and the session token never
     * cross the bridge. Only status comes back.
     */

    handle('sync-connection-status', () => syncConnection.status());

    handle('sync-connection-configure', (event, serverUrl) => {
        try {
            return { success: true, status: syncConnection.configure(serverUrl) };
        } catch (error) {
            return { success: false, message: error.message };
        }
    });

    handle('sync-connection-register', async (event, { email, passphrase } = {}) => {
        try {
            const { status, recoveryCode } = await syncConnection.register(email, passphrase);

            activity.record({
                category: 'security',
                action: 'sync.connect',
                outcome: 'success',
                target: 'sync server',
                detail: status.email || '',
            });

            notify('sync-connection-state', status);

            // Symmetrical with sign-in below: a brand new connection has no
            // data of its own yet to pull, but the next device that connects
            // to this same account will, and force makes sure a stale local
            // revision doesn't make that pull think there's nothing to do.
            cloudSnapshot.pull({ force: true })
                .catch(error => console.error('Post-registration restore failed:', error.message));

            return { success: true, status, recoveryCode };
        } catch (error) {
            activity.record({
                category: 'security',
                action: 'sync.connect',
                outcome: 'failure',
                target: 'sync server',
                message: error.message,
            });

            return { success: false, message: error.message };
        }
    });

    handle('sync-connection-login', async (event, { email, passphrase } = {}) => {
        try {
            const status = await syncConnection.login(email, passphrase);

            activity.record({
                category: 'security',
                action: 'sync.connect',
                outcome: 'success',
                target: 'sync server',
                detail: status.email || '',
            });

            // The sidebar shows the connection status, and it is not the
            // thing that asked for this, so it has to be told.
            notify('sync-connection-state', status);

            /*
             * Logging in is the one moment a device is connected and has none
             * of its data yet. This normally runs at launch, which for a
             * fresh login has already been and gone, so without this the
             * setup only appears on the next poll or the next restart.
             *
             * Forced, because a stale revision left by a previous connection
             * would otherwise make the pull decide it was already up to date.
             *
             * Not awaited: the login round trip is already over and the user
             * is looking at the app. The pull reports itself through its own
             * event when it lands.
             */
            cloudSnapshot.pull({ force: true })
                .catch(error => console.error('Post sign-in restore failed:', error.message));

            return { success: true, status };
        } catch (error) {
            activity.record({
                category: 'security',
                action: 'sync.connect',
                outcome: 'failure',
                target: 'sync server',
                message: error.message,
            });

            return { success: false, message: error.message };
        }
    });

    handle('sync-connection-logout', async () => {
        const email = syncConnection.status().email || '';
        const { status, revoked } = await syncConnection.logout();

        activity.record({
            category: 'security',
            action: 'sync.disconnect',
            // A local disconnect that could not reach the server leaves a
            // live token behind, so it is not the same outcome as a clean one.
            outcome: revoked ? 'success' : 'failure',
            target: 'sync server',
            detail: email,
            message: revoked ? '' : 'Disconnected locally; the server could not be reached to revoke the session',
        });

        // The revision belongs to the connection that just ended, not to
        // this machine.
        cloudSnapshot.reset();

        notify('sync-connection-state', status);

        return { success: true, revoked, status };
    });

    handle('sync-connection-refresh', async () => {
        try {
            return { success: true, status: await syncConnection.refresh() };
        } catch (error) {
            return { success: false, message: error.message, status: syncConnection.status() };
        }
    });

    handle('sync-connection-unlock-with-recovery-code', async (event, recoveryCode) => {
        try {
            const { status, recoveryCode: newCode } = await syncConnection.unlockWithRecoveryCode(recoveryCode);
            notify('sync-connection-state', status);
            return { success: true, status, recoveryCode: newCode };
        } catch (error) {
            return { success: false, message: error.message };
        }
    });

    handle('sync-connection-change-passphrase', async (event, { currentPassphrase, newPassphrase } = {}) => {
        try {
            const status = await syncConnection.changePassphrase(currentPassphrase, newPassphrase);
            notify('sync-connection-state', status);
            return { success: true, status };
        } catch (error) {
            return { success: false, message: error.message };
        }
    });

    // Recovering from a fully logged-out state: no session, passphrase
    // forgotten. Two steps, matching the server's own split -- start proves
    // email control, complete needs both the emailed token and the account's
    // recovery code together.
    handle('sync-connection-recover-start', async (event, email) => {
        try {
            const message = await syncConnection.recoverStart(email);
            return { success: true, message };
        } catch (error) {
            return { success: false, message: error.message };
        }
    });

    handle('sync-connection-recover-complete', async (event, { email, token, recoveryCode, newPassphrase } = {}) => {
        try {
            const { status, recoveryCode: newCode } =
                await syncConnection.recoverComplete(email, token, recoveryCode, newPassphrase);

            activity.record({
                category: 'security',
                action: 'sync.connect',
                outcome: 'success',
                target: 'sync server',
                detail: `${status.email || ''} (recovered)`,
            });

            notify('sync-connection-state', status);

            cloudSnapshot.pull({ force: true })
                .catch(error => console.error('Post-recovery restore failed:', error.message));

            return { success: true, status, recoveryCode: newCode };
        } catch (error) {
            activity.record({
                category: 'security',
                action: 'sync.connect',
                outcome: 'failure',
                target: 'sync server',
                message: `recovery failed: ${error.message}`,
            });

            return { success: false, message: error.message };
        }
    });
}

module.exports = { register };
