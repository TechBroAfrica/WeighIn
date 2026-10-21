/**
 * Regression coverage for installing WeighIn as an npm git dependency.
 *
 * npm resolves a git dependency by fetching the pinned revision (a git clone,
 * or the hosted commit archive), installing its `dependencies` and
 * `devDependencies` into it, running the `prepare` script there, and only then
 * packing it with the `files` allowlist. The committed tree deliberately omits
 * `dist/`, so without a `prepare` script npm installs a package whose declared
 * `main`, `types` and `bin` entrypoints do not exist. npm still exits 0, which
 * makes the breakage silent for the consumer.
 *
 * These tests install from an immutable revision of a local git fixture that
 * mirrors the tracked working tree, which is the same npm git-dependency path
 * used by `git+https://github.com/WeighInNG/WeighIn.git#<commit>`. No branch
 * name or mutable reference is used.
 */
const { test } = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const os = require("node:os");
const { spawnSync, execFileSync } = require("node:child_process");
const { npmInstall } = require("../support/npm-install.cjs");

const repoRoot = path.resolve(__dirname, "..", "..");
const installTimeout = 900000;

/**
 * Runs git in the given directory and returns its trimmed stdout.
 */
function git(args, cwd) {
  return execFileSync("git", args, { cwd, encoding: "utf8" }).trim();
}

/**
 * Copies the tracked working tree into a destination directory.
 * The file set is exactly what a clone of this revision contains: tracked
 * files plus untracked files that are not ignored, so build outputs that are
 * gitignored stay absent.
 */
function copyTrackedFiles(destination) {
  fs.mkdirSync(destination, { recursive: true });
  const tracked = git(
    ["ls-files", "--cached", "--others", "--exclude-standard", "-z"],
    repoRoot,
  )
    .split("\0")
    .filter(Boolean);
  for (const file of tracked) {
    const source = path.join(repoRoot, file);
    const target = path.join(destination, file);
    fs.mkdirSync(path.dirname(target), { recursive: true });
    fs.copyFileSync(source, target);
    fs.chmodSync(target, fs.statSync(source).mode);
  }
  return tracked;
}

/**
 * Mirrors the tracked working tree into a fresh git repository and commits it.
 */
function createGitFixture(destination, files) {
  copyTrackedFiles(destination);
  if (files)
    for (const [file, contents] of Object.entries(files)) {
      const target = path.join(destination, file);
      fs.mkdirSync(path.dirname(target), { recursive: true });
      fs.writeFileSync(target, contents);
    }
  return commitFixture(destination);
}

/**
 * Creates a git repository that holds only the given files. The failure cases
 * exercise npm's git-dependency handling, so they do not need the project
 * sources and stay cheap.
 */
function createMinimalGitFixture(destination, files) {
  fs.mkdirSync(destination, { recursive: true });
  for (const [file, contents] of Object.entries(files)) {
    const target = path.join(destination, file);
    fs.mkdirSync(path.dirname(target), { recursive: true });
    fs.writeFileSync(target, contents);
  }
  return commitFixture(destination);
}

function commitFixture(destination) {
  git(["init", "-q"], destination);
  git(["add", "-A"], destination);
  git(
    [
      "-c",
      "user.name=WeighIn Test",
      "-c",
      "user.email=test@example.invalid",
      "-c",
      "commit.gpgsign=false",
      "commit",
      "-q",
      "-m",
      "fixture",
    ],
    destination,
  );
  return git(["rev-parse", "HEAD"], destination);
}

/**
 * Creates an isolated consumer project outside the repository.
 */
function createConsumer(destination) {
  fs.mkdirSync(destination, { recursive: true });
  fs.writeFileSync(
    path.join(destination, "package.json"),
    JSON.stringify({
      name: "git-dependency-consumer",
      private: true,
      version: "1.0.0",
    }),
  );
  return destination;
}

