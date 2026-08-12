# Publishing Reef Terminal on winget

Once this is set up, Windows users install and update Reef Terminal without
opening a browser:

```powershell
winget install ReefTerminal.ReefTerminal
winget upgrade ReefTerminal.ReefTerminal
```

winget has no upload. Its package list is
[microsoft/winget-pkgs](https://github.com/microsoft/winget-pkgs), a repository
of YAML files that say where an installer lives and what its SHA256 is, and a
version is published by opening a pull request against it. So publishing
Reef Terminal means keeping three small files up to date in someone else's
repository, once per release, forever.

That is what the `winget` job in
[release.yml](../.github/workflows/release.yml) is for. It cannot do the
first one, because it works by copying the previous version's manifest
forward and the first version has no previous. So the first release is
submitted by hand, once, and every release after it is automatic.

## Once, before any of this works

**Fork winget-pkgs.** Go to
[microsoft/winget-pkgs](https://github.com/microsoft/winget-pkgs) and fork it
to the account or org that will own this package's submissions -- typically
`reefterm`, matching the org this repository lives in. The release job
pushes its branch there. Leave the fork alone otherwise; the tooling syncs it.

**Make a token.** GitHub, Settings, Developer settings, Personal access tokens,
**Tokens (classic)**, Generate new token. Tick `public_repo` and nothing else.
Fine-grained tokens do not work here, which is a limitation of the tooling and
not a preference. Give it a long expiry, because the day it expires is a day a
release quietly stops reaching winget.

**Store it.** In this repository: Settings, Secrets and variables, Actions, New
repository secret, named `WINGET_TOKEN`.

Without the secret the release still builds and publishes as it always did.
The `winget` job prints a line saying it skipped, and stops.

## The first submission, by hand

Write the manifests for a release that already exists:

```bash
node scripts/winget-manifest.js v0.1.0
```

The tag is optional and defaults to `v` plus the version in package.json. The
script reads the release from GitHub, so the release has to be published
already, and takes the installer URL, its SHA256 and the release date from it
rather than from anything typed in here. It writes three files under
`dist/winget/`:

```
manifests/r/ReefTerminal/ReefTerminal/0.1.0/
    ReefTerminal.ReefTerminal.yaml               which locale describes it
    ReefTerminal.ReefTerminal.locale.en-US.yaml  name, publisher, license, description
    ReefTerminal.ReefTerminal.installer.yaml     the URL, the hash, how to install it
```

That is the path they belong at inside winget-pkgs, which is the whole point of
writing them there. Check them, then send them.
[winget-create](https://github.com/microsoft/winget-create) does the fork, the
branch and the pull request in one command, and takes the same token:

```powershell
winget install Microsoft.WingetCreate

$manifests = 'dist\winget\manifests\r\ReefTerminal\ReefTerminal\0.1.0'
winget validate --manifest $manifests
wingetcreate submit --token $env:WINGET_TOKEN $manifests
```

Or by hand, if you would rather see the commit before it goes:

```bash
git clone https://github.com/reefterm/winget-pkgs
cd winget-pkgs
git checkout -b ReefTerminal.ReefTerminal-0.1.0
cp -r /path/to/reefterm/dist/winget/manifests .
git add manifests/r/ReefTerminal
git commit -m "New package: ReefTerminal.ReefTerminal version 0.1.0"
git push -u origin ReefTerminal.ReefTerminal-0.1.0
gh pr create --repo microsoft/winget-pkgs \
  --title "New package: ReefTerminal.ReefTerminal version 0.1.0" \
  --body "Adds Reef Terminal, an SSH, SFTP, Telnet, RDP and VNC client. https://github.com/reefterm/reefterm"
```

Either way, their pipeline takes over. It downloads the installer, runs a
scanner over it, installs it in a clean VM and checks the app appears in Add or
remove programs where the manifest says it will. A new package also gets a human
moderator, so the first pull request takes longer than the ones after it, and
may come back with questions on the pull request itself.

Two things that come up:

- The installer is not code signed. That is allowed, and plenty of packages in
  winget are the same, but SmartScreen and occasionally the pipeline's own
  scanner have opinions about unsigned installers and the review can stall on
  it. Reply on the pull request if it does.
- The publisher name has to be one you can claim. `Reef Terminal Contributors`
  is a project-level name rather than a single legal entity, which winget's
  moderators do accept for community projects, but expect a question about it
  on the first submission if it comes up. The identifier is also permanent in
  practice: it is the directory name, the thing people type, and what every
  already-installed copy is matched against, so changing it later means a new
  package and a request to remove the old one.

## Every release after that

Nothing. Tag a release the way you always do, and after the release job
finishes, the `winget` job opens the next pull request on its own. It fails
loudly if something is wrong and leaves the GitHub release alone either way.

If it is ever easier to do a version by hand, the script above still works for
any tag, and the pull request is `Update version: ReefTerminal.ReefTerminal
version 0.2.0` rather than `New package`.

## Why the manifests say what they say

**Only the installer is published.** The release carries two `.exe` files, the
NSIS installer and the portable build. winget installs things, and there is
nothing for it to install a portable exe into, so the job's `installers-regex`
picks out `ReefTerminal-Setup-x64.exe` and ignores the rest. A separate
`ReefTerminal.ReefTerminal.Portable` package could be added later if anyone asks.

**`Scope: user`.** `perMachine` is false in the electron-builder config, so
Reef Terminal installs under the user's own AppData and never asks to elevate.
Saying so keeps `winget install` from waiting on a prompt that is not coming.

**`AppsAndFeaturesEntries.ProductCode`.** This is the one that is easy to get
wrong and hard to notice. electron-builder registers Reef Terminal in Add or
remove programs under a GUID rather than a name, and the display name it
writes is `Reef Terminal 0.1.0`, version included. Match that by name and every
release looks like a different program, so `winget upgrade` never offers an
upgrade and `winget install` on a machine that already has it installs it
again.

The GUID is a UUID v5 of `appId` from package.json in a namespace of
electron-builder's, which makes it stable across versions and derivable rather
than something to read off an installed machine.
`scripts/winget-manifest.js` derives it. It also makes `appId` load bearing:
every copy already installed keeps the GUID it was installed with, so moving
`appId` would orphan all of them.

**`UpgradeBehavior: install`.** The NSIS installer removes the old version
itself as part of installing over it. Asking winget to uninstall first would
only add a step that can fail.

**`License` and `Copyright`.** Reef Terminal is a fork of
[CloudTerm](https://github.com/BradPerbs/cloudterm) and is distributed under
CloudTerm's own license, which requires keeping its copyright notice with every
copy. Those two fields describe the actual terms the software ships under, not
a license of Reef Terminal's own, and should not be "corrected" to say
otherwise.
