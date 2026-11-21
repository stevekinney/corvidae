import { createHash, randomUUID } from "node:crypto";
import {
  lstat,
  mkdir,
  readFile,
  realpath,
  rename,
  rm,
  stat,
} from "node:fs/promises";
import { join, relative } from "node:path";
import {
  canonicalAssetUrl,
  normalizeBasePath,
  productionFilePath,
} from "./paths.ts";
import type {
  BrowserModule,
  ClientModuleRole,
  ProductionGeneration,
  ProductionManifest,
  ProductionOutput,
  ServerModule,
} from "./manifest-types.ts";

type GenerationPointer = { version: 1; generation: string };

const pointerName = "current.json";
const generationDirectoryName = "generations";
const sha256Pattern = /^[a-f0-9]{64}$/;
const generationPattern =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === "object" && value !== null;

const assertSafeRelativePath = (path: string, label: string): void => {
  try {
    productionFilePath("/root", path);
  } catch {
    throw new Error(`${label} must be a safe relative path: ${path}`);
  }
};

const moduleRoles: ClientModuleRole[] = [
  "page",
  "layout",
  "error",
  "pageUniversal",
  "layoutUniversal",
];

const assertBrowserModule = (
  module: BrowserModule,
  outputs: Map<string, ProductionOutput>,
  assets: Map<string, ProductionManifest["assets"][number]>,
): void => {
  const output = outputs.get(module.file);
  if (!output || output.target !== "browser")
    throw new Error(`browser module is not a browser output: ${module.file}`);
  const asset = [...assets.values()].find(
    (candidate) => candidate.file === module.file,
  );
  if (!asset || asset.url !== module.url)
    throw new Error(
      `browser module URL does not map to its output: ${module.file}`,
    );
  for (const stylesheet of module.stylesheets) {
    const css = assets.get(stylesheet);
    if (!css || !css.contentType.startsWith("text/css"))
      throw new Error(
        `stylesheet does not identify a CSS asset: ${stylesheet}`,
      );
  }
};

const assertServerModule = (
  module: ServerModule,
  outputs: Map<string, ProductionOutput>,
): void => {
  const output = outputs.get(module.file);
  if (!output || output.target !== "server")
    throw new Error(`server module is not a server output: ${module.file}`);
};

const assertManifestShape = (manifest: ProductionManifest): void => {
  if (!isRecord(manifest) || manifest.version !== 1) {
    throw new Error("production manifest has an unsupported version");
  }
  if (typeof manifest.basePath !== "string")
    throw new Error("production manifest has an invalid basePath");
  normalizeBasePath(manifest.basePath);
  if (!Array.isArray(manifest.outputs) || !Array.isArray(manifest.assets)) {
    throw new Error("production manifest must contain outputs and assets");
  }
  if (
    !isRecord(manifest.client) ||
    !isRecord(manifest.server) ||
    typeof manifest.client.file !== "string" ||
    typeof manifest.server.file !== "string" ||
    !isRecord(manifest.client.nodes) ||
    !isRecord(manifest.server.nodes) ||
    !isRecord(manifest.routes)
  ) {
    throw new Error("production manifest has invalid graph modules");
  }
  const outputFiles = new Set<string>();
  for (const output of manifest.outputs) {
    assertOutputShape(output);
    if (outputFiles.has(output.file))
      throw new Error(`duplicate output: ${output.file}`);
    outputFiles.add(output.file);
  }
  const assetUrls = new Set<string>();
  const assets = new Map<string, ProductionManifest["assets"][number]>();
  for (const asset of manifest.assets) {
    assertOutputShape(asset);
    if (typeof asset.url !== "string" || !asset.url.startsWith("/")) {
      throw new Error(`asset has an invalid URL: ${asset.url}`);
    }
    if (assetUrls.has(asset.url))
      throw new Error(`duplicate asset URL: ${asset.url}`);
    assetUrls.add(asset.url);
    if (
      typeof asset.contentType !== "string" ||
      typeof asset.immutable !== "boolean"
    ) {
      throw new Error(`asset has invalid serving metadata: ${asset.url}`);
    }
    const output = manifest.outputs.find(
      (candidate) => candidate.file === asset.file,
    );
    if (
      !output ||
      output.sha256 !== asset.sha256 ||
      output.bytes !== asset.bytes ||
      output.target !== asset.target
    )
      throw new Error(`asset output is missing: ${asset.file}`);
    if (asset.target === "server")
      throw new Error(`server output cannot be public: ${asset.file}`);
    if (asset.url !== canonicalAssetUrl(manifest.basePath, asset))
      throw new Error(`asset URL is not canonical: ${asset.url}`);
    assets.set(asset.url, asset);
  }
  if (manifest.client.file)
    assertBrowserModule(
      manifest.client,
      new Map(manifest.outputs.map((output) => [output.file, output])),
      assets,
    );
  for (const node of Object.values(manifest.client.nodes)) {
    for (const role of moduleRoles) {
      const module = node[role];
      if (module)
        assertBrowserModule(
          module,
          new Map(manifest.outputs.map((output) => [output.file, output])),
          assets,
        );
    }
  }
  if (manifest.server.file)
    assertServerModule(
      manifest.server,
      new Map(manifest.outputs.map((output) => [output.file, output])),
    );
  for (const node of Object.values(manifest.server.nodes)) {
    for (const module of Object.values(node))
      if (module)
        assertServerModule(
          module,
          new Map(manifest.outputs.map((output) => [output.file, output])),
        );
  }
  for (const route of Object.values(manifest.routes)) {
    for (const stylesheet of route.stylesheets) {
      const css = assets.get(stylesheet);
      if (!css || !css.contentType.startsWith("text/css"))
        throw new Error(
          `stylesheet does not identify a CSS asset: ${stylesheet}`,
        );
    }
  }
};

