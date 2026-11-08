const assert = require("node:assert/strict");
const { execFileSync } = require("node:child_process");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const test = require("node:test");
const {
  conflictMetadata,
  notifyForkConflict,
  probeForkConflict,
  repairBranch,
} = require("./fork-conflict-notify.cjs");

const tag = "v0.1.8-nightly.20261108.4353";
const core = {
  info() {},
  summary: {
    addRaw() {
      return this;
    },
    async write() {},
  },
};

function fixture(t, conflict = true) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "t3-conflict-notify-"));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const upstream = path.join(root, "upstream");
  const fork = path.join(root, "fork");
  const gitAt = (cwd, args) =>
    execFileSync("git", args, {
      cwd,
      encoding: "utf8",
      stdio: ["ignore", "pipe", "pipe"],
    }).trim();
  fs.mkdirSync(upstream);
  gitAt(upstream, ["init", "--initial-branch=main"]);
  gitAt(upstream, ["config", "user.name", "Fixture"]);
  gitAt(upstream, ["config", "user.email", "fixture@example.invalid"]);
  gitAt(upstream, ["config", "core.autocrlf", "false"]);
  fs.writeFileSync(path.join(upstream, "feature.txt"), "base\n");
  gitAt(upstream, ["add", "."]);
  gitAt(upstream, ["commit", "-m", "Base"]);
  gitAt(root, ["clone", "--config", "core.autocrlf=false", upstream, fork]);
  const git = (args) => gitAt(fork, args);
  git(["config", "user.name", "Fixture"]);
  git(["config", "user.email", "fixture@example.invalid"]);
  git([
    "config",
    `url.${upstream.replaceAll("\\", "/")}.insteadOf`,
    "https://github.com/pingdotgg/t3code.git",
  ]);
  fs.writeFileSync(path.join(fork, "feature.txt"), "personal behavior\n");
  git(["add", "."]);
  git(["commit", "-m", "Personal feature"]);
  fs.writeFileSync(path.join(upstream, conflict ? "feature.txt" : "new.txt"), "upstream update\n");
  gitAt(upstream, ["add", "."]);
  gitAt(upstream, ["commit", "-m", "Nightly"]);
  gitAt(upstream, ["tag", tag]);
  const metadata = {
    fork_base: git(["rev-parse", "HEAD"]),
    upstream_sha: gitAt(upstream, ["rev-parse", "HEAD"]),
    upstream_tag: tag,
  };
  const run = {
    id: 123,
    run_attempt: 1,
    repository: { full_name: "amv146/t3code" },
    head_repository: { full_name: "amv146/t3code" },
    path: ".github/workflows/fork-nightly.yml",
    head_branch: "main",
    head_sha: metadata.fork_base,
    event: "schedule",
    status: "completed",
    conclusion: "failure",
  };
  const sync = {
    id: 456,
    name: "sync",
    conclusion: "failure",
    steps: [{ name: "Merge the latest published upstream nightly", conclusion: "failure" }],
  };
  const state = {
    run,
    sync,
    log: `2026-11-08T05:00:00Z FORK_NIGHTLY_CONFLICT=${JSON.stringify(metadata)}\n`,
    main: metadata.fork_base,
    release: {
      tag_name: tag,
      prerelease: true,
      draft: false,
      published_at: "2026-11-08T05:00:00Z",
    },
    claimed: false,
  };
  const github = {
    rest: {
      actions: {
        async getWorkflowRun() {
          return { data: state.run };
        },
        async listJobsForWorkflowRun() {
          return { data: { total_count: 1, jobs: [state.sync] } };
        },
        async downloadJobLogsForWorkflowRun() {
          return { data: state.log };
        },
      },
      repos: {
        async getBranch() {
          return { data: { commit: { sha: state.main } } };
        },
        async listReleases() {
          return { data: [state.release] };
        },
      },
      git: {
        async getRef() {
          if (state.claimed) return { data: {} };
          throw Object.assign(new Error("Not found"), { status: 404 });
        },
      },
    },
  };
  const context = {
    repo: { owner: "amv146", repo: "t3code" },
    eventName: "workflow_run",
    payload: {
      action: "completed",
      repository: { full_name: "amv146/t3code" },
      workflow_run: { id: 123, run_attempt: 1 },
    },
  };
  return { github, context, git, state, metadata, fork };
}

test("conflict markers and persistent repair keys reject ambiguity and executable input", () => {
  const metadata = { fork_base: "a".repeat(40), upstream_sha: "b".repeat(40), upstream_tag: tag };
  const marker = `FORK_NIGHTLY_CONFLICT=${JSON.stringify(metadata)}\n`;
  assert.deepEqual(conflictMetadata(marker), metadata);
  assert.equal(conflictMetadata("push permission denied"), null);
  assert.throws(() => conflictMetadata(marker + marker), /Ambiguous/);
  assert.throws(() => conflictMetadata("x".repeat(1024 * 1024 + 1)), /oversized/);
  assert.throws(
    () =>
      conflictMetadata(`FORK_NIGHTLY_CONFLICT=${JSON.stringify({ ...metadata, command: "bad" })}`),
    /Invalid/,
  );
  assert.equal(
    repairBranch(metadata.fork_base, metadata.upstream_sha),
    `fork/nightly-repair/${metadata.fork_base}-${metadata.upstream_sha}`,
  );
  assert.throws(() => repairBranch("main; bad", metadata.upstream_sha), /Invalid/);
});

