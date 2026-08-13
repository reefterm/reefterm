const { app, dialog } = require('electron');
const fs = require('fs');
const path = require('path');
const store = require('../store');
const keygen = require('../keygen');
const certificate = require('../certificate');
const hello = require('../hello');
const importCommon = require('../import-common');

/**
 * What to store alongside a key's certificate, and whether to accept it at all.
 *
 * Read once here rather than on every render: the renderer cannot parse SSH
 * wire format, and the answers (who it lets you log in as, when it stops
 * working) are the ones a keychain has to show. A certificate that cannot be
 * read, or that belongs to some other key, is refused at the point it is
 * pasted. The alternative is storing it and finding out on a server, where it
 * arrives as "permission denied" with nothing to connect it to.
 */
function describeCertificate(key) {
    const text = String(key.certificate || '').trim();
    if (!text) return { certificate: '', certificateInfo: null };

    // Throws with its own message on anything malformed, which the save
    // reports; there is nothing useful to store for a certificate we cannot
    // read, and silently blanking it would look like it had been saved.
    const details = certificate.parse(text);

    // Checked against the public half when there is one, because that works
    // while editing a key whose private key was left alone. Falling back to the
    // private key covers a fresh import that pasted no public key.
    let matches = certificate.matchesPublicKey(text, key.publicKey);
    if (matches === null && key.privateKey) {
        matches = certificate.matchesKey(text, key.privateKey, key.passphrase);
    }
    if (matches === false) {
        throw new Error('That certificate was issued for a different key');
    }

    if (details.kind === 'host') {
        throw new Error('That is a host certificate; a key needs a user certificate to log in with');
    }

    return {
        certificate: text,
        certificateInfo: {
            type: details.type,
            keyId: details.keyId,
            principals: details.principals,
            validAfter: details.validAfter,
            validBefore: details.validBefore,
            caFingerprint: details.caFingerprint,
            serial: details.serial,
        },
    };
}

// A private key file is a few KB at the very outside. The cap is here so that
// pointing the picker at a disk image reports what it is instead of reading the
// whole thing into memory to find out it is not a key.
const MAX_KEY_BYTES = 256 * 1024;

/**
 * The certificate OpenSSH keeps next to a key, if there is one.
 *
 * `ssh` looks for `<identity>-cert.pub` beside the key it was given, and this
 * looks in the same place. Anything that is not a certificate line is ignored
 * rather than reported: a file that happens to sit there under that name is not
 * an error in the import, it is just not a certificate.
 */
function readCertificateFile(privateKeyPath) {
    const certPath = `${privateKeyPath}-cert.pub`;
    try {
        if (fs.statSync(certPath).size > MAX_KEY_BYTES) return '';
        const text = fs.readFileSync(certPath, 'utf8').trim();
        return text.includes('-cert-v01@openssh.com') ? text : '';
    } catch {
        return '';
    }
}

// pendingKeyId -> freshly generated private key, awaiting a save.
const pendingKeys = new Map();
let pendingCounter = 0;

