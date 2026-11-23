import { existsSync, realpathSync } from "node:fs";
import { dirname, isAbsolute, join, relative, resolve } from "node:path";

type JsonRecord = Record<string, unknown>;

export function record(value: unknown, label: string): JsonRecord {
  if (!value || typeof value !== "object" || Array.isArray(value))
    throw new Error(`${label} must be an object`);
  return value as JsonRecord;
}

export function strings(value: unknown, label: string): Record<string, string> {
  const result = record(value ?? {}, label);
  for (const entry of Object.values(result))
    if (typeof entry !== "string")
      throw new Error(`${label} must contain strings`);
  return result as Record<string, string>;
}

export function forbiddenPackage(name: string): boolean {
  return (
    [
      "vite",
      "vitest",
      "@sveltejs/kit",
      "@sveltejs/vite-plugin-svelte",
      "node",
    ].includes(name) || name.startsWith("@vitest/")
  );
}

export async function manifest(path: string): Promise<JsonRecord> {
  return record(await Bun.file(path).json(), path);
}

function resolveManifest(name: string, from: string): string | undefined {
  for (let directory = from; ; directory = dirname(directory)) {
    const candidate = join(directory, "node_modules", name, "package.json");
    if (existsSync(candidate)) return realpathSync(candidate);
    if (directory === dirname(directory)) return;
  }
}

/** Inspect installed runtime, development and peer edges, including nested installations and aliases. */
export async function auditDependencyClosure(
  root: string,
  lockfileRoot = root,
): Promise<{ identities: string[]; packageDirectories: string[] }> {
  const visited = new Set<string>();
  const identities: string[] = [];
  async function visit(path: string, includeDevelopment: boolean) {
    const resolved = realpathSync(path);
    if (visited.has(resolved)) return;
    visited.add(resolved);
    const packageManifest = await manifest(resolved);
    const name = packageManifest.name;
    if (typeof name !== "string")
      throw new Error(`missing package name: ${path}`);
    if (forbiddenPackage(name))
      throw new Error(`forbidden dependency: ${name}`);
    if (!includeDevelopment) {
      const version = packageManifest.version;
      const identity = dirname(resolved).includes("/node_modules/")
        ? `${name}@${String(version)}`
        : `${name}@workspace:${relative(lockfileRoot, dirname(resolved))}`;
      identities.push(identity);
    }
    const dependencies = strings(
      packageManifest.dependencies,
      `${name} dependencies`,
    );
    const development = includeDevelopment
      ? strings(
          packageManifest.devDependencies,
          `${name} development dependencies`,
        )
      : {};
    const optional = strings(
      packageManifest.optionalDependencies,
      `${name} optional dependencies`,
    );
    const peers = strings(
      packageManifest.peerDependencies,
      `${name} peer dependencies`,
    );
    const peerMetadata = record(
      packageManifest.peerDependenciesMeta ?? {},
      `${name} peer metadata`,
    );
    for (const dependency of new Set([
      ...Object.keys(dependencies),
      ...Object.keys(development),
      ...Object.keys(optional),
      ...Object.keys(peers),
    ])) {
      const candidate = resolveManifest(dependency, dirname(resolved));
      if (!candidate) {
        const optionalPeer =
          peerMetadata[dependency] &&
          record(peerMetadata[dependency], "peer metadata").optional === true;
        if (Object.hasOwn(optional, dependency) || optionalPeer) continue;
        throw new Error(`unresolved dependency edge: ${name} -> ${dependency}`);
      }
      if (forbiddenPackage(dependency))
        throw new Error(`forbidden dependency edge: ${name} -> ${dependency}`);
      await visit(candidate, false);
    }
  }
  await visit(join(root, "package.json"), true);
  if (identities.length === 0) throw new Error("dependency closure is empty");
  const packageDirectories = [...visited]
    .filter((path) => path !== realpathSync(join(root, "package.json")))
    .map(dirname);
  return { identities: identities.sort(), packageDirectories };
}

