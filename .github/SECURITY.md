# Security Policy

## Scope

This project has two security-critical surfaces:

- **The local vault and backup crypto** (`src/main/vault.js`, `src/main/backup.js`, `src/main/sync-keys.js`): the credential store, its opening password, portable backups, and the Sync Master Key lifecycle for end-to-end encrypted sync.
- **The self-hosted sync server's design** ([reefterm/sync-server](https://github.com/reefterm/sync-server)): the zero-knowledge protocol between the desktop client and a self-hosted server, including how the server authenticates a session, and what it stores versus what it can read.

A vulnerability in either -- or in how the two interact, such as anything that would let a server operator recover a passphrase, a Sync Master Key, or plaintext synced data -- is in scope.

## Reporting a vulnerability

Please **do not open a public issue** for a security report. Instead, use [GitHub Security Advisories](https://github.com/reefterm/reefterm/security/advisories/new) to report privately. If you'd rather not use GitHub for the initial report, open a regular issue asking for a private contact channel and no other detail; a maintainer will follow up.

Please include:

- What you found and where (file, endpoint, or flow)
- Steps to reproduce, or a proof of concept if you have one
- What you believe the impact is

We'll acknowledge reports as promptly as we can and keep you updated as the issue is investigated and fixed. Please give us a reasonable window to address a report before any public disclosure.

## No formal audit yet

This project does its own encryption and key management rather than delegating to a well-audited third-party library for the sealing/unsealing primitives (scrypt + AES-256-GCM) and the zero-knowledge sync protocol. That design has not yet had a formal third-party security audit. It's built carefully, with the reasoning documented in code comments and tested against the specific failure modes we could think of (wrong-passphrase-vs-tampered-data being indistinguishable, envelopes for different secrets not cross-opening, and so on) -- but "we tried to get this right" is not the same guarantee an audit provides.

If you're evaluating this project for a use case where that matters -- storing genuinely sensitive infrastructure credentials, or running a sync server other people you don't know well will trust -- please factor that in. An audit is something we'd like to pursue as the project matures; contributions or sponsorship toward one would be welcome.

## Supported versions

This project is pre-1.0 and does not yet maintain multiple supported release branches. Security fixes land on `main` and are included in the next release.