function installGitDependency(consumerDir, spec) {
  // `--prefer-offline` resolves the locked dependency graph from the npm cache
  // that CI restores, so the install does not depend on a burst of registry
  // requests that the shared runner IP can have throttled.
  return npmInstall(["--prefer-offline", "--no-audit", "--no-fund", spec], {
    cwd: consumerDir,
    timeout: installTimeout,
  });
}

function temporaryDirectory(prefix) {
  return fs.mkdtempSync(path.join(os.tmpdir(), prefix));
}

test("git dependency install from an immutable revision ships the declared entrypoints", (t) => {
  const fixtureDir = temporaryDirectory("weighin-git-fixture-");
  const consumerDir = temporaryDirectory("weighin-git-consumer-");
  t.after(() => {
    fs.rmSync(fixtureDir, { recursive: true, force: true });
    fs.rmSync(consumerDir, { recursive: true, force: true });
  });

  const revision = createGitFixture(fixtureDir);
  assert.match(
    revision,
    /^[0-9a-f]{40}$/,
    "fixture must expose an immutable revision",
  );
  assert.equal(
    fs.existsSync(path.join(fixtureDir, "dist")),
    false,
    "a cloned revision must not contain the gitignored dist/ directory",
  );

  createConsumer(consumerDir);
  const install = installGitDependency(
    consumerDir,
    `git+file://${fixtureDir}#${revision}`,
  );
  assert.equal(
    install.status,
    0,
    `git dependency install failed:\n${install.stdout}\n${install.stderr}`,
  );

  const installed = path.join(consumerDir, "node_modules", "weighin");
  for (const artifact of [
    "dist/measurement.js",
    "dist/cli.js",
    "dist/measurement.d.ts",
    "bundled/index.js",
    "bundled/comment-action.js",
  ])
    assert.ok(
      fs.existsSync(path.join(installed, artifact)),
      `installed package must contain ${artifact}`,
    );

  const api = spawnSync(
    process.execPath,
    [
      "-e",
      `const api = require('weighin');
       if (typeof api.runMeasurement !== 'function') throw new Error('runMeasurement missing');
       if (typeof api.metricsFromSimulation !== 'function') throw new Error('metricsFromSimulation missing');
       if (typeof api.toScVal !== 'function') throw new Error('toScVal missing');
       console.log(require.resolve('weighin'));`,
    ],
    { cwd: consumerDir, encoding: "utf8", timeout: 60000 },
  );
  assert.equal(
    api.status,
    0,
    `installed package API is not usable:\n${api.stderr}`,
  );
  assert.ok(
    api.stdout.trim().startsWith(installed),
    `package must resolve inside the consumer, got ${api.stdout.trim()}`,
  );

  const bin = path.join(consumerDir, "node_modules", ".bin", "weighin");
  assert.ok(
    fs.existsSync(bin),
    "the declared CLI must be linked in the consumer",
  );
  const cli = spawnSync(
    bin,
    [path.join(consumerDir, "missing-fixtures.json")],
    {
      cwd: consumerDir,
      encoding: "utf8",
      timeout: 60000,
    },
  );
  assert.equal(
    cli.status,
    1,
    "the installed CLI must exit 1 for a missing fixture",
  );
  assert.match(cli.stderr, /Benchmarking failed/);
  assert.match(cli.stderr, /ENOENT/);

  const manifest = JSON.parse(
    fs.readFileSync(path.join(installed, "provenance-manifest.json"), "utf8"),
  );
  assert.equal(
    manifest.source_revision,
    revision,
    "the installed provenance manifest must record the pinned revision",
  );
});

test("git dependency install rejects an invalid commit reference", (t) => {
  const fixtureDir = temporaryDirectory("weighin-git-invalid-ref-");
  const consumerDir = temporaryDirectory("weighin-git-invalid-consumer-");
  t.after(() => {
    fs.rmSync(fixtureDir, { recursive: true, force: true });
    fs.rmSync(consumerDir, { recursive: true, force: true });
  });

  createMinimalGitFixture(fixtureDir, {
    "package.json": JSON.stringify({
      name: "invalid-reference-probe",
      version: "1.0.0",
      main: "index.js",
    }),
    "index.js": "module.exports = {};\n",
  });
  createConsumer(consumerDir);
  const install = installGitDependency(
    consumerDir,
    `git+file://${fixtureDir}#${"0".repeat(40)}`,
  );
  assert.notEqual(
    install.status,
    0,
    "an invalid revision must not report success",
  );
  assert.match(install.stderr, /reference is not a tree/);
  assert.equal(
    fs.existsSync(path.join(consumerDir, "node_modules", "weighin")),
    false,
    "a failed install must not leave an installed package behind",
  );
});

