import { generateKeyPairSync, sign } from "node:crypto";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";

import { artifactDigest } from "../src/backend-artifact.mjs";
import { TYPE_AWARE_PROTOCOL } from "../src/generated-protocol.mjs";

export const backendFixture = (t) => {
  const root = mkdtempSync(path.join(tmpdir(), "fallow-backend-fixture-"));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const { publicKey, privateKey } = generateKeyPairSync("ed25519");
  const bytes = Buffer.from("fixture executable");
  writeFileSync(path.join(root, "tsgo"), bytes);
  writeFileSync(path.join(root, "NOTICE.txt"), "fixture notice");
  const manifestPath = path.join(root, "backend.json");
  const manifest = {
    schema_version: 1, backend: structuredClone(TYPE_AWARE_PROTOCOL.backend),
    target: `${process.platform}-${process.arch}`,
    executable: { path: "tsgo", sha256: artifactDigest(bytes) }, notices: [{ path: "NOTICE.txt", sha256: artifactDigest(Buffer.from("fixture notice")) }],
    provenance: { go_version: TYPE_AWARE_PROTOCOL.backend.build.go_version },
  };
  const save = () => {
    const encoded = Buffer.from(JSON.stringify(manifest) + "\n");
    writeFileSync(manifestPath, encoded);
    writeFileSync(`${manifestPath}.sig`, sign(null, encoded, privateKey));
  };
  save();
  return { root, manifest, manifestPath, publicKey, save };
};
