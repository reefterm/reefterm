/**
 * The os/distro vocabulary shared by live SSH detection and template-name
 * classification.
 *
 * Both paths matter equally: a host synced from the panel and the same host
 * after connecting must agree, or the icon changes under the user for no
 * visible reason.
 */
const path = require('path');
const assert = require('assert');
const { describe, test } = require('node:test');

const {
    classifyShellOutput,
    classifyTemplateName,
} = require(path.join(__dirname, '..', 'src', 'main', 'os-detect.js'));

describe('os detection: shell output', () => {
    test('reads a real os-release', () => {
        const output = 'NAME="Ubuntu"\nID=ubuntu\nVERSION_ID="22.04"\n---UNAME---\nLinux web 5.15.0 x86_64';
        assert.deepStrictEqual(classifyShellOutput(output), { os: 'linux', distro: 'ubuntu' });
    });

    test('prefers the derivative over its base', () => {
        assert.strictEqual(classifyShellOutput('ID=kubuntu\nID_LIKE=ubuntu debian').distro, 'kubuntu');
        assert.strictEqual(classifyShellOutput('ID=manjaro\nID_LIKE=arch').distro, 'manjaro');
    });

    test('recognises the non-Linux families', () => {
        assert.strictEqual(classifyShellOutput('Darwin Kernel Version 23.0').os, 'macos');
        assert.strictEqual(classifyShellOutput('FreeBSD host 14.0-RELEASE').os, 'freebsd');
        assert.strictEqual(classifyShellOutput('OpenBSD host 7.4').os, 'openbsd');
    });

    test('carries no distro for a non-Linux OS', () => {
        assert.strictEqual(classifyShellOutput('Darwin ... arch ...').distro, '');
    });

    test('falls back to plain linux when nothing matches', () => {
        assert.deepStrictEqual(classifyShellOutput('Linux box 6.1.0 x86_64'), { os: 'linux', distro: '' });
    });

    test('survives empty and missing output', () => {
        assert.deepStrictEqual(classifyShellOutput(''), { os: 'linux', distro: '' });
        assert.deepStrictEqual(classifyShellOutput(undefined), { os: 'linux', distro: '' });
    });
});

describe('os detection: provisioning template names', () => {
    test('maps the common templates', () => {
        assert.deepStrictEqual(classifyTemplateName('Ubuntu 22.04'), { os: 'linux', distro: 'ubuntu' });
        assert.deepStrictEqual(classifyTemplateName('Debian 12'), { os: 'linux', distro: 'debian' });
        assert.deepStrictEqual(classifyTemplateName('AlmaLinux 9'), { os: 'linux', distro: 'alma' });
        assert.deepStrictEqual(classifyTemplateName('Rocky Linux 9'), { os: 'linux', distro: 'rocky' });
        assert.deepStrictEqual(classifyTemplateName('CentOS 7'), { os: 'linux', distro: 'centos' });
        assert.deepStrictEqual(classifyTemplateName('Fedora 40'), { os: 'linux', distro: 'fedora' });
        assert.deepStrictEqual(classifyTemplateName('Alpine Linux 3.19'), { os: 'linux', distro: 'alpine' });
    });

    test('maps Windows templates', () => {
        assert.deepStrictEqual(classifyTemplateName('Windows Server 2022'), { os: 'windows', distro: '' });
    });

    test('uses the version field when the name alone is bare', () => {
        assert.deepStrictEqual(classifyTemplateName('Ubuntu', '24.04'), { os: 'linux', distro: 'ubuntu' });
    });

    test('says nothing rather than guessing for an unidentifiable template', () => {
        assert.deepStrictEqual(classifyTemplateName('Custom image'), { os: '', distro: '' });
        assert.deepStrictEqual(classifyTemplateName(''), { os: '', distro: '' });
        assert.deepStrictEqual(classifyTemplateName(null), { os: '', distro: '' });
    });

    test('still reports linux when a template names no distribution', () => {
        assert.deepStrictEqual(classifyTemplateName('Generic Linux'), { os: 'linux', distro: '' });
    });

    test('agrees with shell detection on the same distribution', () => {
        for (const [template, shell] of [
            ['Ubuntu 22.04', 'ID=ubuntu'],
            ['Debian 12', 'ID=debian'],
            ['Rocky Linux 9', 'ID=rocky'],
            ['Alpine Linux 3.19', 'ID=alpine'],
        ]) {
            assert.deepStrictEqual(
                classifyTemplateName(template),
                classifyShellOutput(shell),
                `${template} and ${shell} disagree`,
            );
        }
    });
});
