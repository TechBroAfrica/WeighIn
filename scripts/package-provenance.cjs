const fs = require("node:fs");
const path = require("node:path");
const crypto = require("node:crypto");
const { execFileSync } = require("node:child_process");

const root = path.resolve(__dirname, "..");
const manifestRelativePath = "provenance-manifest.json";
const manifestPath = path.join(root, manifestRelativePath);
const tracked = [
  "package.json",
  "package-lock.json",
  "action.yml",
  "src",
  "native/simulation/Cargo.toml",
  "native/simulation/Cargo.lock",
  "native/simulation/src",
  "bundled/index.js",
  "bundled/comment-action.js",
];
function files(value) {
  const absolute = path.join(root, value);
  if (!fs.existsSync(absolute)) return [];
  if (fs.statSync(absolute).isFile()) return [value];
  return fs
    .readdirSync(absolute, { withFileTypes: true })
    .flatMap((entry) => files(path.join(value, entry.name)));
}
function sha256(file) {
  return crypto
    .createHash("sha256")
    .update(fs.readFileSync(path.join(root, file)))
    .digest("hex");
}
function command(name, args) {
  try {
    return execFileSync(name, args, { cwd: root, encoding: "utf8" }).trim();
  } catch {
    return "unavailable";
  }
}
// Reads the manifest revision that the checkout commits, or null when the
// tree is not a git checkout that tracks it (an unpacked tarball, for example).
function committedManifest() {
  try {
    return execFileSync("git", ["show", `HEAD:${manifestRelativePath}`], {
      cwd: root,
      encoding: "utf8",
      stdio: ["ignore", "pipe", "ignore"],
    });
  } catch {
    return null;
  }
}
const entries = [...new Set(tracked.flatMap(files))]
  .sort()
  .map((file) => ({ path: file, sha256: sha256(file) }));
const manifest = {
  schema_version: 1,
  purpose: "verifiable WeighIn package build provenance",
  source_revision: command("git", ["rev-parse", "HEAD"]),
  tools: { node: process.version, npm: command("npm", ["--version"]) },
  inputs: entries,
};
if (process.argv.includes("--verify")) {
  // The manifest that the repository commits is the one that has to be
  // verifiable. `npm run bundle` regenerates the working-tree copy, and
  // `npm ci` runs that bundle through the `prepare` lifecycle, so verifying
  // the working-tree copy would accept a committed manifest that is broken or
  // stale. The committed revision is therefore preferred whenever the tree is
  // a git checkout that tracks the manifest.
  const committed = committedManifest();
  if (!committed && !fs.existsSync(manifestPath))
    throw new Error("provenance-manifest.json is missing");
  const origin = committed ? "committed" : "working tree";
  const raw = committed ?? fs.readFileSync(manifestPath, "utf8");
  let actual;
  try {
    actual = JSON.parse(raw);
  } catch (error) {
    throw new Error(
      `provenance-manifest.json (${origin}) is not valid JSON: ${error.message}`,
    );
  }
  // The recorded source revision and the tool identities describe the
  // checkout that produced the manifest. A pull request is verified from a
  // merge commit whose SHA the committed manifest cannot contain, and CI runs
  // a different Node/npm patch release than the machine that generated the
  // committed manifest, so both fields are informational. Every recorded
  // digest is still compared against the current source and bundles.
  const { source_revision, tools, ...actualContent } = actual;
  const {
    source_revision: computedRevision,
    tools: computedTools,
    ...expectedContent
  } = manifest;
  if (JSON.stringify(actualContent) !== JSON.stringify(expectedContent))
    throw new Error(
      "package provenance manifest is stale or does not match source and bundles",
    );
  process.stderr.write(
    `Package provenance verified (${origin} source revision ${source_revision}, verified against ${computedRevision})\n`,
  );
} else {
  fs.writeFileSync(manifestPath, `${JSON.stringify(manifest, null, 2)}\n`);
  process.stderr.write(`Wrote ${manifestPath}\n`);
}
