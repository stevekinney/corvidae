import { mkdir, mkdtemp, realpath, rm } from "node:fs/promises";
import { dirname, isAbsolute, join, relative, resolve, sep } from "node:path";
import { buildRouteManifest } from "../routing/index.ts";
import { buildProductionGraph } from "./graph.ts";
import { publishProductionGeneration } from "./publication.ts";
import { normalizeBasePath } from "./paths.ts";
import type { ProductionGeneration } from "./manifest-types.ts";

function contains(directory: string, file: string) {
  const path = relative(directory, file);
  return !isAbsolute(path) && path !== ".." && !path.startsWith(`..${sep}`);
}

// Resolve existing ancestors before creating anything, including destinations reached through symlinks.
async function canonicalDestination(path: string): Promise<string> {
  try {
    return await realpath(path);
  } catch (error) {
    if (
      !(error instanceof Error) ||
      !("code" in error) ||
      error.code !== "ENOENT"
    )
      throw error;
    const parent = dirname(path);
    if (parent === path) throw error;
    return join(await canonicalDestination(parent), relative(parent, path));
  }
}

/** Build a complete generation before atomically making it current. Existing generations stay usable. */
export async function buildProduction(options: {
  projectDirectory: string;
  routesDirectory: string;
  outputDirectory: string;
  staticDirectory?: string;
  basePath?: string;
  mode?: "development" | "production";
}): Promise<ProductionGeneration> {
  const projectDirectory = await realpath(options.projectDirectory);
  const routesDirectory = await realpath(options.routesDirectory);
  const staticDirectory = options.staticDirectory
    ? await realpath(options.staticDirectory)
    : undefined;
  const outputDirectory = await canonicalDestination(
    resolve(options.outputDirectory),
  );
  const basePath = normalizeBasePath(options.basePath);
  if (!contains(projectDirectory, routesDirectory))
    throw new Error("Routes directory must be within the project");
  for (const source of [
    routesDirectory,
    ...(staticDirectory ? [staticDirectory] : []),
  ]) {
    if (contains(source, outputDirectory) || contains(outputDirectory, source))
      throw new Error(
        "Production output and source directories must not contain one another",
      );
  }
  const parameterSource = join(projectDirectory, "src/params.ts");
  const matcherModule = (await Bun.file(parameterSource).exists())
    ? await realpath(parameterSource)
    : undefined;
  if (matcherModule && !contains(projectDirectory, matcherModule))
    throw new Error("Parameter matcher module must be within the project");
  const transportSource = join(projectDirectory, "src/transport.ts");
  const transportModule = (await Bun.file(transportSource).exists())
    ? await realpath(transportSource)
    : undefined;
  if (transportModule && !contains(projectDirectory, transportModule))
    throw new Error("Transport module must be within the project");
  const manifest = await buildRouteManifest(routesDirectory, { matcherModule });
  await mkdir(outputDirectory, { recursive: true });
  const stagingDirectory = await mkdtemp(join(outputDirectory, ".stage-"));
  try {
    const result = await buildProductionGraph({
      projectDirectory,
      mode: options.mode,
      manifest,
      stagingDirectory,
      staticDirectory,
      basePath,
      transportModule,
    });
    return await publishProductionGeneration({
      stagingDirectory,
      outputDirectory,
      manifest: result.manifest,
    });
  } catch (error) {
    await rm(stagingDirectory, { recursive: true, force: true });
    throw error;
  }
}
