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

function isPublishedForkNightly(release) {
  return (
    !release.draft &&
    release.prerelease &&
    nightlyPattern.test(release.tag_name) &&
    release.assets?.some((asset) => asset.name === "nightly.yml")
  );
}

function alreadyPublished(releases, sha) {
  return releases.some(
    (release) => isPublishedForkNightly(release) && release.body?.includes(sourceMarker(sha)),
  );
}

function forkReleaseBody(upstreamTag, upstreamSha, sha, { version, releases }) {
  const marker = sourceMarker(sha);
  sourceMarker(upstreamSha);
  if (!nightlyPattern.test(upstreamTag) || !nightlyPattern.test(`v${version}`)) {
    throw new Error("Invalid nightly version for release notes.");
  }
  const published = releases.filter(isPublishedForkNightly);
  const current = published.find((release) => release.tag_name === `v${version}`);
  const previous = published
    .filter(
      (release) =>
        release.tag_name !== `v${version}` &&
        (!current || Date.parse(release.published_at) < Date.parse(current.published_at)),
    )
    .sort((a, b) => Date.parse(b.published_at) - Date.parse(a.published_at))[0];
  const previousSha = previous?.body?.match(/<!-- fork-nightly-source:([a-f0-9]{40}) -->/)?.[1];
  if (previous && !previousSha) {
    throw new Error(`Missing source commit in previous fork release ${previous.tag_name}.`);
  }
  const base = previousSha ?? upstreamSha;
  const git = (args) => execFileSync("git", args, { encoding: "utf8" }).trim();
  git(["merge-base", "--is-ancestor", base, sha]);
  const log = git([
    "log",
    "--no-merges",
    "--reverse",
    "--format=%H%x1f%s%x1f%an",
    `${base}..${sha}`,
  ]);
  const commits = log
    .split("\n")
    .filter(Boolean)
    .map((line) => {
      const [commit, subject, author] = line.split("\x1f");
      return { commit, subject, author };
    });
  const contributors = new Set(
    commits.map(({ author }) => author).filter((author) => !author.endsWith("[bot]")),
  ).size;
  const plural = (count, word) => `${count} ${word}${count === 1 ? "" : "s"}`;
  const summary = commits
    .slice(-7)
    .toReversed()
    .map(({ subject }) => `- ${subject.replace(/\s+\(#\d+\)$/, "")}`);
  const remaining = commits.length - summary.length;
  const fullChangelog = commits.map(
    ({ commit, subject }) =>
      `- ${subject} ([${commit.slice(0, 7)}](https://github.com/amv146/t3code/commit/${commit}))`,
  );
  return [
    `**v${version}** · ${plural(commits.length, "change")} from ${plural(contributors, "contributor")}`,
    "",
    ...summary,
    ...(remaining > 0
      ? ["", `### Plus ${remaining} more ${remaining === 1 ? "change" : "changes"}.`]
      : []),
    "",
    "<details>",
    "<summary>Full changelog</summary>",
    "",
    ...fullChangelog,
    "",
    `[Compare changes](https://github.com/amv146/t3code/compare/${base}...${sha})`,
    `[Upstream nightly](https://github.com/pingdotgg/t3code/releases/tag/${upstreamTag})`,
    "",
    "</details>",
    marker,
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
