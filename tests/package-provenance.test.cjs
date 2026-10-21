/**
 * The committed provenance manifest is the verifiable record of the packaged
 * sources and bundles. A merge that resolves a conflict badly can leave the
 * file syntactically broken or stale without changing any other tracked file,
 * and the `prepare` lifecycle regenerates the working-tree copy during `npm ci`
 * so a checkout can look healthy while the committed revision is broken.
 *
 * These tests therefore read the manifest revision that the checkout commits
 * and compare it against the current sources, exactly like the CI
 * `Verify committed package provenance` step does.
 */
const { test } = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const crypto = require("node:crypto");
const { execFileSync } = require("node:child_process");

const root = path.resolve(__dirname, "..");
const manifestRelativePath = "provenance-manifest.json";

function committedManifest(revision = "HEAD") {
  try {
    return execFileSync(
      "git",
      ["show", `${revision}:${manifestRelativePath}`],
      {
        cwd: root,
        encoding: "utf8",
        stdio: ["ignore", "pipe", "ignore"],
      },
    );
  } catch {
    return null;
  }
}

// The parents of HEAD, or an empty list for a commit that is not a merge.
function headParents() {
  try {
    const line = execFileSync(
      "git",
      ["rev-list", "--parents", "-n", "1", "HEAD"],
      { cwd: root, encoding: "utf8" },
    ).trim();
    return line.split(" ").slice(1);
  } catch {
    return [];
  }
}

// A manifest that a merge synthesized out of the two sides describes no single
// tree, so its digests cannot be compared against the merged tree.
function synthesizedByMerge(committed) {
  const parents = headParents();
  if (parents.length < 2) return false;
  return parents.every((parent) => committedManifest(parent) !== committed);
}

function sha256(file) {
  return crypto
    .createHash("sha256")
    .update(fs.readFileSync(path.join(root, file)))
    .digest("hex");
}

const committed = committedManifest();

test("the committed provenance manifest is valid JSON", (t) => {
  if (committed === null) {
    t.skip("the checkout does not track a committed provenance manifest");
    return;
  }
  let manifest;
  assert.doesNotThrow(() => {
    manifest = JSON.parse(committed);
  }, "the committed provenance manifest must be parseable JSON");
  assert.equal(manifest.schema_version, 1);
  assert.equal(typeof manifest.purpose, "string");
  assert.ok(Array.isArray(manifest.inputs));
});

test("the committed provenance manifest matches the current sources and bundles", (t) => {
  if (committed === null) {
    t.skip("the checkout does not track a committed provenance manifest");
    return;
  }
  if (synthesizedByMerge(committed)) {
    t.skip(
      "the committed manifest was synthesized by a merge and describes no single tree",
    );
    return;
  }
  const manifest = JSON.parse(committed);
  for (const input of manifest.inputs) {
    assert.ok(
      fs.existsSync(path.join(root, input.path)),
      `the committed provenance manifest references a missing file: ${input.path}`,
    );
    assert.equal(
      sha256(input.path),
      input.sha256,
      `the committed provenance manifest is stale for ${input.path}; run "npm run bundle" and commit the result`,
    );
  }
});

test("the provenance verifier accepts the committed manifest", (t) => {
  if (committed === null) {
    t.skip("the checkout does not track a committed provenance manifest");
    return;
  }
  const result = require("node:child_process").spawnSync(
    process.execPath,
    [path.join(root, "scripts/package-provenance.cjs"), "--verify"],
    { cwd: root, encoding: "utf8" },
  );
  assert.equal(
    result.status,
    0,
    `npm run provenance must accept the committed manifest:\n${result.stdout}\n${result.stderr}`,
  );
});
