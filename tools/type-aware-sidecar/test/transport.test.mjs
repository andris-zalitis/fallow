import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { Readable } from "node:stream";
import test from "node:test";

import { run } from "../src/cli.mjs";
import {
  ANALYSIS_OPERATION,
  STATUS_OPERATION,
  WIRE_PROTOCOL_VERSION,
} from "../src/generated-protocol.mjs";

const formerLimit = 8 * 1024 * 1024;
const padding = " ".repeat(formerLimit + 1);
const semanticRequest = (root) => ({
  protocol_version: WIRE_PROTOCOL_VERSION,
  runtime_entries: [],
  reference_scope: { kind: "compiler-program" },
  operation: ANALYSIS_OPERATION,
  root,
  projects: [],
  evidence_limit: 1,
  queries: [],
});

for (const persistent of [false, true]) {
  test(`${persistent ? "persistent" : "one-shot"} semantic input exceeds the former byte limit`, async () => {
    const root = mkdtempSync(path.join(tmpdir(), "fallow-semantic-transport-"));
    try {
      const request = semanticRequest(root);
      const envelope = persistent
        ? { type: "analyze", request_id: 7, revision: 1, request }
        : request;
      const encoded = JSON.stringify(envelope) + padding + "\n";
      assert.ok(Buffer.byteLength(encoded) > formerLimit);
      let stdout = "";
      await run({
        input: Readable.from([
          encoded,
          ...(persistent ? [JSON.stringify({ type: "shutdown" }) + "\n"] : []),
        ]),
        output: { write: (chunk) => (stdout += chunk) },
        args: persistent ? ["--session"] : [],
      });
      const messages = stdout.trim().split("\n").map(JSON.parse);
      assert.equal(messages.length, 1);
      const response = persistent ? messages[0].response : messages[0];
      if (persistent) {
        assert.equal(messages[0].request_id, 7);
        assert.equal(messages[0].revision, 1);
      }
      assert.equal(response.protocol_version, WIRE_PROTOCOL_VERSION);
      assert.equal(response.operation, ANALYSIS_OPERATION);
      assert.deepEqual(response.results, []);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });
}

test("one-shot status input retains its byte policy", async () => {
  const request = { protocol_version: WIRE_PROTOCOL_VERSION, operation: STATUS_OPERATION };
  let stdout = "";
  await assert.rejects(
    run({
      input: Readable.from([JSON.stringify(request) + padding]),
      output: { write: (chunk) => (stdout += chunk) },
    }),
    /stdin exceeded the 8388608 byte request limit/,
  );
  assert.equal(stdout, "");
});
