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
  sources: sources.toSorted(),
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
const semanticInput = (raw) => parseRequest(raw);

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

test("eligible JS and MJS callers share declaration identity across compiler projects", () => project((root) => {
  for (const [directory, file] of [["client", "consumer.js"], ["dev", "tool.mjs"]]) {
    write(root, `${directory}/tsconfig.json`, JSON.stringify({ compilerOptions: { strict: true, noEmit: true, allowJs: true, checkJs: true }, include: [file] }));
    write(root, `${directory}/${file}`, "import { worker } from '../src/worker.js';\nworker.execute();\n");
  }
  const raw = request(root, scope(["src/index.ts", "src/worker.ts", "client/consumer.js", "dev/tool.mjs"]));
  raw.projects.push("client/tsconfig.json", "dev/tsconfig.json");
  const response = analyzeSemanticQueries(parseRequest(raw));
  assert.equal(response.results[0].assertion, "confirmed-used");
  assert.equal(response.results[0].data.total_reference_count, 2);
  assert.equal(response.sourceScanCount, 4);
  assert.equal(response.referenceScopeCoverage.fingerprint, raw.reference_scope.fingerprint);
  assert.equal(response.referenceScopeCoverage.source_count, 4);
  assert.equal(response.referenceScopeCoverage.candidate_count, 1);
  assert.deepEqual(response.referenceScopeCoverage.owning_projects, ["client/tsconfig.json", "dev/tsconfig.json", "tsconfig.json"]);
}));

test("scope sources without a complete compiler owner fail the requested analysis", () => project((root) => {
  const raw = request(root, scope(["src/index.ts", "src/worker.ts", "src/missing.ts"]));
  assert.throws(() => analyzeSemanticQueries(parseRequest(raw)), /no complete owning compiler project/);
}));

test("eligible re-export and type syntax do not manufacture a member invocation", () => project((root) => {
  write(root, "src/barrel.ts", "export { Worker } from './worker';\nimport type { Worker } from './worker';\nexport type Port = Pick<Worker, 'execute'>;\n");
  const response = analyzeSemanticQueries(parseRequest(request(root, scope(["src/index.ts", "src/worker.ts", "src/barrel.ts"]))));
  assert.equal(response.results[0].assertion, "confirmed-no-static-references", JSON.stringify(response.results[0]));
  assert.equal(response.results[0].data.total_reference_count, 0);
}));


test("unconfigured TypeScript sources attest their inferred compiler owner", () => {
  const root = mkdtempSync(path.join(tmpdir(), "fallow-inferred-scope-"));
  try {
    write(root, "package.json", '{"name":"inferred-scope","private":true,"main":"src/index.ts"}');
    write(root, "src/index.ts", "export { make } from './lib';\n");
    write(root, "src/lib.ts", "interface Internal { value: number }\nexport function make(): Internal { return { value: 1 }; }\n");
    const raw = { ...request(root, scope(["src/index.ts", "src/lib.ts"])), projects: [], queries: [] };
    const input = parseRequest(raw);
    const single = analyzeSemanticQueries(input);
    assert.equal(single.referenceScopeCoverage.source_count, 2);
    assert.equal(single.referenceScopeCoverage.candidate_count, 0);
    assert.deepEqual(single.referenceScopeCoverage.owning_projects, ["<inferred>"]);
    const session = createSemanticSession(root);
    try {
      assert.deepEqual(session.analyze(input, { revision: 1 }).referenceScopeCoverage, single.referenceScopeCoverage);
    } finally {
      session.close();
    }
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});