test("git dependency install fails when the prepare lifecycle fails", (t) => {
  const fixtureDir = temporaryDirectory("weighin-git-prepare-failure-");
  const consumerDir = temporaryDirectory("weighin-git-prepare-consumer-");
  t.after(() => {
    fs.rmSync(fixtureDir, { recursive: true, force: true });
    fs.rmSync(consumerDir, { recursive: true, force: true });
  });

  const revision = createMinimalGitFixture(fixtureDir, {
    "package.json": JSON.stringify({
      name: "prepare-failure-probe",
      version: "1.0.0",
      main: "index.js",
      scripts: {
        prepare:
          "node -e \"console.error('PREPARE_FAILURE_MARKER');process.exit(7)\"",
      },
    }),
    "index.js": "module.exports = {};\n",
  });
  createConsumer(consumerDir);
  const install = installGitDependency(
    consumerDir,
    `git+file://${fixtureDir}#${revision}`,
  );
  assert.notEqual(
    install.status,
    0,
    "a failing prepare script must not report success",
  );
  assert.match(install.stderr, /git dep preparation failed/);
  assert.match(install.stderr, /PREPARE_FAILURE_MARKER/);
  assert.equal(
    fs.existsSync(
      path.join(consumerDir, "node_modules", "prepare-failure-probe"),
    ),
    false,
    "a failed install must not leave an installed package behind",
  );
});

test("a git dependency whose prepare omits its declared entrypoint stays unusable", (t) => {
  const fixtureDir = temporaryDirectory("weighin-git-missing-entrypoint-");
  const consumerDir = temporaryDirectory("weighin-git-missing-consumer-");
  t.after(() => {
    fs.rmSync(fixtureDir, { recursive: true, force: true });
    fs.rmSync(consumerDir, { recursive: true, force: true });
  });

  const revision = createMinimalGitFixture(fixtureDir, {
    "package.json": JSON.stringify({
      name: "missing-entrypoint-probe",
      version: "1.0.0",
      main: "dist/measurement.js",
      scripts: { prepare: 'node -e "process.exit(0)"' },
    }),
  });
  createConsumer(consumerDir);
  const install = installGitDependency(
    consumerDir,
    `git+file://${fixtureDir}#${revision}`,
  );
  // npm does not inspect declared entrypoints, so the install itself succeeds.
  // The package is still unusable, which is why the entrypoint assertions of
  // the success case above are required.
  assert.equal(install.status, 0);
  assert.equal(
    fs.existsSync(
      path.join(
        consumerDir,
        "node_modules",
        "missing-entrypoint-probe",
        "dist",
        "measurement.js",
      ),
    ),
    false,
    "the probe package must not declare an entrypoint it never generates",
  );
  const api = spawnSync(
    process.execPath,
    ["-e", "require('missing-entrypoint-probe');"],
    { cwd: consumerDir, encoding: "utf8", timeout: 60000 },
  );
  assert.notEqual(
    api.status,
    0,
    "a package without its declared entrypoint must not load",
  );
  assert.match(api.stderr, /MODULE_NOT_FOUND|Cannot find module/);
});

const hostedUrl = process.env.WEIGHIN_GIT_INSTALL_URL;
const hostedRevision = process.env.WEIGHIN_GIT_INSTALL_SHA;

