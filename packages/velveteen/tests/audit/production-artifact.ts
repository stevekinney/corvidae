import { createHash } from "node:crypto";
import { lstat, realpath, readFile } from "node:fs/promises";
import { basename, isAbsolute, join, relative, resolve } from "node:path";

type RecordValue = Record<string, unknown>;
const record = (value: unknown, label: string): RecordValue => {
  if (!value || typeof value !== "object" || Array.isArray(value))
    throw new Error(`${label} must be an object`);
  return value as RecordValue;
};
const sha256 = (bytes: Uint8Array) =>
  createHash("sha256").update(bytes).digest("hex");
const forbiddenPackages = new Set([
  "vite",
  "vitest",
  "@sveltejs/kit",
  "@sveltejs/vite-plugin-svelte",
  "typescript",
]);
const forbiddenInput = (path: string) => {
  const normalized = "/" + path.replaceAll("\\", "/");
  if (
    normalized.includes("/tests/reference/") ||
    normalized.startsWith("/src/compiler/") ||
    normalized.startsWith("/src/development/") ||
    /\/node_modules\/svelte\/(?:src\/)?compiler\//.test(normalized)
  )
    return true;
  const segments = normalized.split("/node_modules/").at(-1)?.split("/") ?? [];
  const packageName = segments[0]?.startsWith("@")
    ? segments.slice(0, 2).join("/")
    : segments[0];
  return (
    packageName !== undefined &&
    (forbiddenPackages.has(packageName) || packageName.startsWith("@vitest/"))
  );
};

const assertMetadata = (metadata: unknown, label: string) => {
  const value = record(metadata, label);
  const inputs = record(value.inputs, `${label} inputs`);
  const outputs = record(value.outputs, `${label} outputs`);
  if (!Object.keys(inputs).length || !Object.keys(outputs).length)
    throw new Error(`${label} metadata is empty`);
  for (const [input, inputMetadata] of Object.entries(inputs)) {
    if (forbiddenInput(input))
      throw new Error(`forbidden ${label} runtime input`);
    if (
      label === "browser" &&
      (/(?:^|[.+])server\./.test(basename(input)) ||
        (input.split("/").includes("server") &&
          !input.includes("/routes/") &&
          !input.includes("/static/"))) &&
      !input.includes("node_modules/")
    )
      throw new Error(`private browser runtime input: ${input}`);
    const imports = record(inputMetadata, `${label} input metadata`).imports;
    if (Array.isArray(imports))
      for (const imported of imports) {
        const path = record(imported, `${label} import`).path;
        if (typeof path === "string" && forbiddenInput(path))
          throw new Error(`forbidden ${label} runtime import: ${path}`);
      }
  }
};

