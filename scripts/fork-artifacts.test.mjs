import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";

import { backendBuildArgs, backendInputs, reconstructBackend } from "./fork-artifacts.mjs";

const reconstructed = (t, tree) => {
  const root = mkdtempSync(path.join(tmpdir(), "fallow-backend-source-"));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const calls = [];
  const destination = path.join(root, "source");
  const execute = (args, cwd) => {
    calls.push({ args, cwd });
    return args[1] === "write-tree" ? tree : "";
  };
  return { calls, destination, execute };
};

test("backend reconstruction applies the canonical delta before requiring the complete source tree", (t) => {
  const { backend } = backendInputs();
  const fixture = reconstructed(t, backend.source.tree);
  assert.deepEqual(reconstructBackend(fixture.destination, { execute: fixture.execute }), backend);
  assert.deepEqual(fixture.calls.map(({ args }) => args.slice(0, 2)), [
    ["git", "init"], ["git", "remote"], ["git", "fetch"],
    ["git", "sparse-checkout"], ["git", "sparse-checkout"],
    ["git", "checkout"], ["git", "apply"], ["git", "write-tree"],
  ]);
  assert.equal(fixture.calls.every(({ cwd }) => cwd === fixture.destination), true);
  assert.deepEqual(fixture.calls[2].args, [
    "git", "fetch", "--quiet", "--depth=1", "origin", backend.source.base_revision,
  ]);
  const apply = fixture.calls[6].args;
  assert.deepEqual(apply.slice(0, -1), ["git", "apply", "--unidiff-zero", "--index"]);
  assert.equal(apply.at(-1).endsWith(backend.source.delta_path), true);
});

test("backend reconstruction refuses a different full tree even when its commands succeeded", (t) => {
  const fixture = reconstructed(t, "b".repeat(40));
  assert.throws(() => reconstructBackend(fixture.destination, { execute: fixture.execute }),
    /reconstructed backend tree .* does not match/u);
});

test("backend build has deterministic paths, qualified identity and default embedded libraries", () => {
  const { backend } = backendInputs();
  assert.deepEqual(backendBuildArgs("/toolchain/go", "/output/tsgo", backend), [
    "/toolchain/go", "build", "-mod=readonly", "-trimpath", "-buildvcs=false",
    "-ldflags", `-X github.com/microsoft/typescript-go/internal/core.version=${backend.version} -buildid=`,
    "-o", "/output/tsgo", "./cmd/tsgo",
  ]);
  assert.equal(backend.build.library_mode, "embedded");
});
