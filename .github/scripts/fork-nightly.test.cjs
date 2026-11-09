const assert = require("node:assert/strict");
const { execFileSync } = require("node:child_process");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const test = require("node:test");
const {
  alreadyPublished,
  prepareForkNightly,
  resolveForkVersion,
  selectLatestNightly,
} = require("./fork-nightly.cjs");

const sha = "a".repeat(40);
const upstreamSha = "b".repeat(40);
const upstreamTag = "v0.1.8-nightly.20261108.4353";
const nightly = (overrides = {}) => ({
  tag_name: upstreamTag,
  draft: false,
  prerelease: true,
  published_at: "2026-11-08T05:00:00Z",
  ...overrides,
});

test("selects the last published nightly, excluding draft, preview, and stable releases", () => {
  const latest = nightly();
  assert.equal(
    selectLatestNightly([
      nightly({ tag_name: "v0.1.8-nightly.20261107.4352", published_at: "2026-11-07T05:00:00Z" }),
      nightly({ draft: true, published_at: "2026-11-08T06:00:00Z" }),
      nightly({ tag_name: "v0.1.8-preview.20261108.4354" }),
      nightly({ tag_name: "v0.1.8", prerelease: false }),
      latest,
    ]),
    latest,
  );
  assert.throws(() => selectLatestNightly([]), /No published upstream nightly/);
});

test("keeps the nightly version shape and makes successive fork builds orderable", () => {
  assert.equal(
    resolveForkVersion(upstreamTag, "20261108", "12345678901"),
    "0.1.8-nightly.20261108.12345678901",
  );
  assert.equal(
    resolveForkVersion(upstreamTag, "20261108", "12345678902"),
    "0.1.8-nightly.20261108.12345678902",
  );
  for (const args of [
    ["v0.1.8-preview.20261108.4353", "20261108", "123"],
    [upstreamTag, "2026-11-08", "123"],
    [upstreamTag, "20261108", "0"],
    [upstreamTag, "20261108", undefined],
  ]) {
    assert.throws(() => resolveForkVersion(...args), /Invalid upstream nightly/);
  }
});

test("only deduplicates a published build of the exact fork commit with an update feed", () => {
  const release = nightly({
    body: `<!-- fork-nightly-source:${sha} -->`,
    assets: [{ name: "nightly.yml" }],
  });
  assert.equal(alreadyPublished([release], sha), true);
  assert.equal(alreadyPublished([release], upstreamSha), false);
  assert.equal(alreadyPublished([{ ...release, draft: true }], sha), false);
  assert.equal(alreadyPublished([{ ...release, assets: [] }], sha), false);
  assert.equal(alreadyPublished([{ ...release, body: "Official nightly notes" }], sha), false);
});

test("refuses to sync or publish outside the authorized fork main branch", async () => {
  for (const context of [
    { repo: { owner: "pingdotgg", repo: "t3code" }, ref: "refs/heads/main" },
    { repo: { owner: "amv146", repo: "t3code" }, ref: "refs/heads/feature" },
  ]) {
    await assert.rejects(prepareForkNightly({ context }), /must run from amv146\/t3code main/);
  }
});

