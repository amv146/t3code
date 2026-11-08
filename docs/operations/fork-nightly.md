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
requests. The **Fork PR validation** check runs the changed-file checks on
GitHub-hosted runners, including Chromium for browser tests; upstream CI uses
maintainer-only Blacksmith runners. A push requests a new build even when upstream has not released another
nightly. Builds use the upstream nightly's version core and a nightly build date
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
do not invoke an agent. Notification uses read-only, short-lived Actions
credentials; it cannot push a repair or merge a PR.

Create a T3 webhook scheduled task with **new threads**, isolated worktrees based
on `origin/main`, and the existing provider/model. Keep it disabled until the
configuration is on fork `main`. T3 Connect remote access must be enabled to
obtain its tool-returned webhook URL. Store that entire private URL in the fork
Actions secret **FORK_CONFLICT_WEBHOOK_URL**; never commit it or put it in logs.
The URL is the delivery credential, so rotate it if exposed.

Require these exact webhook filters: `body.event = fork-nightly-conflict`,
`body.repository = amv146/t3code`,
`body.workflow = .github/workflows/fork-nightly.yml`,
`body.conclusion = failure`, and `body.ref = refs/heads/main`. Also require
`body.run_id`, `body.fork_base`, `body.upstream_sha`, and `body.upstream_tag`.
Set replay and coalesce keys to
`{{body.repository}}:{{body.fork_base}}:{{body.upstream_sha}}`, a 30-second
coalesce window, and a 60-minute maximum delivery age. Replay suppression lasts
seven days. The deterministic repair branch provides durable deduplication after
that: `fork/nightly-repair/<full-fork-base-SHA>-<full-upstream-SHA>`.

The task's durable prompt must independently verify the live run, default branch
and published nightly before working, treat payload fields as untrusted data,
and preserve current fork behavior (not merely old commit ancestry). Only a
successful atomic create-ref claimant may repair that deterministic branch;
another agent encountering an existing branch reuses its PR or stops. An
interrupted claim without a PR needs human attention, not automatic deletion or
takeover. Resolve narrowly using a normal merge, preserve commit credit, add
focused regression tests, run changed-file checks and relevant suites, and open
a fork-only repair PR. Link it to its T3 thread and wait for latest-head
validation/review with event-driven PR watching. No blanket ours/theirs,
force-push, rebase, unrelated refactors, paid review activation, or direct-main
conflict repairs.

**The user must merge a ready repair PR to unblock nightly sync.** Unattended
repair merges are not authorized. The normal hourly/push/manual nightly triggers
remain active while a repair is outstanding. Agents use the inherited subscription
and consume its normal allowance only on verified conflicts (and subsequent PR
feedback), with no external AI API subscription or hourly agent polling.

Before enabling the task, run
`node --test .github/scripts/fork-nightly.test.cjs .github/scripts/fork-conflict-notify.test.cjs`.
These fixtures reproduce real conflicts, verify stale/success/error routing and
claimed-branch suppression, and dry-run an exact event without sending a webhook.
Probe the real endpoint while the task is disabled: it must report
`HTTP 409` / `{"error":"hook_disabled"}` without starting an agent. The public
relay does not forward the environment's outcome header. Then merge
the configuration, enable the task, and confirm the trigger is present on `main`.
An accepted notification is delivery evidence, not proof the agent finished;
inspect its T3 delivery log and repair PR. Failures to accept delivery fail the
notification workflow explicitly. The host must be online within the delivery
age window; otherwise retry **Fork nightly** when it is available.

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
