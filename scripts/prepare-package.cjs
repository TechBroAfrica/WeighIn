const fs = require("node:fs");
const path = require("node:path");
const { spawnSync } = require("node:child_process");

const root = path.resolve(__dirname, "..");

// The package declares these entrypoints in package.json. `dist/` is gitignored
// and therefore absent from a git clone, so npm only ships a usable git
// dependency when this script generates them before npm packs the clone.
const requiredArtifacts = [
  "dist/measurement.js",
  "dist/cli.js",
  "dist/measurement.d.ts",
  "bundled/index.js",
  "bundled/comment-action.js",
];

function run(script) {
  const result = spawnSync("npm", ["run", script], {
    cwd: root,
    stdio: "inherit",
    shell: process.platform === "win32",
  });
  if (result.error) throw result.error;
  if (result.status !== 0)
    throw new Error(`npm run ${script} exited with code ${result.status}`);
}

function missingArtifacts() {
  return requiredArtifacts.filter(
    (artifact) => !fs.existsSync(path.join(root, artifact)),
  );
}

function prepare() {
  const missing = missingArtifacts();
  if (missing.length === 0) {
    // `npm pack` runs `prepack` before `prepare`, and npm runs `prepare`
    // twice for a git dependency install. The artifacts already exist in both
    // cases, so the redundant build is skipped.
    process.stderr.write(
      "Package artifacts already present; skipping build and bundle.\n",
    );
    return;
  }

  run("build");
  run("bundle");

  const stillMissing = missingArtifacts();
  if (stillMissing.length > 0)
    throw new Error(
      `prepare did not produce required package artifacts: ${stillMissing.join(", ")}`,
    );
}

if (require.main === module) prepare();

module.exports = { requiredArtifacts };
