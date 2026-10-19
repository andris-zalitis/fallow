import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";

import { parseRequest } from "../src/protocol.mjs";
import { analyzeSemanticQueries, createSemanticSession } from "../src/semantic.mjs";
import { ANALYSIS_OPERATION, WIRE_PROTOCOL_VERSION } from "../src/generated-protocol.mjs";

const write = (root, file, source) => {
  const destination = path.join(root, file);
  mkdirSync(path.dirname(destination), { recursive: true });
  writeFileSync(destination, source);
};
const scope = (sources) => ({
  kind: "graph",
  mode: "production",
  sources: [...sources].sort(),
  roots: [{ path: "src/index.ts", role: "runtime" }],
  fingerprint: "a".repeat(64),
});
const request = (root, referenceScope, evidenceLimit = 1) => ({
  protocol_version: WIRE_PROTOCOL_VERSION,
  operation: ANALYSIS_OPERATION,
  root,
  projects: ["tsconfig.json"],
  evidence_limit: evidenceLimit,
  reference_scope: referenceScope,
  queries: [{
    id: 0,
    operation: "symbol-use",
    symbol: {
      path: "src/worker.ts", namespace: "value", declaration_kind: "class_method",
      exported_name: "execute", local_name: "execute", owner: "Worker", line: 2, col: 2,
    },
    framework_contracts: [],
  }],
});
const project = (run) => {
  const root = mkdtempSync(path.join(tmpdir(), "fallow-reference-scope-"));
  try {
    write(root, "tsconfig.json", JSON.stringify({ compilerOptions: { strict: true }, include: ["src/**/*.ts"] }));
    write(root, "src/worker.ts", "export class Worker {\n  execute(): void {}\n}\nexport const worker = new Worker();\n");
    write(root, "src/index.ts", "import { worker } from './worker';\nconsole.log(worker);\n");
    return run(root);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
};
// Exercise the scanner independently of wire validation for the RED control.
const semanticInput = (raw) => {
  const { reference_scope: referenceScope, ...existingRequest } = raw;
  return { ...parseRequest(existingRequest), referenceScope };
};

for (const excluded of ["a-caller.ts", "z-caller.ts"]) {
  test(`native scope excludes a real ordinary-file caller (${excluded}) before evidence collection`, () => project((root) => {
    write(root, `src/${excluded}`, "import { worker } from './worker';\nworker.execute();\n");
    const input = semanticInput(request(root, scope(["src/index.ts", "src/worker.ts"])));
    const result = analyzeSemanticQueries(input).results[0];
    assert.equal(result.assertion, "confirmed-no-static-references");
    assert.equal(result.status, "complete");
    assert.equal(result.data.total_reference_count, 0);
    assert.deepEqual(result.evidence, []);
  }));
  test(`excluded evidence cannot displace the eligible witness (${excluded})`, () => project((root) => {
    write(root, `src/${excluded}`, "import { worker } from './worker';\nworker.execute();\n");
    write(root, "src/production.ts", "import { worker } from './worker';\nworker.execute();\n");
    const input = semanticInput(request(root, scope(["src/index.ts", "src/worker.ts", "src/production.ts"])));
    const result = analyzeSemanticQueries(input).results[0];
    assert.equal(result.assertion, "confirmed-used");
    assert.equal(result.data.total_reference_count, 1);
    assert.equal(result.evidence.length, 1);
    assert.equal(result.evidence[0].path, "src/production.ts");
  }));
}

test("excluded string dispatch contributes no dynamic uncertainty", () => project((root) => {
  write(root, "src/helper.ts", "import { worker } from './worker';\nconst name: string = 'execute';\n(worker as any)[name]();\n");
  const result = analyzeSemanticQueries(semanticInput(request(root, scope(["src/index.ts", "src/worker.ts"])))).results[0];
  assert.equal(result.assertion, "confirmed-no-static-references");
  assert.equal(result.status, "complete");
}));

test("wire scope is required and validates graph source identities", () => project((root) => {
  const raw = request(root, scope(["src/index.ts", "src/worker.ts"]));
  const parsed = parseRequest(raw);
  assert.deepEqual(parsed.referenceScope, raw.reference_scope);
  const { reference_scope, ...missing } = raw;
  assert.throws(() => parseRequest(missing), /reference_scope/);
  assert.throws(() => parseRequest({ ...raw, reference_scope: { ...reference_scope, sources: ["../outside.ts"] } }), /within root/);
}));

test("persistent requests recompute evidence when only native scope changes", () => project((root) => {
  write(root, "src/helper.ts", "import { worker } from './worker';\nworker.execute();\n");
  const session = createSemanticSession(root);
  try {
    const first = semanticInput(request(root, scope(["src/index.ts", "src/worker.ts", "src/helper.ts"])));
    const second = semanticInput(request(root, scope(["src/index.ts", "src/worker.ts"])));
    second.referenceScope.fingerprint = "b".repeat(64);
    assert.equal(session.analyze(first, { revision: 1 }).results[0].assertion, "confirmed-used");
    const result = session.analyze(second, { revision: 2 }).results[0];
    assert.equal(result.assertion, "confirmed-no-static-references");
    assert.deepEqual(result, analyzeSemanticQueries(second).results[0]);
  } finally {
    session.close();
  }
}));
