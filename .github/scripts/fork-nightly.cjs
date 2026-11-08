const { execFileSync } = require("node:child_process");

const nightlyPattern = /^v(\d+\.\d+\.\d+)-nightly\.(\d{8})\.(\d+)$/;

function selectLatestNightly(releases) {
  const nightly = releases
    .filter(
      (release) =>
        !release.draft &&
        release.prerelease &&
        release.published_at &&
        nightlyPattern.test(release.tag_name),
    )
    .sort((a, b) => Date.parse(b.published_at) - Date.parse(a.published_at))[0];
  if (!nightly) throw new Error("No published upstream nightly was found.");
  return nightly;
}

function resolveForkVersion(upstreamTag, date, runId) {
  const match = nightlyPattern.exec(upstreamTag);
  if (!match || !/^\d{8}$/.test(date) || !/^[1-9]\d*$/.test(String(runId))) {
    throw new Error("Invalid upstream nightly, build date, or workflow run ID.");
  }
  return `${match[1]}-nightly.${date}.${runId}`;
}

function sourceMarker(sha) {
  if (!/^[a-f0-9]{40}$/.test(sha)) throw new Error("Invalid fork source commit.");
  return `<!-- fork-nightly-source:${sha} -->`;
}

function alreadyPublished(releases, sha) {
  return releases.some(
    (release) =>
      !release.draft &&
      release.prerelease &&
      nightlyPattern.test(release.tag_name) &&
      release.body?.includes(sourceMarker(sha)) &&
      release.assets?.some((asset) => asset.name === "nightly.yml"),
  );
}

function forkReleaseBody(upstreamTag, upstreamSha, sha) {
  return [
    `Windows x64 build of [${upstreamTag}](https://github.com/pingdotgg/t3code/releases/tag/${upstreamTag}) with the commits on this fork's main branch.`,
    "",
    "Install the `.exe` once to switch from official T3 Code to this fork's update feed. Keep the Nightly update channel selected. Later builds appear in the normal desktop update UI.",
    "",
    "The installer is unsigned unless this fork has its own Windows signing credentials. It includes a matching, smoke-tested Linux runtime for WSL.",
    "",
    `Upstream commit: ${upstreamSha}`,
    `Fork commit: ${sha}`,
    sourceMarker(sha),
    "",
  ].join("\n");
}

async function prepareForkNightly({ github, context, core }) {
  if (
    `${context.repo.owner}/${context.repo.repo}` !== "amv146/t3code" ||
    context.ref !== "refs/heads/main"
  ) {
    throw new Error("Fork nightlies must run from amv146/t3code main.");
  }
  const { data: upstreamReleases } = await github.rest.repos.listReleases({
    owner: "pingdotgg",
    repo: "t3code",
    per_page: 100,
  });
  const upstream = selectLatestNightly(upstreamReleases);
  const git = (args) => execFileSync("git", args, { encoding: "utf8" }).trim();
  git(["config", "user.name", "github-actions[bot]"]);
  git(["config", "user.email", "41898282+github-actions[bot]@users.noreply.github.com"]);
  git([
    "fetch",
    "--no-tags",
    "https://github.com/pingdotgg/t3code.git",
    `refs/tags/${upstream.tag_name}`,
  ]);
  const upstreamSha = git(["rev-parse", "FETCH_HEAD^{commit}"]);
  const forkBase = git(["rev-parse", "HEAD"]);
  try {
    execFileSync(
      "git",
      ["merge", "--no-edit", "-m", `Merge upstream nightly ${upstream.tag_name}`, upstreamSha],
      { stdio: "inherit" },
    );
  } catch (error) {
    if (git(["ls-files", "--unmerged"])) {
      core.info(
        `FORK_NIGHTLY_CONFLICT=${JSON.stringify({
          fork_base: forkBase,
          upstream_sha: upstreamSha,
          upstream_tag: upstream.tag_name,
        })}`,
      );
    }
    throw error;
  }
  const sha = git(["rev-parse", "HEAD"]);
  const { data: forkReleases } = await github.rest.repos.listReleases({
    ...context.repo,
    per_page: 100,
  });
  core.setOutput("build", !alreadyPublished(forkReleases, sha));
  core.setOutput("sha", sha);
  core.setOutput("upstream_sha", upstreamSha);
  core.setOutput("upstream_tag", upstream.tag_name);
  core.setOutput(
    "version",
    resolveForkVersion(
      upstream.tag_name,
      new Date().toISOString().slice(0, 10).replaceAll("-", ""),
      process.env.GITHUB_RUN_ID,
    ),
  );
  execFileSync("git", ["push", "origin", "HEAD:main"], { stdio: "inherit" });
  core.info(`Fork source ${sha}; upstream nightly ${upstream.tag_name} (${upstreamSha}).`);
}

module.exports = {
  alreadyPublished,
  forkReleaseBody,
  prepareForkNightly,
  resolveForkVersion,
  selectLatestNightly,
};