function register({ handle, getWindow }) {
    /* ---------------- Store: keychain ---------------- */

    handle('get-keys', () => store.getKeys());

    handle('save-key', (event, key) => {
        const { pendingKeyId, ...rest } = key;
        // A freshly generated private key is claimed by reference so it never
        // has to travel through the renderer.
        if (pendingKeyId && pendingKeys.has(pendingKeyId)) {
            rest.privateKey = pendingKeys.get(pendingKeyId);
            pendingKeys.delete(pendingKeyId);
        }

        // The key names its own algorithm and fingerprints its own public half,
        // so neither is taken from the form: an import has no type picker to
        // read, and a generated key would only be restating what came back from
        // ssh-keygen. Whatever cannot be read leaves the stored value alone.
        return store.saveKey({ ...rest, ...keygen.identify(rest), ...describeCertificate(rest) });
    });

    // A Hello key's material is in the TPM, not in the store, so deleting the
    // record has to take the credential with it or it is left orphaned there
    // with nothing able to name it again.
    handle('delete-key', async (event, keyId) => {
        const credential = store.getKeys().find(key => key.id === keyId)?.helloCredential;
        const removed = store.deleteKey(keyId);
        if (credential) await hello.remove(credential);
        return removed;
    });

    /* ---------------- Store: Windows Hello keys ---------------- */

    handle('hello-supported', () => hello.isSupported());

    /**
     * Enrol a Windows Hello credential and save it as a keychain entry.
     *
     * The credential is named after the record that will point at it, so the
     * two cannot drift apart, and it is created before the record is written:
     * a cancelled prompt should leave nothing behind, where a record with no
     * credential would be a key that looks usable and is not.
     */
    handle('create-hello-key', async (event, { name, comment } = {}) => {
        const id = `key-${Date.now()}`;
        const credential = `reefterm-${id}`;
        const enrolled = await hello.create(credential, comment || 'windows-hello');

        try {
            return store.saveKey({
                id,
                name: name || 'Windows Hello',
                type: 'RSA',
                hello: true,
                helloCredential: credential,
                helloPublicKey: enrolled.spki,
                publicKey: enrolled.publicKey,
                fingerprint: enrolled.fingerprint,
                comment: comment || '',
            });
        } catch (error) {
            // The record is what makes the credential reachable; without one it
            // is an orphan in the TPM that nothing will ever ask for again.
            await hello.remove(credential);
            throw error;
        }
    });

    handle('generate-key', async (event, options) => {
        const { privateKey, publicKey, fingerprint } = await keygen.generate(options);
        const pendingKeyId = `pending-${++pendingCounter}`;
        pendingKeys.set(pendingKeyId, privateKey);
        return { publicKey, fingerprint, pendingKeyId };
    });

    /**
     * Take a key off disk, the way `ssh -i` would find it.
     *
     * Pasting a private key into a textarea was the only way in, which meant
     * opening `id_ed25519` in something else first and putting the whole of it
     * on the clipboard. Picking the file instead reads it here, so the private
     * half is held by the same map a generated one is and never crosses the
     * bridge: the renderer is handed an id, a fingerprint and the public halves.
     *
     * The two files OpenSSH keeps beside a key come with it. `id_ed25519.pub`
     * is where the fingerprint and the algorithm are most reliably read from,
     * and `id_ed25519-cert.pub` is exactly what `ssh` picks up on its own, so
     * requiring either to be found and pasted separately would be busywork.
     *
     * `replaces` is the id handed out by an earlier pick in the same form. A
     * second choice drops the first rather than leaving a private key sitting
     * in memory for a file the user changed their mind about.
     */
    handle('import-key-file', async (event, { replaces } = {}) => {
        if (replaces) pendingKeys.delete(replaces);

        const sshDir = path.join(app.getPath('home'), '.ssh');
        const { canceled, filePaths } = await dialog.showOpenDialog(getWindow(), {
            title: 'Choose a private key',
            // Only when it is there: a defaultPath that does not exist opens
            // somewhere arbitrary rather than the folder it names.
            defaultPath: fs.existsSync(sshDir) ? sshDir : undefined,
            // Hidden files, because `.ssh` itself is one on every platform.
            properties: ['openFile', 'showHiddenFiles'],
            // "All files" leads, since the keys people came here for have no
            // extension at all: an extension filter hides `id_ed25519`.
            filters: [
                { name: 'All files', extensions: ['*'] },
                { name: 'PEM and PuTTY keys', extensions: ['pem', 'key', 'ppk'] },
            ],
        });

        const filePath = filePaths?.[0];
        if (canceled || !filePath) return { success: false, canceled: true };

        try {
            const { size } = await fs.promises.stat(filePath);
            if (size > MAX_KEY_BYTES) {
                return {
                    success: false,
                    message: `That file is ${Math.round(size / 1024)} KB. No private key is `
                        + 'anywhere near that big, so this is something else.',
                };
            }
        } catch (error) {
            return { success: false, message: error.message };
        }

        const inspected = importCommon.inspectIdentityFile(filePath);

        if (inspected.state === 'ppk') {
            return {
                success: false,
                message: 'That is a PuTTY .ppk file, which this cannot read as it stands. '
                    + 'PuTTYgen can export it as an OpenSSH key, and that file imports fine.',
            };
        }

        if (inspected.state !== 'ready' && inspected.state !== 'encrypted') {
            return { success: false, message: inspected.reason || 'That file is not a private key' };
        }

        const pendingKeyId = `pending-${++pendingCounter}`;
        pendingKeys.set(pendingKeyId, inspected.text);

        const publicHalf = importCommon.readPublicKey(filePath);

        return {
            success: true,
            pendingKeyId,
            file: path.basename(filePath),
            type: inspected.type || '',
            // Worth saying out loud in the form: an encrypted key saved without
            // its passphrase is a key that cannot dial, and the failure comes
            // much later, at the far end of a connection attempt.
            encrypted: inspected.state === 'encrypted',
            fingerprint: publicHalf?.fingerprint || inspected.fingerprint || '',
            publicKey: publicHalf?.text || '',
            certificate: readCertificateFile(filePath),
        };
    });
}

/** Drop any freshly generated or imported key nobody has saved yet. */
function clearPending() {
    pendingKeys.clear();
}

module.exports = { register, clearPending };
