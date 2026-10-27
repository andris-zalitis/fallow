import { execFileSync } from "node:child_process";
import { sign } from "node:crypto";
import {
  copyFileSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  renameSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { parseArgs } from "node:util";

import {
  artifactDigest,
  verifyBackendArtifact,
} from "../tools/type-aware-sidecar/src/backend-artifact.mjs";

const REPO_ROOT = path.dirname(path.dirname(fileURLToPath(import.meta.url)));
const readJson = (file) => JSON.parse(readFileSync(file, "utf8"));
const command = (args, cwd, env = process.env) =>
  execFileSync(args[0], args.slice(1), {
    cwd,
    env,
    encoding: "utf8",
    stdio: ["ignore", "pipe", "inherit"],
  }).trim();

export const backendInputs = (repoRoot = REPO_ROOT) => ({
  backend: readJson(path.join(repoRoot, "crates/api/type-aware-protocol.json")).backend,
  targets: readJson(path.join(repoRoot, "tools/type-aware-sidecar/src/fork-artifact-targets.json")),
});

export const reconstructBackend = (
  destination,
  { repoRoot = REPO_ROOT, execute = command } = {},
) => {
  const { backend } = backendInputs(repoRoot);
  const source = backend.source;
  mkdirSync(destination);
  for (const args of [
    ["git", "init", "--quiet"],
    ["git", "remote", "add", "origin", source.repository],
    ["git", "fetch", "--quiet", "--depth=1", "origin", source.base_revision],
    ["git", "sparse-checkout", "init", "--no-cone"],
    ["git", "sparse-checkout", "add", "/internal/", "/cmd/"],
    ["git", "checkout", "--quiet", "--detach", "FETCH_HEAD"],
    ["git", "apply", "--unidiff-zero", "--index", path.join(repoRoot, source.delta_path)],
  ])
    execute(args, destination);
  const tree = execute(["git", "write-tree"], destination);
  if (tree !== source.tree) {
    throw new Error(`reconstructed backend tree ${tree} does not match ${source.tree}`);
  }
  return backend;
};

export const backendBuildArgs = (go, executable, backend) => [
  go,
  "build",
  "-mod=readonly",
  "-trimpath",
  "-buildvcs=false",
  "-ldflags",
  `-X github.com/microsoft/typescript-go/internal/core.version=${backend.version} -buildid=`,
  "-o",
  executable,
  "./cmd/tsgo",
];

/** The backend stage of the fork writer; U5 adds the other payloads to this owner. */
export const buildBackendPayloads = ({
  output,
  go,
  targets: requestedTargets,
  signingKey,
  signatures,
  prepareSigning = false,
  repoRoot = REPO_ROOT,
}) => {
  if (!prepareSigning && Boolean(signingKey) === Boolean(signatures)) {
    throw new Error(
      "build-backend requires exactly one signing key or offline signature directory",
    );
  }
  const { backend, targets } = backendInputs(repoRoot);
  const version = command([go, "env", "GOVERSION"], repoRoot, {
    ...process.env,
    GOTOOLCHAIN: "local",
  });
  if (version !== backend.build.go_version) {
    throw new Error(`backend requires ${backend.build.go_version}, resolved ${version}`);
  }
  if (backend.build.library_mode !== "embedded")
    throw new Error("backend build requires embedded libraries");
  const root = mkdtempSync(path.join(tmpdir(), "fallow-fork-backend-"));
  try {
    const source = path.join(root, "source");
    reconstructBackend(source, { repoRoot });
    const receipts = [];
    for (const target of requestedTargets) {
      const mapping = targets[target];
      if (!mapping) throw new Error(`unsupported fork target ${target}`);
      const staging = path.join(root, target);
      mkdirSync(staging);
      const executable = path.join(staging, "tsgo");
      const args = backendBuildArgs(go, executable, backend);
      const env = {
        ...process.env,
        GOOS: mapping.goos,
        GOARCH: mapping.goarch,
        CGO_ENABLED: "0",
        GOTOOLCHAIN: "local",
        GOWORK: "off",
        GOFLAGS: "-modcacherw",
      };
      command(args, source, env);
      const hostTarget = `${process.platform}-${process.arch}`;
      if (target === hostTarget) {
        const actual = command([executable, "--version"], source);
        if (actual !== `Version ${backend.version}`) {
          throw new Error(`built backend reports ${actual}, expected Version ${backend.version}`);
        }
      }
      const payload = (file) => ({
        path: file,
        sha256: artifactDigest(readFileSync(path.join(staging, file))),
      });
      for (const file of ["LICENSE", "NOTICE.txt"])
        copyFileSync(path.join(source, file), path.join(staging, file));
      const manifest = {
        schema_version: 1,
        backend,
        target,
        executable: payload("tsgo"),
        notices: ["LICENSE", "NOTICE.txt"].map(payload),
        provenance: { go_version: version, build_flags: args.slice(2, 7) },
      };
      const bytes = Buffer.from(JSON.stringify(manifest, null, 2) + "\n");
      const digest = artifactDigest(bytes);
      const manifestPath = path.join(staging, "backend.json");
      writeFileSync(manifestPath, bytes);
      if (!prepareSigning) {
        const signature = signingKey
          ? sign(null, bytes, readFileSync(signingKey))
          : readFileSync(path.join(signatures, `${target}-${digest}.sig`));
        writeFileSync(`${manifestPath}.sig`, signature);
        verifyBackendArtifact(manifestPath, {
          backend,
          target,
          publicKey: readFileSync(
            path.join(repoRoot, "tools/type-aware-sidecar/src", backend.trust_root),
          ),
        });
      }
      const parent = path.join(output, target);
      mkdirSync(parent, { recursive: true });
      const completed = path.join(parent, digest);
      renameSync(staging, completed);
      receipts.push({
        target,
        manifestPath: path.join(completed, "backend.json"),
        manifestSha256: digest,
        signed: !prepareSigning,
        versionExecuted: target === hostTarget,
      });
    }
    return receipts;
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
};

const main = () => {
  const { values, positionals } = parseArgs({
    allowPositionals: true,
    options: {
      out: { type: "string" },
      go: { type: "string" },
      target: { type: "string" },
      "signing-key": { type: "string" },
      signatures: { type: "string" },
    },
  });
  const [operation] = positionals;
  if (!["prepare-backend", "build-backend"].includes(operation) || !values.out || !values.go) {
    throw new Error(
      "usage: fork-artifacts.mjs <prepare-backend|build-backend> --out <dir> --go <go> --target <target|all> [--signatures <dir>|--signing-key <key>]",
    );
  }
  const { targets } = backendInputs();
  const requested = values.target === "all" ? Object.keys(targets) : [values.target];
  console.log(
    JSON.stringify(
      buildBackendPayloads({
        output: path.resolve(values.out),
        go: path.resolve(values.go),
        targets: requested,
        signingKey: values["signing-key"],
        signatures: values.signatures,
        prepareSigning: operation === "prepare-backend",
      }),
      null,
      2,
    ),
  );
};

if (process.argv[1] && import.meta.url === pathToFileURL(path.resolve(process.argv[1])).href)
  main();
