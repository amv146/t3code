const { execFileSync } = require("node:child_process");
const { existsSync } = require("node:fs");
const { selectLatestNightly } = require("./fork-nightly.cjs");

const repository = "amv146/t3code";
const repo = { owner: "amv146", repo: "t3code" };
const workflow = ".github/workflows/fork-nightly.yml";
const mergeStep = "Merge the latest published upstream nightly";
const shaPattern = /^[a-f0-9]{40}$/;

function conflictMetadata(log) {
  if (typeof log !== "string" || Buffer.byteLength(log) > 1024 * 1024) {
    throw new Error("Missing or oversized sync log.");
  }
  const markers = [...log.matchAll(/FORK_NIGHTLY_CONFLICT=(\{[^\r\n]+\})/g)];
  if (markers.length === 0) return null;
  if (markers.length !== 1) throw new Error("Ambiguous sync conflict metadata.");
  const data = JSON.parse(markers[0][1]);
  if (
    Object.keys(data).sort().join(",") !== "fork_base,upstream_sha,upstream_tag" ||
    !shaPattern.test(data.fork_base) ||
    !shaPattern.test(data.upstream_sha) ||
    typeof data.upstream_tag !== "string"
  ) {
    throw new Error("Invalid sync conflict metadata.");
  }
  return data;
}

function repairBranch(forkBase, upstreamSha) {
  if (!shaPattern.test(forkBase) || !shaPattern.test(upstreamSha)) {
    throw new Error("Invalid repair inputs.");
  }
  return `fork/nightly-repair/${forkBase}-${upstreamSha}`;
}

const runGit = (args) =>
  execFileSync("git", args, {
    encoding: "utf8",
    stdio: ["ignore", "pipe", "pipe"],
  }).trim();