function gitFixture(t, conflict) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "t3-fork-nightly-"));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const upstream = path.join(root, "upstream");
  const fork = path.join(root, "fork");
  const remote = path.join(root, "remote.git");
  const git = (cwd, ...args) =>
    execFileSync("git", args, { cwd, encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] }).trim();
  fs.mkdirSync(upstream);
  git(upstream, "init", "--initial-branch=main");
  git(upstream, "config", "user.name", "Fork test");
  git(upstream, "config", "user.email", "fork-test@example.invalid");
  git(upstream, "config", "core.autocrlf", "false");
  fs.writeFileSync(path.join(upstream, "shared.txt"), "base\n");
  git(upstream, "add", ".");
  git(upstream, "commit", "-m", "Base");
  git(root, "init", "--bare", remote);
  git(root, "clone", "--config", "core.autocrlf=false", upstream, fork);
  git(fork, "config", "user.name", "Fork test");
  git(fork, "config", "user.email", "fork-test@example.invalid");
  git(fork, "remote", "set-url", "origin", remote);
  git(
    fork,
    "config",
    `url.${upstream.replaceAll("\\", "/")}.insteadOf`,
    "https://github.com/pingdotgg/t3code.git",
  );
  fs.writeFileSync(path.join(fork, "personal.txt"), "personal feature\n");
  if (conflict) fs.writeFileSync(path.join(fork, "shared.txt"), "fork change\n");
  git(fork, "add", ".");
  git(fork, "commit", "-m", "Personal feature");
  git(fork, "push", "origin", "HEAD:main");
  const before = git(fork, "rev-parse", "HEAD");
  fs.writeFileSync(
    path.join(upstream, conflict ? "shared.txt" : "upstream.txt"),
    "nightly update\n",
  );
  git(upstream, "add", ".");
  git(upstream, "commit", "-m", "Upstream nightly");
  git(upstream, "tag", upstreamTag);
  return { fork, remote, upstream, before, git };
}

function prepareFixture(fork, releases = []) {
  const scriptPath = path.join(__dirname, "fork-nightly.cjs");
  return execFileSync(
    process.execPath,
    [
      "-e",
      `
        const { prepareForkNightly } = require(${JSON.stringify(scriptPath)});
        const outputs = {};
        const github = { rest: { repos: { async listReleases({ owner }) {
          return { data: owner === "pingdotgg" ? [${JSON.stringify(nightly())}] : ${JSON.stringify(releases)} };
        } } } };
        prepareForkNightly({
          github,
          context: { repo: { owner: "amv146", repo: "t3code" }, ref: "refs/heads/main" },
          core: { setOutput(name, value) { outputs[name] = value; }, info(message) { console.log(message); } },
        }).then(() => console.log("FORK_OUTPUTS=" + JSON.stringify(outputs)));
      `,
    ],
    {
      cwd: fork,
      encoding: "utf8",
      env: { ...process.env, GITHUB_RUN_ID: "12345678901" },
      stdio: ["ignore", "pipe", "pipe"],
    },
  );
}

function releaseBodyFixture(fork, options) {
  return execFileSync(
    process.execPath,
    [
      "-e",
      `const { forkReleaseBody } = require(${JSON.stringify(path.join(__dirname, "fork-nightly.cjs"))});
       const options = ${JSON.stringify(options)};
       process.stdout.write(forkReleaseBody(${JSON.stringify(upstreamTag)}, options.upstreamSha, options.sha, options));`,
    ],
    { cwd: fork, encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] },
  );
}

