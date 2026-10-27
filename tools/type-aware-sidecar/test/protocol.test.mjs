import assert from "node:assert/strict";
import path from "node:path";
import test from "node:test";

import { parseRequest } from "../src/protocol.mjs";
import { ANALYSIS_OPERATION, WIRE_PROTOCOL_VERSION } from "../src/generated-protocol.mjs";

const symbolQuery = (id, declarationKind) => ({
  id,
  operation: "symbol-use",
  symbol: {
    path: "src/service.ts",
    namespace: "value",
    declaration_kind: declarationKind,
    exported_name: `member${id}`,
    local_name: `member${id}`,
    ...(declarationKind === "export" ? {} : { owner: `Service${id}` }),
    line: id + 1,
    col: 2,
  },
});

const request = (queries) => ({
  protocol_version: WIRE_PROTOCOL_VERSION,
  operation: ANALYSIS_OPERATION,
  root: path.resolve("."),
  projects: [],
  reference_scope: { kind: "compiler-program" },
  queries,
});

test("class symbol-use queries retain every exact identity beyond the nonclass budget", () => {
  const classes = Array.from({ length: 25_003 }, (_, id) =>
    symbolQuery(id, id % 2 === 0 ? "class_method" : "class_property"),
  );
  const exports = Array.from({ length: 24_998 }, (_, index) =>
    symbolQuery(index + classes.length, "export"),
  );
  const parsed = parseRequest(request([
    ...classes,
    ...exports,
    { id: 50_001, operation: "api-surface", entry_points: [] },
    { id: 50_002, operation: "type-coupling", entry_points: [] },
  ]));
  assert.equal(parsed.queries.length, 50_003);
  for (const [index, query] of parsed.queries.entries()) {
    assert.equal(query.id, index);
  }
  for (const [index, query] of parsed.queries.slice(0, classes.length).entries()) {
    assert.deepEqual(query.symbol, {
      path: "src/service.ts",
      absolutePath: path.resolve("src/service.ts"),
      namespace: "value",
      declarationKind: index % 2 === 0 ? "class_method" : "class_property",
      exportedName: `member${index}`,
      localName: `member${index}`,
      owner: `Service${index}`,
      line: index + 1,
      col: 2,
    });
  }
  assert.equal(parsed.queries[50_001].operation, "api-surface");
  assert.equal(parsed.queries[50_002].operation, "type-coupling");
});

test("unbounded class queries preserve validation and independent operation budgets", () => {
  const classes = Array.from({ length: 25_001 }, (_, id) => symbolQuery(id, "class_method"));
  assert.throws(
    () => parseRequest(request([...classes, { ...classes.at(-1) }])),
    /duplicate candidate id 25000/,
  );
  const invalid = [...classes];
  invalid[25_000] = { ...invalid[25_000], symbol: { ...invalid[25_000].symbol, line: 0 } };
  assert.throws(() => parseRequest(request(invalid)), /line/);
  assert.throws(
    () => parseRequest(request(Array.from({ length: 25_001 }, (_, id) => symbolQuery(id, "export")))),
    /25000 item limit/,
  );
  const traces = classes.map((query) => ({ ...query, operation: "symbol-trace" }));
  assert.throws(() => parseRequest(request(traces)), /25000 item limit/);
  const graphs = Array.from({ length: 257 }, (_, index) => ({
    id: index + classes.length,
    operation: "api-surface",
    entry_points: [],
  }));
  assert.throws(() => parseRequest(request([...classes, ...graphs])), /graph queries exceed the 256 item limit/);
});
