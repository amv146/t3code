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
    issues: [],
    login: "amv146",
    assignmentAccepted: true,
    createError: null,
    copilotAvailable: true,
  };
  const github = {
    async paginate(method, params) {
      return (await method(params)).data;
    },
    async graphql() {
      return {
        repository: {
          suggestedActors: {
            nodes: state.copilotAvailable
              ? [{ login: "copilot-swe-agent", __typename: "Bot", id: "copilot-bot-id" }]
              : [],
          },
        },
      };
    },
    rest: {
      users: {
        async getAuthenticated() {
          return { data: { login: state.login } };
        },
      },
      issues: {
        async listForRepo() {
          return { data: state.issues };
        },
        async create(input) {
          const issue = {
            ...input,
            number: state.issues.length + 1,
            html_url: `https://github.com/amv146/t3code/issues/${state.issues.length + 1}`,
            state: "open",
            assignees: state.assignmentAccepted ? [{ login: "copilot-swe-agent[bot]" }] : [],
          };
          state.issues.push(issue);
          if (state.createError) throw state.createError;
          return { data: issue };
        },
      },
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
  return { github, context, git, state, metadata, fork, enabled: true };
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
  });
  assert.equal(f.state.issues.length, 0);
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
    });
    assert.ok(skipped.reason);
    assert.equal(f.state.issues.length, 0);
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

test("hosted repair assigns one exact conflict to Copilot and never retries an existing issue", async (t) => {
  const f = fixture(t);
  await notifyForkConflict({ ...f, core, enabled: false });
  assert.equal(f.state.issues.length, 0);
  f.state.login = "another-account";
  await assert.rejects(notifyForkConflict({ ...f, core }), /amv146/);
  assert.equal(f.state.issues.length, 0);
  f.state.login = "amv146";
  f.state.copilotAvailable = false;
  await assert.rejects(notifyForkConflict({ ...f, core }), /not available/);
  assert.equal(f.state.issues.length, 0);
  f.state.copilotAvailable = true;

  const result = await notifyForkConflict({ ...f, core });
  assert.equal(f.state.issues.length, 1);
  const issue = f.state.issues[0];
  assert.equal(result.issueUrl, issue.html_url);
  assert.match(issue.title, new RegExp(`${f.metadata.fork_base}-${f.metadata.upstream_sha}`));
  assert.match(issue.body, /two-parent merge/);
  assert.match(issue.body, /Do not squash/);
  assert.match(issue.body, /human must review and merge/);
  assert.match(issue.body, /vp run check:changed/);
  assert.match(issue.body, new RegExp(f.metadata.upstream_sha));
  assert.equal(issue.agent_assignment.target_repo, "amv146/t3code");
  assert.equal(issue.agent_assignment.base_branch, "main");
  assert.deepEqual(issue.assignees, [{ login: "copilot-swe-agent[bot]" }]);
  assert.match((await notifyForkConflict({ ...f, core })).reason, /already exists/);
  issue.state = "closed";
  issue.title = "Renamed after triage";
  issue.assignees = [];
  assert.match((await notifyForkConflict({ ...f, core })).reason, /already exists/);
  assert.equal(f.state.issues.length, 1);
});

test("ambiguous creation and rejected assignment fail explicitly without dispatching a second agent", async (t) => {
  const f = fixture(t);
  f.state.createError = new Error("Connection interrupted");
  await assert.rejects(notifyForkConflict({ ...f, core }), /Connection interrupted/);
  assert.equal(f.state.issues.length, 1);
  assert.match((await notifyForkConflict({ ...f, core })).reason, /already exists/);
  assert.equal(f.state.issues.length, 1);

  const rejected = fixture(t);
  rejected.state.assignmentAccepted = false;
  await assert.rejects(notifyForkConflict({ ...rejected, core }), /did not assign Copilot/);
  assert.match((await notifyForkConflict({ ...rejected, core })).reason, /already exists/);
  assert.equal(rejected.state.issues.length, 1);
});
