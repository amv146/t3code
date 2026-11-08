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

async function notifyForkConflict({
  github,
  context,
  core,
  webhookUrl,
  git,
  fetchImpl = fetch,
  dryRun = false,
}) {
  const result = await probeForkConflict({ github, context, git });
  if (!result.payload) {
    core.info(result.reason);
    await core.summary.addRaw(result.reason).write();
    return result;
  }
  if (dryRun) return result;
  let endpoint;
  try {
    endpoint = new URL(webhookUrl);
  } catch {
    throw new Error("Set FORK_CONFLICT_WEBHOOK_URL to the private T3 webhook endpoint.");
  }
  if (
    endpoint.origin !== "https://relay.t3.codes" ||
    !endpoint.pathname.startsWith("/v1/hooks/") ||
    endpoint.username ||
    endpoint.password ||
    endpoint.search ||
    endpoint.hash
  ) {
    throw new Error("Conflict delivery requires a T3 Connect webhook endpoint.");
  }
  let response;
  try {
    response = await fetchImpl(endpoint, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(result.payload),
      redirect: "error",
      signal: AbortSignal.timeout(20_000),
    });
  } catch {
    // Fetch errors can include the credential-bearing URL.
    throw new Error("T3 conflict webhook delivery failed. Inspect the task's delivery log.");
  }
  const outcome = response.headers.get("x-t3-hook-outcome");
  if (
    response.status !== 202 ||
    (outcome !== null && !["accepted", "duplicate", "coalesced"].includes(outcome))
  ) {
    throw new Error(`T3 did not accept the conflict delivery (HTTP ${response.status}).`);
  }
  const receipt = await response.json();
  const held = receipt.queued === true;
  if (!held && (typeof receipt.deliveryId !== "string" || !receipt.deliveryId)) {
    throw new Error("T3 returned no conflict delivery receipt.");
  }
  // The public relay strips the outcome header; its receipt does not prove agent dispatch.
  const message = `${held ? "T3 relay queued" : "T3 received"} the conflict notification. Confirm dispatch in its delivery log. A ready repair PR needs user merge approval to unblock nightly sync.`;
  core.info(message);
  await core.summary.addRaw(message).write();
  return result;
}

module.exports = { conflictMetadata, notifyForkConflict, probeForkConflict, repairBranch };
