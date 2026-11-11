const assert = require("node:assert/strict");
const { spawnSync } = require("node:child_process");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const test = require("node:test");

function fixture(t) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "t3-fork-dependencies-"));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  return root;
}

function run(script, env) {
  const result = spawnSync(
    "bash",
    ["--noprofile", "--norc", "-e", "-o", "pipefail", "-c", script],
    {
      encoding: "utf8",
      env: { ...process.env, ...env },
    },
  );
  assert.ifError(result.error);
  return result;
}

test("APT failover covers GitHub mirror lists, direct Ubuntu sources, and existing Blacksmith sources", (t) => {
  const root = fixture(t);
  fs.mkdirSync(path.join(root, "sources.list.d"));
  fs.mkdirSync(path.join(root, "apt.conf.d"));
  const sources = {
    "sources.list": [
      "deb http://azure.archive.ubuntu.com/ubuntu/ noble main",
      "deb https://archive.ubuntu.com/ubuntu noble-updates main",
      "deb http://security.ubuntu.com/ubuntu/ noble-security main",
      "deb https://packages.example.invalid/ubuntu noble main",
    ].join("\n"),
    "sources.list.d/ubuntu.sources":
      "Types: deb\nURIs: mirror+file:/etc/apt/apt-mirrors.txt\nSuites: noble noble-updates\nComponents: main universe\n",
    "sources.list.d/blacksmith.sources":
      "Types: deb\nURIs: mirror+file:/etc/apt/blacksmith-ubuntu-mirrors.txt\nSuites: noble\nComponents: main\n",
  };
  for (const [file, contents] of Object.entries(sources)) {
    fs.writeFileSync(path.join(root, file), contents);
  }
  const action = fs.readFileSync(
    path.join(__dirname, "../actions/setup-apt-mirrors/action.yml"),
    "utf8",
  );
  const step = action.match(/      run: \|\n([\s\S]+)/);
  assert.ok(step);
  const script =
    `sudo() {
      local arg
      local args=()
      for arg in "$@"; do
        if [[ "$arg" == /etc/apt* ]]; then
          args+=("$FIXTURE_APT\${arg#/etc/apt}")
        else
          args+=("$arg")
        fi
      done
      "\${args[@]}"
    }\n` + step[1].replace(/^        /gm, "");
  const env = { FIXTURE_APT: root.replaceAll("\\", "/") };
  const result = run(script, env);
  assert.equal(result.status, 0, result.stderr);
  const mirror = "mirror+file:/etc/apt/blacksmith-ubuntu-mirrors.txt";
  assert.equal(
    fs.readFileSync(path.join(root, "sources.list"), "utf8"),
    [
      `deb ${mirror} noble main`,
      `deb ${mirror} noble-updates main`,
      `deb ${mirror} noble-security main`,
      "deb https://packages.example.invalid/ubuntu noble main",
    ].join("\n"),
  );
  assert.equal(
    fs.readFileSync(path.join(root, "sources.list.d/ubuntu.sources"), "utf8"),
    sources["sources.list.d/ubuntu.sources"].replace(
      "mirror+file:/etc/apt/apt-mirrors.txt",
      mirror,
    ),
  );
  assert.equal(
    fs.readFileSync(path.join(root, "sources.list.d/blacksmith.sources"), "utf8"),
    sources["sources.list.d/blacksmith.sources"],
  );
  assert.equal(run(script, env).status, 0);
});

test("fork browser dependency checks avoid unnecessary APT installs without masking failures", (t) => {
  const scripts = ["fork-nightly.yml", "fork-pr.yml"].map((file) => {
    const workflow = fs.readFileSync(path.join(__dirname, "../workflows", file), "utf8");
    const step = workflow.match(
      /- name: Install missing Chromium system dependencies\n        run: \|\n((?:          .*\n|\n)+)/,
    );
    assert.ok(step, `${file} must check cached Chromium dependencies`);
    return step[1].replace(/^          /gm, "");
  });
  assert.equal(scripts[0], scripts[1]);
  for (const { browser = true, libraries = "", lddExit = 0, installExit = 0, status, installs } of [
    { status: 0, installs: false },
    { libraries: "libnss3.so => not found", status: 0, installs: true },
    { browser: false, status: 1, installs: false },
    { lddExit: 2, status: 2, installs: false },
    { libraries: "libnss3.so => not found", installExit: 100, status: 100, installs: true },
  ]) {
    const root = fixture(t);
    const cache = path.join(root, ".cache", "ms-playwright", "chromium_headless_shell-1234");
    fs.mkdirSync(cache, { recursive: true });
    if (browser) fs.writeFileSync(path.join(cache, "chrome-headless-shell"), "");
    const calls = path.join(root, "calls");
    const result = run(
      `ldd() { printf '%s\\n' "$FIXTURE_LIBRARIES"; return "$FIXTURE_LDD_EXIT"; }
       node() { printf '%s\\n' "$*" >> "$FIXTURE_CALLS"; return "$FIXTURE_INSTALL_EXIT"; }\n` +
        scripts[0],
      {
        HOME: root.replaceAll("\\", "/"),
        FIXTURE_CALLS: calls.replaceAll("\\", "/"),
        FIXTURE_LIBRARIES: libraries,
        FIXTURE_LDD_EXIT: String(lddExit),
        FIXTURE_INSTALL_EXIT: String(installExit),
      },
    );
    assert.equal(result.status, status, result.stderr);
    assert.equal(
      fs.existsSync(calls) ? fs.readFileSync(calls, "utf8") : "",
      installs ? "apps/web/node_modules/playwright/cli.js install-deps chromium\n" : "",
    );
  }
});
