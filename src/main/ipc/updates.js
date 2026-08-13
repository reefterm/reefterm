const updates = require('../updates');

function register({ handle }) {
    /* ---------------- Updates ----------------
     *
     * Behind the lock like everything else, which costs nothing: the lock
     * screen shows no title bar and no settings, so there is no update UI to
     * reach while locked. The check on the timer runs in main regardless, so a
     * locked app still knows about a new build by the time it is unlocked.
     */

    handle('updates-status', () => updates.status());
    handle('updates-check', () => updates.check({ manual: true }));
    handle('updates-download', () => updates.download());
    handle('updates-install', () => updates.install());
    handle('updates-open', () => updates.open());
    handle('updates-dismiss', () => updates.dismiss());
}

module.exports = { register };