test("release notes combine new upstream and fork commits without setup text or merge noise", (t) => {
  const { fork, before, git } = gitFixture(t, false);
  const previousSha = git(fork, "rev-parse", `${before}^`);
  const outputs = JSON.parse(prepareFixture(fork).split("FORK_OUTPUTS=")[1]);
  for (let index = 1; index <= 8; index += 1) {
    git(fork, "commit", "--allow-empty", "-m", `fix(web): fork change ${index}`);
  }
  const source = git(fork, "rev-parse", "HEAD");
  const previous = nightly({
    tag_name: "v0.1.8-nightly.20261107.12345678900",
    body: `<!-- fork-nightly-source:${previousSha} -->`,
    assets: [{ name: "nightly.yml" }],
  });
  const current = nightly({
    tag_name: `v${outputs.version}`,
    body: `<!-- fork-nightly-source:${source} -->`,
    assets: [{ name: "nightly.yml" }],
    published_at: "2026-11-08T06:00:00Z",
  });
  const options = {
    version: outputs.version,
    upstreamSha: outputs.upstream_sha,
    sha: source,
    releases: [
      { ...previous, draft: true, published_at: "2026-11-09T05:00:00Z" },
      { ...previous, assets: [], published_at: "2026-11-09T05:00:00Z" },
      nightly({
        tag_name: "v0.1.8-nightly.20261110.12345678902",
        body: `<!-- fork-nightly-source:${"f".repeat(40)} -->`,
        assets: [{ name: "nightly.yml" }],
        published_at: "2026-11-10T05:00:00Z",
      }),
      previous,
      current,
    ],
  };
  const body = releaseBodyFixture(fork, options);
  const summary = body.split("<details>")[0];
  assert.ok(summary.includes(`**v${outputs.version}** · 10 changes from 1 contributor`));
  assert.equal(summary.split("\n").filter((line) => line.startsWith("- ")).length, 7);
  assert.match(summary, /fork change 8/);
  assert.match(summary, /### Plus 3 more changes\./);
  assert.match(body, /Personal feature/);
  assert.match(body, /Upstream nightly/);
  assert.match(body, new RegExp(`https://github.com/amv146/t3code/commit/${before}`));
  assert.match(body, new RegExp(`https://github.com/amv146/t3code/commit/${outputs.upstream_sha}`));
  assert.match(body, new RegExp(`<!-- fork-nightly-source:${source} -->`));
  assert.doesNotMatch(
    body,
    /Install the|unsigned|Upstream commit:|Fork commit:|Merge upstream|Base/,
  );

  const initialBody = releaseBodyFixture(fork, { ...options, releases: [] });
  assert.match(initialBody, /Personal feature/);
  assert.doesNotMatch(initialBody, /- Upstream nightly/);
  assert.match(
    releaseBodyFixture(fork, { ...options, sha: git(fork, "rev-parse", "HEAD~2") }),
    /### Plus 1 more change\./,
  );

  const unrelated = "f".repeat(40);
  assert.throws(() =>
    releaseBodyFixture(fork, {
      ...options,
      releases: [{ ...previous, body: `<!-- fork-nightly-source:${unrelated} -->` }],
    }),
  );
});

test("merges and pushes the nightly without losing personal commits, then skips an unchanged release", (t) => {
  const { fork, remote, upstream, git } = gitFixture(t, false);
  const output = prepareFixture(fork);
  const outputs = JSON.parse(output.split("FORK_OUTPUTS=")[1]);
  assert.equal(outputs.build, true);
  assert.equal(outputs.upstream_sha, git(upstream, "rev-parse", "HEAD"));
  assert.equal(outputs.sha, git(fork, "--git-dir", remote, "rev-parse", "refs/heads/main"));
  assert.equal(fs.readFileSync(path.join(fork, "personal.txt"), "utf8"), "personal feature\n");
  assert.equal(fs.readFileSync(path.join(fork, "upstream.txt"), "utf8"), "nightly update\n");
  const release = nightly({
    body: `<!-- fork-nightly-source:${outputs.sha} -->`,
    assets: [{ name: "nightly.yml" }],
  });
  const rerun = JSON.parse(prepareFixture(fork, [release]).split("FORK_OUTPUTS=")[1]);
  assert.equal(rerun.build, false);
  assert.equal(rerun.sha, outputs.sha);
});

test("a conflicting upstream update fails without pushing over the fork branch", (t) => {
  const { fork, remote, upstream, before, git } = gitFixture(t, true);
  assert.throws(
    () => prepareFixture(fork),
    (error) => {
      const marker = error.stdout.match(/FORK_NIGHTLY_CONFLICT=(\{[^\r\n]+\})/);
      assert.ok(marker, "a real conflict must emit bounded metadata for the repair trigger");
      assert.deepEqual(JSON.parse(marker[1]), {
        fork_base: before,
        upstream_sha: git(upstream, "rev-parse", "HEAD"),
        upstream_tag: upstreamTag,
      });
      return true;
    },
  );
  assert.equal(git(fork, "--git-dir", remote, "rev-parse", "refs/heads/main"), before);
  assert.equal(fs.readFileSync(path.join(fork, "personal.txt"), "utf8"), "personal feature\n");
});