/** Check root pins and installed identities against the frozen package lock. */
export async function auditLockfile(
  root: string,
  identities: string[],
  lockfileRoot: string,
): Promise<void> {
  const lock = record(
    Bun.JSONC.parse(await Bun.file(join(lockfileRoot, "bun.lock")).text()),
    "lockfile",
  );
  const workspace = record(
    record(lock.workspaces, "lockfile workspaces")[
      relative(lockfileRoot, root)
    ],
    "Velveteen workspace",
  );
  const packageManifest = await manifest(join(root, "package.json"));
  for (const field of ["dependencies", "devDependencies"] as const) {
    const expected = Object.entries(
      strings(packageManifest[field], field),
    ).sort();
    const actual = Object.entries(
      strings(workspace[field], `locked ${field}`),
    ).sort();
    if (JSON.stringify(expected) !== JSON.stringify(actual))
      throw new Error(`lockfile ${field} differ from package manifest`);
  }
  const packages = record(lock.packages, "locked packages");
  const lockedIdentities = new Set(
    Object.values(packages).map((value) => {
      if (!Array.isArray(value) || typeof value[0] !== "string")
        throw new Error("invalid lockfile package entry");
      return value[0];
    }),
  );
  for (const identity of identities)
    if (!lockedIdentities.has(identity))
      throw new Error(`installed identity absent from lockfile: ${identity}`);
}

function inputPackage(path: string): string | undefined {
  const suffix = path.replaceAll("\\", "/").split("/node_modules/").at(-1);
  if (!suffix || suffix === path) return;
  const segments = suffix.split("/");
  return segments[0]?.startsWith("@")
    ? segments.slice(0, 2).join("/")
    : segments[0];
}

function contained(root: string, path: string): boolean {
  const local = relative(realpathSync(root), realpathSync(path));
  return local !== ".." && !local.startsWith("../") && !isAbsolute(local);
}

async function verifyFile(value: unknown, root: string): Promise<string> {
  const file = record(value, "file evidence");
  if (
    typeof file.path !== "string" ||
    !isAbsolute(file.path) ||
    typeof file.sha256 !== "string"
  )
    throw new Error("invalid file evidence");
  if (!contained(root, file.path))
    throw new Error(`evidence path escapes root: ${file.path}`);
  const digest = new Bun.CryptoHasher("sha256")
    .update(await Bun.file(file.path).arrayBuffer())
    .digest("hex");
  if (digest !== file.sha256)
    throw new Error(`output bytes changed: ${file.path}`);
  return file.path;
}

/** Inspect actual bundler inputs and verify the bytes of emitted candidate outputs. */
export async function auditBuildEvidence(
  value: unknown,
  packageDirectories: readonly string[] = [],
): Promise<void> {
  const evidence = record(value, "build evidence");
  if (
    evidence.schemaVersion !== 1 ||
    typeof evidence.root !== "string" ||
    !isAbsolute(evidence.root)
  )
    throw new Error("invalid build evidence identity");
  if (!Array.isArray(evidence.builds) || evidence.builds.length === 0)
    throw new Error("missing candidate builds");
  const targets = new Set<string>();
  for (const candidate of evidence.builds) {
    const build = record(candidate, "candidate build");
    if (build.target !== "browser" && build.target !== "bun")
      throw new Error("invalid candidate build target");
    targets.add(build.target);
    if (
      typeof build.inputRoot !== "string" ||
      typeof build.outputDirectory !== "string" ||
      !contained(evidence.root, build.inputRoot) ||
      !contained(evidence.root, build.outputDirectory)
    )
      throw new Error("build directories escape root");
    const metafile = record(build.metafile, "Bun metafile");
    const inputs = record(metafile.inputs, "metafile inputs");
    if (Object.keys(inputs).length === 0)
      throw new Error("empty emitted module provenance");
    for (const [input, metadata] of Object.entries(inputs)) {
      if (
        input.includes("tests/reference/") ||
        input.includes("tests\\reference\\")
      )
        throw new Error(`reference input in candidate output: ${input}`);
      const packageName = inputPackage(`/${input}`);
      if (packageName && forbiddenPackage(packageName))
        throw new Error(`forbidden emitted input: ${input}`);
      const source = input.endsWith(".svelte.velveteen.css")
        ? resolve(build.inputRoot, input.slice(0, -".velveteen.css".length))
        : resolve(build.inputRoot, input);
      if (
        !contained(evidence.root, source) &&
        !packageDirectories.some((directory) => contained(directory, source))
      )
        throw new Error(`build input escapes root: ${input}`);
      const imports = record(metadata, "input metadata").imports;
      if (Array.isArray(imports))
        for (const imported of imports) {
          const item = record(imported, "metafile import");
          if (typeof item.path === "string" && forbiddenPackage(item.path))
            throw new Error(`forbidden external import: ${item.path}`);
        }
    }
    if (!Array.isArray(build.outputs) || build.outputs.length === 0)
      throw new Error("missing candidate outputs");
    const declaredOutputs = new Set(
      Object.keys(record(metafile.outputs, "metafile outputs")).map((path) =>
        resolve(build.outputDirectory as string, path),
      ),
    );
    const observedOutputs = new Set<string>();
    for (const candidateOutput of build.outputs) {
      const output = record(candidateOutput, "build output");
      if (
        typeof output.path !== "string" ||
        !isAbsolute(output.path) ||
        typeof output.sha256 !== "string"
      )
        throw new Error("invalid output identity");
      await verifyFile(output, build.outputDirectory);
      if (
        !declaredOutputs.has(output.path) &&
        !(
          output.path.endsWith(".map") &&
          declaredOutputs.has(output.path.slice(0, -4))
        )
      )
        throw new Error(`output absent from metafile: ${output.path}`);
      observedOutputs.add(output.path);
    }
    for (const path of declaredOutputs)
      if (!observedOutputs.has(path))
        throw new Error(`metafile output was not recorded: ${path}`);
  }
  if (!targets.has("browser") || !targets.has("bun"))
    throw new Error("both browser and server provenance are required");
}

