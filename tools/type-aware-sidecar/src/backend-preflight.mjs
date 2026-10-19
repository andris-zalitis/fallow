import { spawnSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { createRequire } from "node:module";
import path from "node:path";

import { TYPE_AWARE_PROTOCOL } from "./generated-protocol.mjs";
import { verifyBackendArtifact } from "./backend-artifact.mjs";

const BACKEND = TYPE_AWARE_PROTOCOL.backend;
const INSTALL_HINT = "run `npm ci` in tools/type-aware-sidecar for its exact typescript client";

/** Select only the signed, source-qualified backend supplied by the package owner. */
export const assertTypescriptBackendResolvable = (
  resolveFrom = import.meta.url,
  {
    manifestPath = process.env.FALLOW_TYPESCRIPT_BACKEND_MANIFEST,
    publicKey,
    target = `${process.platform}-${process.arch}`,
    executeVersion = (executable) => spawnSync(executable, ["--version"], { encoding: "utf8" }),
  } = {},
) => {
  const require = createRequire(resolveFrom);
  let manifest;
  try {
    manifest = require.resolve("typescript/package.json");
  } catch (cause) {
    throw new Error(`typescript is not installed; ${INSTALL_HINT}`, { cause });
  }
  const { version } = require(manifest);
  if (version !== BACKEND.client_version) {
    throw new Error(
      `resolved typescript ${version} from ${path.dirname(manifest)}; ` +
      `fallow-type-aware needs client ${BACKEND.client_version}; ${INSTALL_HINT}`,
    );
  }
  if (!manifestPath) {
    throw new Error("FALLOW_TYPESCRIPT_BACKEND_MANIFEST must select the signed native backend");
  }
  const targets = createRequire(import.meta.url)("./fork-artifact-targets.json");
  if (!(target in targets)) throw new Error(`unsupported native backend target ${target}`);
  const selected = verifyBackendArtifact(manifestPath, {
    backend: BACKEND,
    target,
    publicKey: publicKey ?? readFileSync(new URL(BACKEND.trust_root, import.meta.url)),
  });
  const result = executeVersion(selected.path);
  if (result.error) throw result.error;
  if (result.status !== 0 || result.stdout.trim() !== `Version ${selected.version}`) {
    throw new Error(`selected native backend did not report Version ${selected.version}`);
  }
  return selected;
};

let selectedBackend;

/** A process/session consumes one immutable payload, including its verified identity. */
export const getSelectedBackend = () => selectedBackend ??= assertTypescriptBackendResolvable();