export async function auditProductionArtifact(evidenceDirectory: string) {
  const root = resolve(evidenceDirectory);
  const artifact = record(
    await Bun.file(join(root, "artifact.json")).json(),
    "artifact evidence",
  );
  if (
    typeof artifact.sourceDirectory !== "string" ||
    !isAbsolute(artifact.sourceDirectory) ||
    typeof artifact.runtimeDirectory !== "string" ||
    !isAbsolute(artifact.runtimeDirectory)
  )
    throw new Error("missing source/runtime identity");
  if (artifact.sourceRemoved !== true)
    throw new Error("production source was not removed");
  const runtimeRelativeToSource = relative(
    artifact.sourceDirectory,
    artifact.runtimeDirectory,
  );
  const runtimeRelativeToWorkspace = relative(
    process.cwd(),
    artifact.runtimeDirectory,
  );
  const outside = (path: string) =>
    isAbsolute(path) || path === ".." || path.startsWith("../");
  if (!outside(runtimeRelativeToSource) || !outside(runtimeRelativeToWorkspace))
    throw new Error("runtime must be outside application source and workspace");
  try {
    await lstat(artifact.sourceDirectory);
    throw new Error("application source still exists");
  } catch (error) {
    if (
      !(error instanceof Error) ||
      !("code" in error) ||
      error.code !== "ENOENT"
    )
      throw error;
  }
  const archive = String(artifact.archive);
  const archiveBytes = await readFile(archive);
  if (sha256(archiveBytes) !== artifact.archiveSha256)
    throw new Error("production archive hash changed");
  const files = await new Bun.Archive(archiveBytes).files();
  if (!Array.isArray(artifact.files))
    throw new Error("archive file evidence is missing");
  const expected = new Map<string, { bytes: number; sha256: string }>();
  for (const item of artifact.files as unknown[]) {
    const entry = record(item, "archive file identity");
    if (
      typeof entry.file !== "string" ||
      typeof entry.bytes !== "number" ||
      typeof entry.sha256 !== "string"
    )
      throw new Error("invalid archive file identity");
    if (expected.has(entry.file))
      throw new Error("duplicate archive file identity");
    expected.set(entry.file, { bytes: entry.bytes, sha256: entry.sha256 });
  }
  const actualNames = [...files.keys()];
  if (
    actualNames.length !== expected.size ||
    actualNames.some((name) => !expected.has(name))
  )
    throw new Error("archive file set differs from evidence");
  for (const [name, blob] of files) {
    const identity = expected.get(name)!;
    const bytes = new Uint8Array(await blob.arrayBuffer());
    if (bytes.length !== identity.bytes || sha256(bytes) !== identity.sha256)
      throw new Error(`archive bytes changed: ${name}`);
  }
  const pointer = record(
    JSON.parse(await files.get("application/current.json")!.text()),
    "generation pointer",
  );
  const generation = pointer.generation;
  if (typeof generation !== "string" || !/^[0-9a-f-]{36}$/.test(generation))
    throw new Error("invalid generation pointer");
  const prefix = `application/generations/${generation}/`;
  const manifestName = `${prefix}manifest.json`;
  const manifest = record(
    JSON.parse(await files.get(manifestName)!.text()),
    "production manifest",
  );
  if (
    JSON.stringify(record(artifact.manifest, "artifact manifest")) !==
    JSON.stringify(manifest)
  )
    throw new Error("artifact manifest differs from archived manifest");
  const outputs = manifest.outputs;
  if (!Array.isArray(outputs) || !outputs.length)
    throw new Error("manifest outputs are missing");
  const outputNames = new Set<string>();
  for (const item of outputs as unknown[]) {
    const output = record(item, "manifest output");
    if (
      typeof output.file !== "string" ||
      output.file.includes("..") ||
      output.file.startsWith("/")
    )
      throw new Error("manifest contains unsafe output path");
    if (outputNames.has(output.file))
      throw new Error(`duplicate manifest output: ${output.file}`);
    outputNames.add(output.file);
    const name = `${prefix}${output.file}`;
    const blob = files.get(name);
    if (!blob)
      throw new Error(`manifest output missing from archive: ${output.file}`);
    const identity = await digestFileFromBlob(blob);
    if (identity.bytes !== output.bytes || identity.sha256 !== output.sha256)
      throw new Error(`manifest output bytes changed: ${output.file}`);
  }
  const expectedArchive = new Set([
    "host.js",
    "application/current.json",
    manifestName,
    ...[...outputNames].map((file) => `${prefix}${file}`),
  ]);
  if (
    actualNames.some((name) => !expectedArchive.has(name)) ||
    expectedArchive.size !== actualNames.length
  )
    throw new Error("archive contains unmanifested files");
  const metadata = record(artifact.metadata, "build metadata");
  assertMetadata(metadata.browser, "browser");
  assertMetadata(metadata.server, "server");
  assertMetadata(metadata.host, "host");
  const hostOutputs = Object.keys(
    record(record(metadata.host, "host").outputs, "host outputs"),
  );
  if (
    typeof artifact.hostOutput !== "string" ||
    hostOutputs.length !== 1 ||
    hostOutputs[0].replace(/^\.\//, "") !== artifact.hostOutput
  )
    throw new Error("host metadata output is not recorded");
  const hostMetadata = record(
    record(record(metadata.host, "host").outputs, "host outputs")[
      hostOutputs[0]
    ],
    "host output",
  );
  if (hostMetadata.bytes !== files.get("host.js")?.size)
    throw new Error("host metadata byte count differs from archive");
  for (const [label, value] of [
    ["browser", metadata.browser],
    ["server", metadata.server],
  ] as const) {
    const outputsMetadata = record(
      record(value, label).outputs,
      `${label} outputs`,
    );
    for (const output of Object.keys(outputsMetadata)) {
      if (output.endsWith(".map"))
        throw new Error(`${label} metadata contains source map output`);
      const normalized = output.replace(/^\.\//, "");
      if (!outputNames.has(`${label}/${normalized}`))
        throw new Error(
          `${label} metadata output missing from archive: ${output}`,
        );
    }
  }
  for (const [name, blob] of files) {
    if ((await blob.text()).includes(artifact.sourceDirectory))
      throw new Error(`source directory leaked into runtime output: ${name}`);
  }
  const browserBytes = [...files].filter(([name]) =>
    name.startsWith(`${prefix}browser/`),
  );
  for (const [name, blob] of browserBytes) {
    const text = await blob.text();
    if (
      text.includes("PRIVATE_BROWSER_SENTINEL") ||
      text.includes("PRODUCTION_PRIVATE_SENTINEL") ||
      text.includes("PRODUCTION_DEV_SENTINEL") ||
      text.includes("sourceMappingURL") ||
      name.endsWith(".map")
    )
      throw new Error(`private/development browser content: ${name}`);
    if (text.includes(String(artifact.sourceDirectory)))
      throw new Error(`source directory leaked into browser output: ${name}`);
  }
  const browserEvidence = record(
    await Bun.file(join(root, "browser.json")).json(),
    "browser evidence",
  );
  if (!Array.isArray(browserEvidence.errors) || browserEvidence.errors.length)
    throw new Error("browser evidence contains errors");
  if (browserEvidence.hydrationRecovery !== false)
    throw new Error("browser evidence contains hydration recovery");
  if (browserEvidence.backgroundWidth !== 8)
    throw new Error("browser evidence did not decode the background asset");
  const processEvidence = record(
    await Bun.file(join(root, "process.json")).json(),
    "process evidence",
  );
  const command = processEvidence.command;
  if (!Array.isArray(command) || command.length < 3)
    throw new Error("process command is missing");
  if (
    basename(String(command[0])) !== "bun" ||
    !command.includes("--no-install")
  )
    throw new Error("production process must use Bun --no-install");
  const executable = await realpath(String(command[0]));
  if (executable !== (await realpath(process.execPath)))
    throw new Error("production process executable is not Bun");
  if (
    artifact.bun !== Bun.version ||
    processEvidence.bun !== artifact.bun ||
    processEvidence.exitCode !== 0 ||
    typeof processEvidence.pid !== "number" ||
    processEvidence.pid <= 0 ||
    processEvidence.status !== "completed" ||
    typeof processEvidence.startedAt !== "string" ||
    typeof processEvidence.finishedAt !== "string" ||
    !Number.isFinite(Date.parse(processEvidence.startedAt)) ||
    !Number.isFinite(Date.parse(processEvidence.finishedAt)) ||
    Date.parse(processEvidence.finishedAt) <
      Date.parse(processEvidence.startedAt)
  )
    throw new Error("production process did not complete successfully");
  const runtimeDirectory = String(artifact.runtimeDirectory);
  if (
    processEvidence.cwd !== runtimeDirectory ||
    processEvidence.path !== join(runtimeDirectory, "bin")
  )
    throw new Error("production process PATH is not Bun-only");
  if (
    JSON.stringify(command) !==
    JSON.stringify([
      command[0],
      "--no-install",
      "--no-env-file",
      join(runtimeDirectory, "host.js"),
    ])
  )
    throw new Error("production process did not invoke the archived host");
  if (!Array.isArray(processEvidence.pathEntries))
    throw new Error("production process PATH entries are missing");
  {
    if (processEvidence.pathEntries.length !== 1)
      throw new Error("production process PATH entries are not Bun-only");
    const pathEntry = record(
      processEvidence.pathEntries[0],
      "process PATH entry",
    );
    if (pathEntry.name !== "bun" || pathEntry.executable !== executable)
      throw new Error("production process PATH entries are not Bun-only");
  }
  const stdout = await readFile(join(root, "stdout.log"), "utf8");
  const stderr = await readFile(join(root, "stderr.log"), "utf8");
  if (processEvidence.stdout !== stdout || processEvidence.stderr !== stderr)
    throw new Error("process logs differ from recorded evidence");
  if (stderr !== "") throw new Error("production process wrote stderr");
  const readiness = stdout
    .split("\n")
    .filter(Boolean)
    .map((line) => JSON.parse(line) as RecordValue)
    .find(
      (value) =>
        value.pid === processEvidence.pid &&
        value.bun === processEvidence.bun &&
        typeof value.url === "string",
    );
  if (!readiness)
    throw new Error("production process has no matching readiness record");
  return {
    archiveSha256: artifact.archiveSha256,
    files: actualNames.length,
    outputs: outputNames.size,
  };
}

async function digestFileFromBlob(blob: Blob) {
  const bytes = new Uint8Array(await blob.arrayBuffer());
  return { bytes: bytes.length, sha256: sha256(bytes) };
}