/** Check recorded executable identities, not a string search of package scripts. */
export async function auditCommands(
  records: unknown[],
  root = process.cwd(),
): Promise<void> {
  const modes = new Set<string>();
  for (const candidate of records) {
    const command = record(candidate, "command record");
    if (command.boundary === "reference") continue;
    if (command.boundary !== "candidate")
      throw new Error("unknown command boundary");
    if (
      !Array.isArray(command.command) ||
      command.command.length === 0 ||
      command.command.some((value) => typeof value !== "string")
    )
      throw new Error("invalid recorded command");
    const executable: string = command.command[0];
    const actual = isAbsolute(executable) ? executable : Bun.which(executable);
    if (!actual || realpathSync(actual) !== realpathSync(process.execPath))
      throw new Error(`candidate command must use Bun: ${executable}`);
    if (typeof command.cwd !== "string" || !isAbsolute(command.cwd))
      throw new Error("command working directory is missing");
    if (!contained(root, command.cwd))
      throw new Error("command working directory escapes root");
    if (
      command.status !== "completed" ||
      command.exitCode !== 0 ||
      typeof command.pid !== "number" ||
      command.pid <= 0 ||
      command.bun !== Bun.version
    )
      throw new Error("command has no successful completed execution");
    if (
      typeof command.startedAt !== "string" ||
      typeof command.finishedAt !== "string" ||
      !Number.isFinite(Date.parse(command.startedAt)) ||
      !Number.isFinite(Date.parse(command.finishedAt)) ||
      Date.parse(command.finishedAt) < Date.parse(command.startedAt)
    )
      throw new Error("command execution timestamps are invalid");
    const entry = await verifyFile(command.entry, root);
    const invoked = command.command
      .slice(1)
      .filter((argument: string) => !argument.startsWith("-"))
      .map((argument: string) => resolve(command.cwd as string, argument));
    if (!invoked.includes(entry))
      throw new Error("recorded entry was not invoked");
    const stdout = await verifyFile(command.stdout, root);
    await verifyFile(command.stderr, root);
    const readiness = (await Bun.file(stdout).text())
      .split("\n")
      .filter((line) => line.startsWith("{"))
      .some((line) => {
        const value = record(JSON.parse(line), "readiness record");
        return (
          value.pid === command.pid &&
          value.bun === command.bun &&
          typeof value.url === "string"
        );
      });
    if (!readiness)
      throw new Error("command log has no matching readiness identity");
    if (command.mode === "production") await verifyFile(command.artifact, root);
    if (command.mode === "development" || command.mode === "production")
      modes.add(command.mode);
  }
  if (!modes.has("development") || !modes.has("production"))
    throw new Error("candidate commands for both execution modes are required");
}

/** Restrict the unpublished package artifact to framework source and package metadata. */
export function auditPackageFiles(paths: Iterable<string>): void {
  let sourceFiles = 0;
  for (const path of paths) {
    const normalized = path.replace(/^package\//, "");
    if (
      normalized === "package.json" ||
      /^(README|LICENSE)(\.[^/]*)?$/i.test(normalized)
    )
      continue;
    if (!normalized.startsWith("src/") || /\.(test|spec)\./.test(normalized))
      throw new Error(`unexpected package content: ${normalized}`);
    sourceFiles += 1;
  }
  if (sourceFiles === 0)
    throw new Error("package contains no framework source");
}
