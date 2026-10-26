import assert from "node:assert/strict";
import test from "node:test";

import {
  createMutantTypecheckResponse, createSemanticResponse, createStatusResponse,
} from "../src/protocol.mjs";

// A different selected identity makes accidental serialization of an expected constant observable.
const backendIdentity = Object.freeze({ family: "selected-native", version: "qualified-selected-build" });

test("status, semantic and mutant serializers report their selected native identity", () => {
  const status = createStatusResponse(backendIdentity);
  const semantic = createSemanticResponse({
    backendIdentity, selectedTsconfigs: [], referenceScopeCoverage: {}, projectResults: [],
    results: [], phaseTimings: {}, warnings: [], elapsedMs: 0,
  });
  const mutant = createMutantTypecheckResponse({ backendIdentity, results: [], elapsedMs: 0 });
  assert.deepEqual([
    [status.backend_family, status.backend_version],
    [semantic.backend, semantic.backend_version],
    [mutant.backend, mutant.backend_version],
  ], Array.from({ length: 3 }, () => [backendIdentity.family, backendIdentity.version]));
});