const assertOutputShape = (output: ProductionOutput): void => {
  if (!isRecord(output))
    throw new Error("production manifest contains an invalid output");
  if (typeof output.file !== "string")
    throw new Error("production output has no file");
  assertSafeRelativePath(output.file, "production output file");
  if (!["browser", "server", "static"].includes(output.target)) {
    throw new Error(`production output has an invalid target: ${output.file}`);
  }
  if (!Number.isSafeInteger(output.bytes) || output.bytes < 0) {
    throw new Error(
      `production output has an invalid byte count: ${output.file}`,
    );
  }
  if (!sha256Pattern.test(output.sha256)) {
    throw new Error(`production output has an invalid hash: ${output.file}`);
  }
};

const assertWithinGeneration = async (
  directory: string,
  file: string,
): Promise<string> => {
  const root = await realpath(directory);
  const candidate = await realpath(join(root, file));
  const path = relative(root, candidate);
  if (
    path === "" ||
    path === ".." ||
    path.startsWith("../") ||
    path.includes("/../")
  ) {
    throw new Error(`path escapes production generation: ${file}`);
  }
  return candidate;
};

const validateGenerationFiles = async (
  directory: string,
  manifest: ProductionManifest,
): Promise<void> => {
  assertManifestShape(manifest);
  const generationInformation = await lstat(directory);
  if (
    !generationInformation.isDirectory() ||
    generationInformation.isSymbolicLink()
  ) {
    throw new Error("production generation is not a real directory");
  }
  const referencedFiles = new Set<string>([
    manifest.client.file,
    manifest.server.file,
    ...Object.values(manifest.client.nodes).flatMap((node) =>
      Object.values(node).flatMap((module) => (module ? [module.file] : [])),
    ),
    ...Object.values(manifest.server.nodes).flatMap((node) =>
      Object.values(node).flatMap((module) => (module ? [module.file] : [])),
    ),
  ]);
  for (const asset of manifest.assets) {
    for (const module of [
      manifest.client,
      ...Object.values(manifest.client.nodes).flatMap((node) =>
        Object.values(node),
      ),
    ]) {
      if (
        module &&
        "stylesheets" in module &&
        module.stylesheets.includes(asset.url)
      )
        referencedFiles.add(asset.file);
    }
  }
  for (const route of Object.values(manifest.routes)) {
    for (const stylesheet of route.stylesheets) {
      const asset = manifest.assets.find(
        (candidate) => candidate.url === stylesheet,
      );
      if (asset) referencedFiles.add(asset.file);
    }
  }
  for (const file of referencedFiles) {
    const path = await assertWithinGeneration(directory, file);
    const information = await stat(path);
    if (!information.isFile())
      throw new Error(`referenced output is not a file: ${file}`);
  }
  for (const output of manifest.outputs) {
    const file = await assertWithinGeneration(directory, output.file);
    const information = await stat(file);
    if (!information.isFile() || information.size !== output.bytes) {
      throw new Error(
        `production output does not match manifest: ${output.file}`,
      );
    }
    const digest = createHash("sha256")
      .update(await readFile(file))
      .digest("hex");
    if (digest !== output.sha256)
      throw new Error(`production output hash mismatch: ${output.file}`);
  }
};

