import assert from "node:assert/strict";
import path from "node:path";
import test from "node:test";

import { parseRequest } from "../src/protocol.mjs";
import { runtimeEntryDigest } from "../src/runtime-contracts.mjs";
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
  runtime_entries: [],
  reference_scope: { kind: "compiler-program" },
  queries,
});

test("runtime entry set is required, exact and independent of candidate capacity", () => {
  const entries = Array.from({ length: 25_003 }, (_, index) => ({
    symbol: symbolQuery(index, "class_method").symbol,
    origin: "explicit-member",
  }));
  const input = { ...request([]), runtime_entries: entries };
  const parsed = parseRequest(input);
  assert.equal(parsed.queries.length, 0);
  assert.equal(parsed.runtimeEntries.length, 25_003);
  assert.equal(parsed.runtimeEntries.at(-1).symbol.exportedName, "member25002");
  assert.equal(
    runtimeEntryDigest(parsed.runtimeEntries),
    runtimeEntryDigest(parsed.runtimeEntries.toReversed()),
  );
  const { runtime_entries: omitted, ...missing } = input;
  assert.equal(omitted.length, 25_003);
  assert.throws(() => parseRequest(missing), /runtime_entries must be an array/u);
  assert.throws(
    () => parseRequest({ ...input, runtime_entries: [...entries, entries[0]] }),
    /duplicates a runtime entry/u,
  );
  for (const [change, expected] of [
    [{ origin: "guessed-framework" }, /origin is unsupported/u],
    [{ symbol: { ...entries[0].symbol, namespace: "type" } }, /value namespace/u],
    [{ symbol: { ...entries[0].symbol, path: "../outside.ts" } }, /within root/u],
  ]) {
    assert.throws(
      () => parseRequest({ ...request([]), runtime_entries: [{ ...entries[0], ...change }] }),
      expected,
    );
  }
});

test("runtime entry digest shares the native canonical identity contract", () => {
  const symbol = {
    ...symbolQuery(0, "class_method").symbol,
    path: "src/config.ts",
    exported_name: "run",
    local_name: "run",
    owner: "Worker",
    line: 2,
    col: 2,
  };
  const entries = parseRequest({
    ...request([]),
    runtime_entries: [{ symbol, origin: "explicit-member" }],
  }).runtimeEntries;
  assert.equal(
    runtimeEntryDigest(entries),
    "8c57d04e39dfa197a7a35e781723bcd20b0767ddb4906c22fd2b29e24a34f7a9",
  );
});

test("class symbol-use queries retain every exact identity beyond the nonclass budget", () => {
  const classes = Array.from({ length: 25_003 }, (_, id) =>
    symbolQuery(id, id % 2 === 0 ? "class_method" : "class_property"),
  );
  const exports = Array.from({ length: 24_998 }, (_, index) =>
    symbolQuery(index + classes.length, "export"),
  );
  const parsed = parseRequest(
    request([
      ...classes,
      ...exports,
      { id: 50_001, operation: "api-surface", entry_points: [] },
      { id: 50_002, operation: "type-coupling", entry_points: [] },
    ]),
  );
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
    () =>
      parseRequest(request(Array.from({ length: 25_001 }, (_, id) => symbolQuery(id, "export")))),
    /25000 item limit/,
  );
  for (const operation of ["symbol-trace", "symbol-impact"]) {
    const queries = classes.map((query) => ({ ...query, operation }));
    assert.throws(() => parseRequest(request(queries)), /25000 item limit/);
  }
  for (const operation of ["api-surface", "type-coupling"]) {
    const graphs = Array.from({ length: 257 }, (_, index) => ({
      id: index + classes.length,
      operation,
      entry_points: [],
    }));
    assert.throws(
      () => parseRequest(request([...classes, ...graphs])),
      /graph queries exceed the 256 item limit/,
    );
  }
  const privateLeakCandidates = Array.from({ length: 25_001 }, (_, id) => ({
    id,
    path: "src/service.ts",
    export_name: "Service",
    type_name: `Private${id}`,
  }));
  assert.throws(
    () =>
      parseRequest(
        request([
          ...classes,
          {
            id: classes.length,
            operation: "api-surface",
            private_leak_candidates: privateLeakCandidates,
          },
        ]),
      ),
    /private_leak_candidates exceeds the 25000 item limit/,
  );
});
