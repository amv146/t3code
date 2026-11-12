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

**What's changed** lists upstream and fork commits since the previous published
fork nightly, without merge commits or installer instructions. Like upstream,
the popup shows a compact summary and change/contributor counts; GitHub keeps the
full commit list folded below it. The first fork release lists changes against
its upstream nightly. Notes are generated from Git history without a paid model.

Add fixes and features to this fork's `main` through normal commits or pull
requests. The **Fork PR validation** check runs the changed-file checks on
GitHub-hosted runners, including Chromium for browser tests; upstream CI uses
maintainer-only Blacksmith runners. Fork PR checks allow 35 minutes per check step
within a 45-minute job, since large nightly merges can select hundreds of serial
server test files. This does not change individual test timeouts or skip tests.
A push requests a new build even when upstream has not released another nightly.
Builds use the upstream nightly's version core and a nightly build date
and workflow run ID, so each build has a distinct updater-compatible version.
Rerunning a failed workflow is safe: only a published release with the exact
source commit and an update manifest suppresses another build.

Merge conflicts and failed checks or builds stop publication. GitHub Actions
shows the failure, and the last working release remains available until a
replacement passes. Publication also stops if `main` changes while the installer
is building. Do not discard personal commits to make sync pass.

## Agent conflict repair

The [conflict notification workflow](../../.github/workflows/fork-conflict-repair.yml)
only runs after a failed **Fork nightly** run. It checks the live failed merge
step and its conflict metadata, reconfirms fork `main` and the latest published
upstream nightly tag/SHA, and reproduces the merge in its disposable checkout.
Successful syncs, build failures, permission errors, stale runs, and clean merges
do not invoke an agent. Verified conflicts create an issue assigned to GitHub
Copilot, which works on GitHub while the developer's PC is asleep. The former
T3 webhook is not used.

Store a fine-grained personal access token owned by `amv146`, restricted to this
fork, as **FORK_COPILOT_AGENT_TOKEN**. GitHub's Copilot issue-assignment API requires
Metadata read and Actions, Contents, Issues, and Pull requests read/write.
The checkout uses the ordinary read-only workflow token; only the trusted
dispatch step receives the user token. Never expose it to agent setup or prompts.
Copilot receives its own branch-scoped credentials.

Before setting the Actions variable **FORK_COPILOT_REPAIR_ENABLED** to `true`,
confirm that the account's Copilot license permits cloud-agent issue assignment
and configure GitHub billing to block additional AI-credit charges after the
included allowance. Copilot uses the assigning account's allowance and policies;
the workflow does not change budgets or guarantee free model usage. Standard
GitHub-hosted runners for this public repository are free. The
[Copilot setup workflow](../../.github/workflows/copilot-setup-steps.yml) installs
the repository's pinned tools and cached Chromium on Ubuntu 24.04.

Serialized dispatches use the exact fork/upstream SHA pair as the issue title.
An existing issue, open or closed, suppresses another assignment. An ambiguous
API failure or an issue created without Copilot assigned requires human
inspection, not automatic retries that could spend credits twice. Existing
legacy repair branches also suppress dispatch. An open legacy repair PR or
hosted repair issue for the same upstream revision is reused even when fork
`main` has advanced, so a configuration-only commit cannot start a second repair.
Do not delete these durable records merely to force another run.

The agent must reconfirm the inputs, resolve narrowly, preserve fork behavior,
and retain both input commits in a normal two-parent merge. It must run
changed-file checks and relevant regression tests and open a repair PR.
If the hosted agent cannot preserve merge ancestry, it must report the blocker
instead of substituting a patch-only repair.

**A human must approve workflow runs when GitHub requires it, review the PR, and
merge with a merge commit, not squash/rebase.** The agent does not merge or push
`main`; the normal nightly workflow publishes after the repair lands.
To pause agent dispatch without stopping nightly sync, set
**FORK_COPILOT_REPAIR_ENABLED** to `false`. Pause the old T3 webhook task when
switching to hosted repair to avoid two independent repair systems.

Run
`node --test .github/scripts/fork-nightly.test.cjs .github/scripts/fork-conflict-notify.test.cjs`
before deployment. The fixtures reproduce real conflicts and cover stale
evidence, claimed repairs, disabled dispatch, wrong billing identity, durable
issue deduplication, and ambiguous/rejected assignment. A successful assignment
is not proof that the agent finished, checks passed, or an installer shipped.

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
