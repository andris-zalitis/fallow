import { createHash, verify } from "node:crypto";
import { readFileSync } from "node:fs";
import path from "node:path";
import { isDeepStrictEqual } from "node:util";

export const artifactDigest = (bytes) => createHash("sha256").update(bytes).digest("hex");

/** The signed payload contract shared by staging, selection and release packaging. */
export const verifyBackendArtifact = (manifestPath, { backend, target, publicKey }) => {
  const bytes = readFileSync(manifestPath);
  const signature = readFileSync(`${manifestPath}.sig`);
  if (!verify(null, bytes, publicKey, signature)) {
    throw new Error("native backend manifest signature is invalid");
  }
  const manifest = JSON.parse(bytes.toString("utf8"));
  if (manifest.schema_version !== 1 || !isDeepStrictEqual(manifest.backend, backend)) {
    throw new Error("native backend manifest does not match the required client/native/source identity");
  }
  if (manifest.target !== target) {
    throw new Error(`native backend target ${manifest.target} does not match ${target}`);
  }
  const directory = path.dirname(path.resolve(manifestPath));
  for (const payload of [manifest.executable, ...manifest.notices]) {
    const actual = artifactDigest(readFileSync(path.resolve(directory, payload.path)));
    if (actual !== payload.sha256) {
      throw new Error(`native backend payload digest mismatch: ${payload.path}`);
    }
  }
  return Object.freeze({
    family: manifest.backend.family,
    version: manifest.backend.version,
    clientVersion: manifest.backend.client_version,
    source: Object.freeze({ ...manifest.backend.source }),
    target: manifest.target,
    path: path.resolve(directory, manifest.executable.path),
  });
};