test("only the exact failed nightly conflict routes a bounded event, and dry-run never delivers", async (t) => {
  const f = fixture(t);
  const result = await notifyForkConflict({
    ...f,
    core,
    dryRun: true,
    async fetchImpl() {
      assert.fail("dry-run must not invoke T3");
    },
  });
  assert.deepEqual(result.payload, {
    event: "fork-nightly-conflict",
    repository: "amv146/t3code",
    workflow: ".github/workflows/fork-nightly.yml",
    conclusion: "failure",
    ref: "refs/heads/main",
    run_id: "123",
    ...f.metadata,
  });
  assert.equal(f.git(["status", "--porcelain"]), "");
  assert.equal(f.git(["rev-parse", "HEAD"]), f.metadata.fork_base);
  assert.equal(fs.readFileSync(path.join(f.fork, "feature.txt"), "utf8"), "personal behavior\n");
  for (const [target, name, value] of [
    [f.state.run, "conclusion", "success"],
    [f.state.run, "path", ".github/workflows/ci.yml"],
    [f.state.run, "event", "pull_request"],
    [f.state.run, "head_branch", "feature"],
    [f.state.run, "run_attempt", 2],
    [f.state.sync.steps[0], "conclusion", "success"],
    [f.state, "log", "merge failed: permission denied"],
    [f.state, "main", "c".repeat(40)],
    [f.state.release, "tag_name", "v0.1.8-nightly.20261109.4354"],
    [f.state, "claimed", true],
  ]) {
    const old = target[name];
    target[name] = value;
    const skipped = await notifyForkConflict({
      ...f,
      core,
      async fetchImpl() {
        assert.fail(`must not invoke T3 for ${name}=${value}`);
      },
    });
    assert.ok(skipped.reason);
    target[name] = old;
  }
  const original = f.context.repo.owner;
  f.context.repo.owner = "pingdotgg";
  await assert.rejects(probeForkConflict(f), /Expected a completed fork/);
  f.context.repo.owner = original;
});

test("a clean merge or changed tag SHA does not deliver and the probe restores the fixture", async (t) => {
  const f = fixture(t, false);
  assert.match((await probeForkConflict(f)).reason, /without conflicts/);
  assert.equal(f.git(["status", "--porcelain"]), "");
  assert.equal(fs.existsSync(path.join(f.fork, "new.txt")), false);
  f.state.log = f.state.log.replace(f.metadata.upstream_sha, "c".repeat(40));
  assert.match((await probeForkConflict(f)).reason, /no longer matches/);
});

test("delivery requires the private relay endpoint and a real accepted outcome, without leaking tokens", async (t) => {
  const f = fixture(t);
  const endpoint = "https://relay.t3.codes/v1/hooks/test/private-fixture-token";
  let deliveries = 0;
  for (const url of [
    undefined,
    "http://localhost:9224/hook",
    "https://example.com/hook",
    `${endpoint}?q=1`,
  ]) {
    await assert.rejects(
      notifyForkConflict({
        ...f,
        core,
        webhookUrl: url,
        async fetchImpl() {
          assert.fail("invalid endpoint must not receive metadata");
        },
      }),
      /webhook endpoint/,
    );
  }
  for (const outcome of [
    "accepted",
    "duplicate",
    "coalesced",
    null,
    "filtered",
    "prompt_too_long",
  ]) {
    const delivery = notifyForkConflict({
      ...f,
      core,
      webhookUrl: endpoint,
      async fetchImpl(url, options) {
        deliveries++;
        assert.equal(String(url), endpoint);
        assert.equal(options.redirect, "error");
        assert.equal(JSON.parse(options.body).fork_base, f.metadata.fork_base);
        return new Response('{"deliveryId":"fixture-delivery"}', {
          status: 202,
          headers: outcome === null ? {} : { "x-t3-hook-outcome": outcome },
        });
      },
    });
    if (["filtered", "prompt_too_long"].includes(outcome)) {
      await assert.rejects(delivery, /did not accept/);
    } else {
      await delivery;
    }
  }
  assert.equal(deliveries, 6);
  await notifyForkConflict({
    ...f,
    core,
    webhookUrl: endpoint,
    async fetchImpl() {
      return new Response('{"queued":true}', { status: 202 });
    },
  });
  for (const [status, body] of [
    [409, '{"error":"hook_disabled"}'],
    [202, "{}"],
  ]) {
    await assert.rejects(
      notifyForkConflict({
        ...f,
        core,
        webhookUrl: endpoint,
        async fetchImpl() {
          return new Response(body, { status });
        },
      }),
      /did not accept|no conflict delivery receipt/,
    );
  }
  await assert.rejects(
    notifyForkConflict({
      ...f,
      core,
      webhookUrl: endpoint,
      async fetchImpl() {
        throw new Error(endpoint);
      },
    }),
    (error) =>
      !error.message.includes("private-fixture-token") && /delivery failed/.test(error.message),
  );
});