test("prepare succeeds in a source tree without git metadata", (t) => {
  const archiveDir = temporaryDirectory("weighin-git-archive-");
  t.after(() => {
    fs.rmSync(archiveDir, { recursive: true, force: true });
  });

  // npm extracts a hosted commit archive, which is the committed tree without
  // the .git directory. The generation step must still succeed there, because
  // the hosted repository is the documented installation source.
  copyTrackedFiles(archiveDir);
  fs.symlinkSync(
    path.join(repoRoot, "node_modules"),
    path.join(archiveDir, "node_modules"),
  );
  const prepare = spawnSync("npm", ["run", "prepare"], {
    cwd: archiveDir,
    encoding: "utf8",
    timeout: 300000,
  });
  assert.equal(
    prepare.status,
    0,
    `prepare must succeed without git metadata:\n${prepare.stdout}\n${prepare.stderr}`,
  );

  for (const artifact of [
    "dist/measurement.js",
    "dist/cli.js",
    "dist/measurement.d.ts",
    "bundled/index.js",
    "bundled/comment-action.js",
  ])
    assert.ok(
      fs.existsSync(path.join(archiveDir, artifact)),
      `prepare must produce ${artifact}`,
    );

  const manifest = JSON.parse(
    fs.readFileSync(path.join(archiveDir, "provenance-manifest.json"), "utf8"),
  );
  assert.equal(
    manifest.source_revision,
    "unavailable",
    "a tree without git metadata must not claim a source revision",
  );
});

test(
  "hosted git dependency install from the immutable revision ships the declared entrypoints",
  {
    skip:
      hostedUrl && hostedRevision
        ? false
        : "set WEIGHIN_GIT_INSTALL_URL and WEIGHIN_GIT_INSTALL_SHA to verify the hosted repository",
  },
  (t) => {
    const consumerDir = temporaryDirectory("weighin-hosted-consumer-");
    t.after(() => {
      fs.rmSync(consumerDir, { recursive: true, force: true });
    });

    assert.match(
      hostedRevision,
      /^[0-9a-f]{40}$/,
      "the hosted revision must be immutable",
    );
    createConsumer(consumerDir);
    const install = installGitDependency(
      consumerDir,
      `${hostedUrl}#${hostedRevision}`,
    );
    assert.equal(
      install.status,
      0,
      `hosted git dependency install failed:\n${install.stdout}\n${install.stderr}`,
    );

    const installed = path.join(consumerDir, "node_modules", "weighin");
    for (const artifact of [
      "dist/measurement.js",
      "dist/cli.js",
      "dist/measurement.d.ts",
    ])
      assert.ok(
        fs.existsSync(path.join(installed, artifact)),
        `installed package must contain ${artifact}`,
      );

    const api = spawnSync(
      process.execPath,
      [
        "-e",
        `const api = require('weighin');
         if (typeof api.runMeasurement !== 'function') throw new Error('runMeasurement missing');
         console.log(require.resolve('weighin'));`,
      ],
      { cwd: consumerDir, encoding: "utf8", timeout: 60000 },
    );
    assert.equal(
      api.status,
      0,
      `installed package API is not usable:\n${api.stderr}`,
    );
    assert.ok(api.stdout.trim().startsWith(installed));

    const bin = path.join(consumerDir, "node_modules", ".bin", "weighin");
    assert.ok(
      fs.existsSync(bin),
      "the declared CLI must be linked in the consumer",
    );
    const cli = spawnSync(
      bin,
      [path.join(consumerDir, "missing-fixtures.json")],
      {
        cwd: consumerDir,
        encoding: "utf8",
        timeout: 60000,
      },
    );
    assert.equal(
      cli.status,
      1,
      "the installed CLI must exit 1 for a missing fixture",
    );
    assert.match(cli.stderr, /Benchmarking failed/);
    assert.match(cli.stderr, /ENOENT/);

    const manifest = JSON.parse(
      fs.readFileSync(path.join(installed, "provenance-manifest.json"), "utf8"),
    );
    // npm extracts a hosted commit archive without git metadata, so the
    // revision cannot be read back from the source tree in that transport.
    assert.ok(
      manifest.source_revision === hostedRevision ||
        manifest.source_revision === "unavailable",
      `unexpected installed provenance revision ${manifest.source_revision}`,
    );
  },
);
