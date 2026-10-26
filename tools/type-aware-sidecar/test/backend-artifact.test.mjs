import assert from "node:assert/strict";
import { generateKeyPairSync } from "node:crypto";
import { writeFileSync } from "node:fs";
import path from "node:path";
import test from "node:test";

import { assertTypescriptBackendResolvable } from "../src/backend-preflight.mjs";
import { backendFixture } from "../test-support/backend-fixture.mjs";

const select = (fixture, executeVersion) => assertTypescriptBackendResolvable(undefined, {
  manifestPath: fixture.manifestPath, publicKey: fixture.publicKey, executeVersion,
});

test("selection returns the signed identity and exact executable path", (t) => {
  const fixture = backendFixture(t);
  const calls = [];
  const selected = select(fixture, (file) => {
    calls.push(file);
    return { status: 0, stdout: `Version ${fixture.manifest.backend.version}\n` };
  });
  assert.equal(Object.isFrozen(selected), true);
  assert.equal(Object.isFrozen(selected.source), true);
  assert.equal(selected.version, fixture.manifest.backend.version);
  assert.equal(selected.source.tree, fixture.manifest.backend.source.tree);
  assert.deepEqual(calls, [path.join(fixture.root, "tsgo")]);
});

const invalidArtifacts = [
  ["absent manifest", (f) => { f.manifestPath = path.join(f.root, "absent.json"); }, /ENOENT/u],
  ["bad signature", (f) => writeFileSync(`${f.manifestPath}.sig`, Buffer.alloc(64)), /signature/u],
  ["wrong signing key", (f) => { f.publicKey = generateKeyPairSync("ed25519").publicKey; }, /signature/u],
  ["changed executable", (f) => writeFileSync(path.join(f.root, "tsgo"), "tampered"), /digest/u],
  ["changed notice", (f) => writeFileSync(path.join(f.root, "NOTICE.txt"), "tampered"), /digest/u],
  ["wrong source", (f) => { f.manifest.backend.source.tree = "b".repeat(40); f.save(); }, /source identity/u],
  ["wrong native identity", (f) => { f.manifest.backend.version = "stock-version"; f.save(); }, /source identity/u],
  ["wrong client compatibility", (f) => { f.manifest.backend.client_version = "different-client"; f.save(); }, /source identity/u],
  ["wrong library mode", (f) => { f.manifest.backend.build.library_mode = "external"; f.save(); }, /source identity/u],
  ["wrong target", (f) => { f.manifest.target = "wrong-target"; f.save(); }, /target/u],
];
for (const [label, mutate, expected] of invalidArtifacts) {
  test(`selection rejects ${label} before executing any native code`, (t) => {
    const fixture = backendFixture(t);
    mutate(fixture);
    const calls = [];
    assert.throws(() => select(fixture, (file) => { calls.push(file); }), expected);
    assert.deepEqual(calls, []);
  });
}

test("a signed payload cannot substitute the stock backend version", (t) => {
  const fixture = backendFixture(t);
  assert.throws(() => select(fixture, () => ({ status: 0, stdout: "Version 7.0.2\n" })), /did not report/u);
});

test("a missing explicit manifest is refused even with a compatible client", () => {
  assert.throws(() => assertTypescriptBackendResolvable(undefined, { manifestPath: "" }),
    /FALLOW_TYPESCRIPT_BACKEND_MANIFEST/u);
});
