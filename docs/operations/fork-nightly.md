# Personal Windows nightlies

This fork's [Fork nightly workflow](../../.github/workflows/fork-nightly.yml) checks
for published `pingdotgg/t3code` nightlies hourly and on pushes to `main`. It merges
the latest nightly tag into this fork's `main`, preserving personal commits, then
checks the changes against that upstream commit. It builds a Windows x64 installer
and a matching Linux runtime for WSL. It does not deploy infrastructure, publish
npm packages, or build other desktop installers.

Install the first `.exe` from this fork's GitHub Releases manually to switch the
desktop update feed. Keep **Nightly** selected in the app. Future fork releases
appear in the normal update UI; official nightly installers still use the
upstream feed and would replace your changes.

Add fixes and features to this fork's `main` through normal commits or pull
requests. A push requests a new build even when upstream has not released another
nightly. Builds use the upstream nightly's version core and a nightly build date
and workflow run ID, so each build has a distinct updater-compatible version.
Rerunning a failed workflow is safe: only a published release with the exact
source commit and an update manifest suppresses another build.

Merge conflicts and failed checks or builds stop publication. Resolve conflicts
locally, commit the result, and push; do not discard the personal commits to make
the sync pass. GitHub Actions shows the failure. The last working release remains
available until a replacement passes. Publication also stops if `main` changes
while the installer is building.

The workflow reuses upstream Windows packaging and verification, on standard
GitHub-hosted runners, and embeds this fork's GitHub repository as the update feed.
Public T3 Connect settings come from `.env.example`; no upstream deployment
credentials are needed. Windows signing is optional and uses this fork's own
Azure Trusted Signing secrets listed in [the release guide](./release.md).
Without them, Windows may warn about an unsigned installer.

Set the repository Actions secret **FORK_SYNC_TOKEN** to a fine-grained GitHub
personal access token restricted to `amv146/t3code`, with **Contents** and
**Workflows** read/write permissions. The built-in workflow token cannot push
upstream changes to workflow files. Only the sync checkout receives this token;
build and publish jobs use their normal, short-lived workflow tokens. Renew the
secret before its token expires. An absent or expired token stops sync.

Run **Fork nightly** manually in GitHub Actions to retry immediately. To pause
automatic releases, disable that workflow. Keep GitHub Actions enabled; GitHub
may disable scheduled workflows after prolonged repository inactivity.