async function probeForkConflict({ github, context, git = runGit }) {
  const event = context.payload;
  if (
    `${context.repo.owner}/${context.repo.repo}` !== repository ||
    context.eventName !== "workflow_run" ||
    event.action !== "completed" ||
    event.repository?.full_name !== repository ||
    !Number.isSafeInteger(event.workflow_run?.id) ||
    event.workflow_run.id <= 0
  ) {
    throw new Error("Expected a completed fork nightly workflow event.");
  }
  const { data: run } = await github.rest.actions.getWorkflowRun({
    ...repo,
    run_id: event.workflow_run.id,
  });
  if (
    run.repository.full_name !== repository ||
    run.head_repository.full_name !== repository ||
    run.path !== workflow ||
    run.head_branch !== "main" ||
    !["push", "schedule", "workflow_dispatch"].includes(run.event) ||
    run.status !== "completed" ||
    run.conclusion !== "failure" ||
    run.run_attempt !== event.workflow_run.run_attempt
  ) {
    return { reason: "Not a current, failed fork nightly attempt." };
  }
  const { data: jobs } = await github.rest.actions.listJobsForWorkflowRun({
    ...repo,
    run_id: run.id,
    filter: "latest",
    per_page: 100,
  });
  if (jobs.total_count > jobs.jobs.length) throw new Error("Incomplete nightly job evidence.");
  const sync = jobs.jobs.filter(
    (job) =>
      job.name === "sync" &&
      job.conclusion === "failure" &&
      job.steps.some((step) => step.name === mergeStep && step.conclusion === "failure"),
  );
  if (sync.length !== 1) return { reason: "No failed nightly merge step." };
  const { data: log } = await github.rest.actions.downloadJobLogsForWorkflowRun({
    ...repo,
    job_id: sync[0].id,
  });
  const metadata = conflictMetadata(log);
  if (metadata === null) return { reason: "Merge step failed without verified conflict metadata." };
  const { data: main } = await github.rest.repos.getBranch({ ...repo, branch: "main" });
  if (main.commit.sha !== metadata.fork_base || run.head_sha !== metadata.fork_base) {
    return { reason: "Fork main moved since this conflict." };
  }
  const { data: releases } = await github.rest.repos.listReleases({
    owner: "pingdotgg",
    repo: "t3code",
    per_page: 100,
  });
  const upstream = selectLatestNightly(releases);
  if (upstream.tag_name !== metadata.upstream_tag) {
    return { reason: "A newer published upstream nightly supersedes this conflict." };
  }
  if (git(["rev-parse", "HEAD"]) !== metadata.fork_base || git(["status", "--porcelain"])) {
    throw new Error("Conflict probe requires a clean checkout of the verified fork base.");
  }
  git([
    "fetch",
    "--no-tags",
    "https://github.com/pingdotgg/t3code.git",
    `refs/tags/${upstream.tag_name}`,
  ]);
  if (git(["rev-parse", "FETCH_HEAD^{commit}"]) !== metadata.upstream_sha) {
    return { reason: "Published nightly tag no longer matches the failed merge." };
  }
  const branch = repairBranch(metadata.fork_base, metadata.upstream_sha);
  try {
    await github.rest.git.getRef({ ...repo, ref: `heads/${branch}` });
    return {
      reason: `Repair branch ${branch} is already claimed. Merge its repair PR when ready to unblock nightly sync; an interrupted claim needs human attention.`,
    };
  } catch (error) {
    if (error.status !== 404) throw error;
  }
  git(["config", "user.name", "github-actions[bot]"]);
  git(["config", "user.email", "41898282+github-actions[bot]@users.noreply.github.com"]);
  let conflicted = false;
  try {
    git(["merge", "--no-commit", "--no-ff", metadata.upstream_sha]);
  } catch (error) {
    if (!git(["ls-files", "--unmerged"])) throw error;
    conflicted = true;
  } finally {
    if (existsSync(git(["rev-parse", "--path-format=absolute", "--git-path", "MERGE_HEAD"]))) {
      git(["merge", "--abort"]);
    }
  }
  if (!conflicted) return { reason: "The verified nightly now merges without conflicts." };
  const { data: currentMain } = await github.rest.repos.getBranch({ ...repo, branch: "main" });
  if (currentMain.commit.sha !== metadata.fork_base) {
    return { reason: "Fork main changed during the conflict probe." };
  }
  return {
    payload: {
      event: "fork-nightly-conflict",
      repository,
      workflow,
      conclusion: "failure",
      ref: "refs/heads/main",
      run_id: String(run.id),
      ...metadata,
    },
  };
}

