import { mkdir, mkdtemp, rm } from "node:fs/promises";
import { basename, join, resolve } from "node:path";
import { parseArgs } from "node:util";
import { createSveltePlugin } from "../../../src/compiler/index.ts";
import { prepareGeneratedGraph } from "../../../src/development/index.ts";
import { readVelveteenTestEnvironment } from "../../environment-configuration.ts";

const { values } = parseArgs({
  args: Bun.argv.slice(2),
  options: {
    mode: { type: "string", default: "production" },
    port: { type: "string", default: "0" },
    label: { type: "string" },
    "source-directory": { type: "string", default: import.meta.dir },
  },
});
const mode = values.mode;
if (mode !== "development" && mode !== "production")
  throw new Error(`invalid mode ${mode}`);
const root = resolve(import.meta.dir, "../../..");
const productionRoot = join(root, ".velveteen/candidate/production");
const evidenceRoot = join(root, ".velveteen/evidence");
const endpoint = () =>
  Response.json({
    status: readVelveteenTestEnvironment().endpointStatus ?? "ok",
  });
const notFound = () => new Response("not found", { status: 404 });
let artifact: string | undefined;
let server: Bun.Server<undefined>;
let closeDevelopment: (() => Promise<void>) | undefined;

if (mode === "development") {
  const developmentRoot = join(root, ".velveteen/candidate/development");
  await mkdir(developmentRoot, { recursive: true });
  const outputDirectory = await mkdtemp(join(developmentRoot, "graph-"));
  const graph = await prepareGeneratedGraph({
    sourceDirectory: values["source-directory"],
    outputDirectory,
    files: ["index.html", "main.ts", "app.svelte", "counter.svelte.ts"],
  });
  const { default: page } = await import(join(outputDirectory, "index.html"));
  closeDevelopment = async () => {
    await graph.close();
    await rm(outputDirectory, { recursive: true, force: true });
  };
  server = Bun.serve({
    hostname: "127.0.0.1",
    port: Number(values.port),
    routes: {
      "/": page,
      "/proof": page,
      "/endpoint": endpoint,
      "/__diagnostics": () => Response.json(graph.diagnostics),
    },
    development: { hmr: true },
    fetch: notFound,
  });
} else {
  await mkdir(productionRoot, { recursive: true });
  const outputRoot = await mkdtemp(join(productionRoot, "build-"));
  await mkdir(evidenceRoot, { recursive: true });
  const browserBuild = await Bun.build({
    entrypoints: [join(import.meta.dir, "main.ts")],
    outdir: join(outputRoot, "browser"),
    target: "browser",
    metafile: true,
    sourcemap: "external",
    plugins: [createSveltePlugin()],
  });
  const serverBuild = await Bun.build({
    entrypoints: [join(import.meta.dir, "server-entry.ts")],
    outdir: join(outputRoot, "server"),
    target: "bun",
    metafile: true,
    sourcemap: "external",
    plugins: [createSveltePlugin({ target: "server" })],
  });
  if (!browserBuild.success || !serverBuild.success)
    throw new AggregateError(
      [...browserBuild.logs, ...serverBuild.logs],
      "candidate compilation failed",
    );
  const hash = async (path: string) =>
    new Bun.CryptoHasher("sha256")
      .update(await Bun.file(path).arrayBuffer())
      .digest("hex");
  const evidence = async (build: typeof browserBuild, target: string) => ({
    target,
    inputRoot: import.meta.dir,
    outputDirectory: join(
      outputRoot,
      target === "browser" ? "browser" : "server",
    ),
    metafile: build.metafile,
    outputs: await Promise.all(
      build.outputs.map(async (output) => ({
        path: output.path,
        sha256: await hash(output.path),
      })),
    ),
  });
  artifact = join(outputRoot, "build.json");
  const buildEvidence = JSON.stringify(
    {
      schemaVersion: 1,
      root,
      outputRoot,
      builds: [
        await evidence(browserBuild, "browser"),
        await evidence(serverBuild, "bun"),
      ],
    },
    null,
    2,
  );
  await Bun.write(artifact, buildEvidence);
  await Bun.write(join(evidenceRoot, "candidate-build.json"), buildEvidence);
  const module = await import(join(outputRoot, "server/server-entry.js"));
  const rendered: { body: string; head: string } = module.renderPage();
  const assets = new Map(
    browserBuild.outputs.map((output) => [
      `/${basename(output.path)}`,
      output.path,
    ]),
  );
  const styles = browserBuild.outputs
    .filter((output) => output.path.endsWith(".css"))
    .map((output) => `<link rel="stylesheet" href="/${basename(output.path)}">`)
    .join("");
  const html = `<!doctype html><html lang="en"><head><meta charset="utf-8">${rendered.head}${styles}</head><body><div id="app">${rendered.body}</div><script type="module" src="/main.js"></script></body></html>`;
  server = Bun.serve({
    hostname: "127.0.0.1",
    port: Number(values.port),
    development: false,
    routes: { "/endpoint": endpoint },
    fetch(request) {
      const pathname = new URL(request.url).pathname;
      if (pathname === "/proof" || pathname === "/")
        return new Response(html, {
          headers: { "content-type": "text/html; charset=utf-8" },
        });
      const asset = assets.get(pathname);
      return asset ? new Response(Bun.file(asset)) : notFound();
    },
  });
}

console.log(
  JSON.stringify({
    mode,
    kind: "ready",
    url: server.url.href,
    artifact,
    bun: Bun.version,
    pid: process.pid,
  }),
);
const shutdown = async () => {
  await server.stop();
  await closeDevelopment?.();
};
process.once("SIGTERM", shutdown);
process.once("SIGINT", shutdown);
