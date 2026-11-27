import { createHash, randomUUID } from "node:crypto";
import { mkdir, readFile, readdir } from "node:fs/promises";
import { dirname, join, relative, resolve, sep } from "node:path";
import { createBrowserBoundary } from "./browser-boundary.ts";
import { createServerAssetPlugin } from "./server-assets.ts";
import { createSveltePlugin } from "../compiler/index.ts";
import { createClientManifest } from "../routing/index.ts";
import {
  clientRoles,
  serverRoles,
  roleSource,
  wrapper,
  registry,
  type Role,
  type Target,
} from "./entries.ts";
import {
  normalizeBasePath,
  productionFilePath,
  publicAssetUrl,
} from "./paths.ts";
import type {
  BrowserNode,
  ProductionAsset,
  ProductionGraphOptions,
  ProductionGraphResult,
  ProductionManifest,
  ProductionOutput,
  ServerNode,
} from "./manifest-types.ts";

type Entry = { file: string; css?: string };
async function buildOutputs(
  result: Bun.BuildOutput,
  staging: string,
  target: Target,
): Promise<ProductionOutput[]> {
  return Promise.all(
    result.outputs.map(async (artifact) => {
      const bytes = Buffer.from(await artifact.arrayBuffer());
      return {
        file: relative(staging, artifact.path).split("\\").join("/"),
        target,
        bytes: bytes.length,
        sha256: createHash("sha256").update(bytes).digest("hex"),
      };
    }),
  );
}
function entryMap(
  result: Bun.BuildOutput,
  wrappers: Map<string, string>,
  staging: string,
  outputDirectory: string,
  wrapperDirectory: string,
): Map<string, Entry> {
  if (!result.metafile)
    throw new Error("Production build did not return a metafile");
  const mapped = new Map<string, Entry>();
  for (const [output, metadata] of Object.entries(result.metafile.outputs)) {
    if (!metadata.entryPoint || !output.endsWith(".js")) continue;
    const key = [...wrappers].find(
      ([, source]) =>
        resolve(metadata.entryPoint!) === join(wrapperDirectory, source),
    )?.[0];
    if (!key) continue;
    mapped.set(key, {
      file: relative(
        staging,
        join(outputDirectory, output.replace(/^\.\//, "")),
      )
        .split("\\")
        .join("/"),
      css: metadata.cssBundle
        ? relative(
            staging,
            join(outputDirectory, metadata.cssBundle.replace(/^\.\//, "")),
          )
            .split("\\")
            .join("/")
        : undefined,
    });
  }
  for (const key of wrappers.keys())
    if (!mapped.has(key)) throw new Error(`Missing emitted entry ${key}`);
  return mapped;
}
async function copyStatic(
  directory: string | undefined,
  staging: string,
  base: string,
) {
  const outputs: ProductionOutput[] = [],
    assets: ProductionAsset[] = [];
  if (!directory) return { outputs, assets };
  const root = resolve(directory);
  const visit = async (current: string) => {
    const entries = await readdir(current, { withFileTypes: true });
    for (const item of entries.toSorted((a, b) =>
      a.name.localeCompare(b.name),
    )) {
      const source = join(current, item.name);
      const file = relative(root, source).split("\\").join("/");
      if (file === "_assets" || file.startsWith("_assets/"))
        throw new Error("Static files collide with the _assets namespace");
      if (item.isSymbolicLink())
        throw new Error(`Static symlink is not allowed: ${source}`);
      if (item.isDirectory()) await visit(source);
      else if (item.isFile()) {
        const destination = productionFilePath(staging, `static/${file}`);
        await mkdir(dirname(destination), { recursive: true });
        await Bun.write(destination, await Bun.file(source).arrayBuffer());
        const bytes = await readFile(destination);
        const output = {
          file: relative(staging, destination).split("\\").join("/"),
          target: "static" as const,
          bytes: bytes.length,
          sha256: createHash("sha256").update(bytes).digest("hex"),
        };
        outputs.push(output);
        assets.push({
          ...output,
          url: publicAssetUrl(base, file),
          contentType: Bun.file(destination).type || "application/octet-stream",
          immutable: false,
        });
      }
    }
  };
  await visit(root);
  return { outputs, assets };
}
export async function buildProductionGraph(
  options: ProductionGraphOptions,
): Promise<ProductionGraphResult> {
  const basePath = normalizeBasePath(options.basePath),
    staging = resolve(options.stagingDirectory);
  await mkdir(staging, { recursive: true });
  const stagedFiles = await readdir(staging);
  if (stagedFiles.length)
    throw new Error("Production staging directory must be empty");
  const wrappers = join(
    resolve(options.projectDirectory),
    `.velveteen-graph-${randomUUID()}`,
  );
  const files: Record<string, string> = {};
  const sveltePackage = await Bun.file(
    Bun.resolveSync("svelte/package.json", options.projectDirectory),
  ).json();
  const runtimeEntries = new Map<string, string>();
  for (const [index, key] of Object.keys(
    sveltePackage.exports as Record<string, unknown>,
  ).entries()) {
    if (key !== "." && !key.startsWith("./")) continue;
    const specifier = key === "." ? "svelte" : `svelte/${key.slice(2)}`;
    const path = join(wrappers, `runtime-${index}.ts`);
    files[path] = `export * from ${JSON.stringify(specifier)};`;
    runtimeEntries.set(specifier, path);
  }
  const frameworkRoot = resolve(import.meta.dir, "..");
  const runtimeResolution: Bun.BunPlugin = {
    name: "velveteen-project-svelte",
    setup(build) {
      build.onResolve({ filter: /^svelte(?:\/.*)?$/ }, (args) => {
        if (!args.importer.startsWith(`${frameworkRoot}${sep}`)) return;
        const path = runtimeEntries.get(args.path);
        if (!path) throw new Error(`Application Svelte does not export ${args.path}`);
        return { path, namespace: "file" };
      });
    },
  };
  const browserDirectory = join(staging, "browser"),
    serverDirectory = join(staging, "server");
  const browserMap = new Map<string, string>(),
    serverMap = new Map<string, string>();
  const browserEntries: Array<Partial<Record<Role, string>>> = [],
    serverEntries: Array<Partial<Record<Role, string>>> = [];
  await mkdir(browserDirectory, { recursive: true });
  await mkdir(serverDirectory, { recursive: true });
  for (const [index, node] of options.manifest.nodes.entries()) {
    const browser: Partial<Record<Role, string>> = {},
      server: Partial<Record<Role, string>> = {};
    for (const role of clientRoles)
      if (roleSource(node, role)) {
        const name = `node-${index}-${role}.browser.ts`;
        files[join(wrappers, name)] = wrapper(
          node,
          role,
          options.manifest.routesDirectory,
        );
        browserMap.set(`${index}:${role}`, name);
        browser[role] = name;
      }
    for (const role of serverRoles)
      if (roleSource(node, role)) {
        const name = `node-${index}-${role}.server.ts`;
        files[join(wrappers, name)] = wrapper(
          node,
          role,
          options.manifest.routesDirectory,
        );
        serverMap.set(`${index}:${role}`, name);
        server[role] = name;
      }
    browserEntries.push(browser);
    serverEntries.push(server);
  }
  const browserRegistry = join(wrappers, "browser-registry.ts"),
    serverRegistry = join(wrappers, "server-registry.ts");
  files[browserRegistry] = registry(
    browserEntries,
    "browser",
    createClientManifest(options.manifest),
    options.manifest.matcherModule,
    options.transportModule,
  );
  files[serverRegistry] = registry(
    serverEntries,
    "server",
    createClientManifest(options.manifest),
    options.manifest.matcherModule,
    options.transportModule,
  );
  const browserBuild = await Bun.build({
    entrypoints: [
      browserRegistry,
      ...[...browserMap.values()].map((file) => join(wrappers, file)),
    ],
    outdir: browserDirectory,
    target: "browser",
    files: { ...files },
    splitting: true,
    minify: options.mode !== "development",
    naming: {
      entry: "entries/[name]-[hash].[ext]",
      chunk: "chunks/[name]-[hash].[ext]",
      asset: "assets/[name]-[hash].[ext]",
    },
    sourcemap: "none",
    env: "disable",
    define: {
      "process.env.NODE_ENV": JSON.stringify(options.mode ?? "production"),
    },
    publicPath: `${basePath}/_assets/`,
    conditions: ["browser", "svelte", options.mode ?? "production"],
    allowUnresolved: [],
    metafile: true,
    plugins: [
      runtimeResolution,
      createBrowserBoundary({
        ...options,
        routesDirectory: options.manifest.routesDirectory,
      }),
      createSveltePlugin({ development: options.mode === "development" }),
    ],
  });
  if (!browserBuild.success || browserBuild.logs.length)
    throw new AggregateError(
      browserBuild.logs,
      "Browser production graph failed",
    );
  const serverBuild = await Bun.build({
    entrypoints: [
      serverRegistry,
      ...[...serverMap.values()].map((file) => join(wrappers, file)),
    ],
    outdir: serverDirectory,
    target: "bun",
    files: { ...files },
    splitting: true,
    minify: options.mode !== "development",
    naming: {
      entry: "entries/[name]-[hash].[ext]",
      chunk: "chunks/[name]-[hash].[ext]",
      asset: "assets/[name]-[hash].[ext]",
    },
    sourcemap: "none",
    env: "disable",
    define: {
      "process.env.NODE_ENV": JSON.stringify(options.mode ?? "production"),
    },
    conditions: ["bun", "svelte", options.mode ?? "production"],
    // Svelte uses an opaque import for its native node:crypto fallback. Browser imports remain strict.
    allowUnresolved: [""],
    metafile: true,
    plugins: [
      runtimeResolution,
      {
        name: "velveteen-virtual-entries",
        setup(build) {
          build.onResolve({ filter: /.*/ }, (args) => {
            if (
              args.kind === "entry-point-build" &&
              Object.hasOwn(files, args.path)
            )
              return { path: args.path, namespace: "file" };
          });
        },
      },
      await createServerAssetPlugin({
        browserBuild,
        inputRoot: process.cwd(),
        basePath,
        browserDirectory,
      }),
      createSveltePlugin({
        target: "server",
        development: options.mode === "development",
      }),
    ],
  });
  if (!serverBuild.success || serverBuild.logs.length)
    throw new AggregateError(
      serverBuild.logs,
      "Server production graph failed",
    );
  const browserOutput = entryMap(
      browserBuild,
      browserMap,
      staging,
      browserDirectory,
      wrappers,
    ),
    browserNodes: Record<string, BrowserNode> = {},
    serverNodes: Record<string, ServerNode> = {};
  for (const index of options.manifest.nodes.keys()) {
    const browserNode: BrowserNode = {},
      serverNode: ServerNode = {};
    for (const role of clientRoles) {
      const entry = browserOutput.get(`${index}:${role}`);
      if (entry)
        browserNode[role as keyof BrowserNode] = {
          file: entry.file,
          url: publicAssetUrl(
            basePath,
            "_assets/" + entry.file.replace(/^browser\//, ""),
          ),
          stylesheets: entry.css
            ? [
                publicAssetUrl(
                  basePath,
                  "_assets/" + entry.css.replace(/^browser\//, ""),
                ),
              ]
            : [],
        };
    }
    for (const role of serverRoles) {
      const name = serverMap.get(`${index}:${role}`);
      if (!name) continue;
      const output = Object.entries(serverBuild.metafile!.outputs).find(
        ([path, metadata]) =>
          path.endsWith(".js") &&
          metadata.entryPoint &&
          resolve(metadata.entryPoint) === join(wrappers, name),
      );
      if (!output)
        throw new Error(`Missing emitted server entry ${index}:${role}`);
      serverNode[role] = {
        file: `server/${output[0].replace(/^\.\//, "")}`,
      };
    }
    browserNodes[String(index)] = browserNode;
    serverNodes[String(index)] = serverNode;
  }
  const registryOutput = (result: Bun.BuildOutput, source: string) =>
    Object.entries(result.metafile!.outputs).find(
      ([path, metadata]) =>
        path.endsWith(".js") &&
        metadata.entryPoint &&
        resolve(metadata.entryPoint) === join(wrappers, source),
    )?.[0];
  const browserRegistryOutput = registryOutput(
      browserBuild,
      "browser-registry.ts",
    ),
    serverRegistryOutput = registryOutput(serverBuild, "server-registry.ts");
  if (!browserRegistryOutput || !serverRegistryOutput)
    throw new Error("Production registries were not emitted");
  const staticFiles = await copyStatic(
      options.staticDirectory,
      staging,
      basePath,
    ),
    browserOutputs = await buildOutputs(browserBuild, staging, "browser"),
    serverOutputs = await buildOutputs(serverBuild, staging, "server");
  const outputs = [...browserOutputs, ...serverOutputs, ...staticFiles.outputs];
  const assets = [
    ...browserOutputs
      .filter((output) => output.file.startsWith("browser/"))
      .map((output) => ({
        ...output,
        url: publicAssetUrl(
          basePath,
          "_assets/" + output.file.replace(/^browser\//, ""),
        ),
        contentType:
          Bun.file(join(staging, output.file)).type ||
          "application/octet-stream",
        immutable: true,
      })),
    ...staticFiles.assets,
  ];
  const styles = (index: number, role: "page" | "layout") => {
    const node = browserNodes[String(index)];
    return node?.[role]?.stylesheets ?? [];
  };
  const routes = Object.fromEntries(
    options.manifest.routes.map((route) => [
      route.id,
      {
        stylesheets: [
          ...new Set([
            ...route.layouts.flatMap((index) =>
              index === null ? [] : styles(index, "layout"),
            ),
            ...(route.leaf === undefined ? [] : styles(route.leaf, "page")),
          ]),
        ],
      },
    ]),
  );
  const clientFile = `browser/${browserRegistryOutput.replace(/^\.\//, "")}`,
    serverFile = `server/${serverRegistryOutput.replace(/^\.\//, "")}`;
  const manifest: ProductionManifest = {
    version: 1,
    basePath,
    routing: createClientManifest(options.manifest),
    client: {
      file: clientFile,
      url: publicAssetUrl(
        basePath,
        "_assets/" + clientFile.replace(/^browser\//, ""),
      ),
      stylesheets: [],
      nodes: browserNodes,
    },
    server: { file: serverFile, nodes: serverNodes },
    routes,
    assets,
    outputs,
  };
  await Bun.write(
    join(staging, "manifest.json"),
    JSON.stringify(manifest, null, 2) + "\n",
  );
  await Bun.write(
    join(staging, "velveteen-manifest.js"),
    `export const manifest = ${JSON.stringify(manifest, null, 2)};\n`,
  );
  await Bun.write(
    join(staging, "velveteen-registry.js"),
    `import * as registry from ${JSON.stringify(`./${serverFile}`)};\nexport { registry };\n`,
  );
  await Bun.write(
    join(staging, "build-metadata.json"),
    JSON.stringify(
      { browser: browserBuild.metafile, server: serverBuild.metafile },
      null,
      2,
    ) + "\n",
  );
  return {
    manifest,
    metadata: {
      browser: browserBuild.metafile!,
      server: serverBuild.metafile!,
    },
  };
}