async function notifyForkConflict({ github, context, core, git, enabled = false, dryRun = false }) {
  const result = await probeForkConflict({ github, context, git });
  if (!result.payload) {
    core.info(result.reason);
    await core.summary.addRaw(result.reason).write();
    return result;
  }
  if (dryRun) return result;
  if (!enabled) {
    const reason =
      "Hosted repair is disabled. Configure the credential and spending limit before enabling FORK_COPILOT_REPAIR_ENABLED.";
    core.info(reason);
    await core.summary.addRaw(reason).write();
    return { ...result, reason };
  }
  const { data: user } = await github.rest.users.getAuthenticated();
  if (user.login !== repo.owner) {
    throw new Error(
      "Hosted repair must authenticate as amv146 to use the intended Copilot account.",
    );
  }
  const key = `${result.payload.fork_base}-${result.payload.upstream_sha}`;
  const title = `Nightly repair: ${key}`;
  const issues = await github.paginate(github.rest.issues.listForRepo, {
    ...repo,
    state: "all",
    creator: repo.owner,
    per_page: 100,
  });
  const existing = issues.filter(
    (issue) =>
      !issue.pull_request &&
      (issue.title === title || issue.body?.split("\n").includes(`Repair key: ${key}`)),
  );
  if (existing.length > 0) {
    const reason = `Repair issue already exists: ${existing[0].html_url}. Inspect its assignment and PR; no second agent will be started, even if the issue was closed or the first dispatch was interrupted.`;
    core.info(reason);
    await core.summary.addRaw(reason).write();
    return { ...result, reason, issueUrl: existing[0].html_url };
  }
  const actors = await github.graphql(
    `query($owner: String!, $name: String!) {
      repository(owner: $owner, name: $name) {
        suggestedActors(capabilities: [CAN_BE_ASSIGNED], first: 100) {
          nodes { login __typename ... on Bot { id } }
        }
      }
    }`,
    { owner: repo.owner, name: repo.repo },
  );
  const copilot = actors.repository?.suggestedActors.nodes.find(
    (actor) => actor.__typename === "Bot" && actor.login === "copilot-swe-agent",
  );
  if (!copilot) {
    throw new Error("Copilot cloud agent is not available for this account and repository.");
  }
  const {
    fork_base: forkBase,
    upstream_sha: upstreamSha,
    upstream_tag: upstreamTag,
    run_id: runId,
  } = result.payload;
  const body = [
    `Resolve the verified upstream nightly merge conflict in ${repository}.`,
    "",
    `Failed run: https://github.com/${repository}/actions/runs/${runId}`,
    `Fork base: ${forkBase}`,
    `Upstream nightly: ${upstreamTag}`,
    `Upstream commit: ${upstreamSha}`,
    "",
    "Work only in this fork. Reconfirm live main, the failed run, and the latest published pingdotgg/t3code nightly before changing anything. Stop and report if these inputs are stale or the conflict no longer reproduces.",
    `Fetch refs/tags/${upstreamTag} from https://github.com/pingdotgg/t3code.git and verify it resolves to ${upstreamSha}. Fetch complete fork history if the checkout is shallow.`,
    `Create a normal two-parent merge of ${upstreamSha} into ${forkBase} on your repair branch. Preserve both parents and all contributor history. Do not squash, rebase, force-push, copy an upstream snapshot, or choose blanket ours/theirs.`,
    "Resolve narrowly and preserve the fork's current ADO checks, location cache, paged file diffs, composer completion, glass opacity, release notes, and CI/repair automation. Do not discard fork behavior just to make the merge pass.",
    "Add focused regression coverage for changed behavior and run vp run check:changed against the verified fork base plus relevant focused tests. Do not bypass quality gates, change billing, trigger paid review services, or start other agents.",
    "Open one repair PR targeting main. Include the failed run, both source SHAs, resolved files, and exact validation results. Verify both input commits are ancestors of the PR head. If your environment cannot preserve a two-parent merge, stop and report instead of presenting a patch-only PR as a completed repair.",
    "A human must review and merge the PR using a merge commit, not squash/rebase. Do not approve or merge it yourself, push main, or change branch policies. Publication remains the normal nightly workflow's job.",
    "",
    `Repair key: ${forkBase}-${upstreamSha}`,
  ].join("\n");
  // The workflow serializes dispatches; the issue survives an ambiguous API response without a second assignment.
  const { data: issue } = await github.rest.issues.create({
    ...repo,
    title,
    body,
    assignees: ["copilot-swe-agent[bot]"],
    agent_assignment: { target_repo: repository, base_branch: "main" },
  });
  if (
    !issue.assignees?.some(
      (actor) =>
        actor.node_id === copilot.id ||
        ["copilot-swe-agent", "copilot-swe-agent[bot]"].includes(actor.login),
    )
  ) {
    throw new Error(
      `GitHub did not assign Copilot to ${issue.html_url}. Inspect the issue; dispatch will not be retried automatically.`,
    );
  }
  const message = `Copilot repair assigned: ${issue.html_url}. A human must approve workflow runs if required and merge the repair PR when ready. Assignment is not proof that repair or publication completed.`;
  core.info(message);
  await core.summary.addRaw(message).write();
  return { ...result, issueUrl: issue.html_url };
}

module.exports = { conflictMetadata, notifyForkConflict, probeForkConflict, repairBranch };
