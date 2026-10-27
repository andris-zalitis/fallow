import assert from "node:assert/strict";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";

import { assertTypescriptBackendResolvable } from "../src/backend-preflight.mjs";
import { checkMutants } from "../src/mutant-typecheck.mjs";
import { analyzeSemanticQueries, createSemanticSession } from "../src/semantic.mjs";

test("every real API entry requires an explicitly selected native backend", () => {
  const root = mkdtempSync(path.join(tmpdir(), "fallow-backend-selection-"));
  const previous = process.env.FALLOW_TYPESCRIPT_BACKEND_MANIFEST;
  delete process.env.FALLOW_TYPESCRIPT_BACKEND_MANIFEST;
  const file = path.join(root, "index.ts");
  writeFileSync(file, "export const value = 1;\n");
  const calls = [
    ["preflight", () => assertTypescriptBackendResolvable()],
    [
      "one-shot",
      () =>
        analyzeSemanticQueries({
          root,
          projects: [],
          queries: [
            { id: 0, operation: "api-surface", entry_points: [], private_leak_candidates: [] },
          ],
          evidenceLimit: 1,
          referenceScope: {
            kind: "graph",
            mode: "production",
            sources: ["index.ts"],
            roots: [{ path: "index.ts", role: "runtime" }],
            fingerprint: "a".repeat(64),
          },
        }),
    ],
    [
      "persistent",
      () => {
        const session = createSemanticSession(root);
        session.close();
      },
    ],
    [
      "mutant",
      () =>
        checkMutants({
          root,
          files: [{ absolutePath: file, sourceSha256: null, mutants: [] }],
        }),
    ],
  ];
  try {
    const outcomes = calls.map(([entry, invoke]) => {
      try {
        invoke();
        return { entry, refusedMissingSelection: false };
      } catch (error) {
        return {
          entry,
          refusedMissingSelection: /FALLOW_TYPESCRIPT_BACKEND_MANIFEST/u.test(String(error)),
        };
      }
    });
    console.log("BACKEND_SELECTION_OUTCOMES=" + JSON.stringify(outcomes));
    assert.deepEqual(
      outcomes,
      calls.map(([entry]) => ({
        entry,
        refusedMissingSelection: true,
      })),
    );
  } finally {
    if (previous === undefined) delete process.env.FALLOW_TYPESCRIPT_BACKEND_MANIFEST;
    else process.env.FALLOW_TYPESCRIPT_BACKEND_MANIFEST = previous;
    rmSync(root, { recursive: true, force: true });
  }
});