const readManifest = async (directory: string): Promise<ProductionManifest> => {
  const manifestPath = await assertWithinGeneration(directory, "manifest.json");
  const value: unknown = JSON.parse(await readFile(manifestPath, "utf8"));
  if (!isRecord(value)) throw new Error("production manifest is not an object");
  return value as unknown as ProductionManifest;
};

export const publishProductionGeneration = async ({
  stagingDirectory,
  outputDirectory,
  manifest,
}: {
  stagingDirectory: string;
  outputDirectory: string;
  manifest: ProductionManifest;
}): Promise<ProductionGeneration> => {
  let stage: string | undefined;
  let moved = false;
  let generationDirectory: string | undefined;
  let temporaryPointer: string | undefined;
  try {
    const originalStageInformation = await lstat(stagingDirectory);
    if (originalStageInformation.isSymbolicLink())
      throw new Error("staging directory must not be a symlink");
    stage = await realpath(stagingDirectory);
    const stageInformation = await lstat(stage);
    if (!stageInformation.isDirectory())
      throw new Error("staging directory is not a directory");
    assertManifestShape(manifest);
    const stagedManifest = await readManifest(stage);
    if (JSON.stringify(stagedManifest) !== JSON.stringify(manifest)) {
      throw new Error("staged manifest does not match publication manifest");
    }
    await validateGenerationFiles(stage, manifest);
    await mkdir(outputDirectory, { recursive: true });
    const currentPath = join(outputDirectory, pointerName);
    try {
      const currentInformation = await lstat(currentPath);
      if (currentInformation.isSymbolicLink() || !currentInformation.isFile())
        throw new Error("current production pointer is not a regular file");
      await readProductionGeneration(outputDirectory);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
    }
    const generationsDirectory = join(outputDirectory, generationDirectoryName);
    await mkdir(generationsDirectory, { recursive: true });
    const generation = randomUUID();
    generationDirectory = join(generationsDirectory, generation);
    temporaryPointer = join(outputDirectory, `current.${randomUUID()}.tmp`);
    await rename(stage, generationDirectory);
    moved = true;
    const pointer: GenerationPointer = { version: 1, generation };
    await Bun.write(temporaryPointer, JSON.stringify(pointer) + "\n");
    await rename(temporaryPointer, currentPath);
    const published = { directory: generationDirectory, manifest };
    return published;
  } catch (error) {
    if (temporaryPointer) await rm(temporaryPointer, { force: true });
    if (moved && generationDirectory)
      await rm(generationDirectory, { recursive: true, force: true });
    else if (stage) await rm(stage, { recursive: true, force: true });
    throw error;
  }
};

export const readProductionGeneration = async (
  outputDirectory: string,
): Promise<ProductionGeneration> => {
  const pointerPath = join(outputDirectory, pointerName);
  const value: unknown = JSON.parse(await readFile(pointerPath, "utf8"));
  if (
    !isRecord(value) ||
    value.version !== 1 ||
    typeof value.generation !== "string" ||
    !generationPattern.test(value.generation)
  ) {
    throw new Error("production pointer is invalid");
  }
  const directory = join(
    outputDirectory,
    generationDirectoryName,
    value.generation,
  );
  const directoryInformation = await lstat(directory);
  if (directoryInformation.isSymbolicLink())
    throw new Error("production generation must not be a symlink");
  const generationsDirectory = await realpath(
    join(outputDirectory, generationDirectoryName),
  );
  const resolvedDirectory = await realpath(directory);
  const generationPath = relative(generationsDirectory, resolvedDirectory);
  if (
    generationPath === "" ||
    generationPath === ".." ||
    generationPath.startsWith("../") ||
    generationPath.includes("/../")
  ) {
    throw new Error(
      "production pointer generation escapes its output directory",
    );
  }
  const manifest = await readManifest(directory);
  await validateGenerationFiles(directory, manifest);
  return { directory, manifest };
};
