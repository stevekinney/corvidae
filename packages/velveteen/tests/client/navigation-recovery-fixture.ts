import { mkdir, mkdtemp, rm } from "node:fs/promises";
import { dirname, join } from "node:path";
import { buildProduction } from "../../src/build/index.ts";
import { createApplication } from "../../src/server/index.ts";
import { dataMediaType } from "../../src/data/contract.ts";

export const recoveryDataHeader = "x-velveteen-fixture-data";

export async function startRecoveryFixture(mode: "development" | "production") {
  const buildRoot = join(process.cwd(), ".velveteen/build");
  await mkdir(buildRoot, { recursive: true });
  const directory = await mkdtemp(join(buildRoot, "navigation-recovery-"));
  let application: Awaited<ReturnType<typeof createApplication>> | undefined;
  let server: ReturnType<typeof Bun.serve> | undefined;
  const documents: string[] = [];
  const chunkRequests: string[] = [];
  let missing: "never" | "once" | "always" = "never";
  try {
    const sources = {
      "package.json": JSON.stringify({ type: "module" }),
      "src/routes/+page.svelte": "<h1 data-page>Healthy</h1>",
      "src/routes/broken/+page.svelte": "<h1 data-page>Recovered</h1>",
      "src/routes/evaluation/+page.svelte":
        '<script module>if (typeof window !== "undefined") throw new Error("Fixture evaluation failed");</script><h1 data-page>Evaluation</h1>',
    };
    for (const [file, contents] of Object.entries(sources)) {
      await mkdir(dirname(join(directory, file)), { recursive: true });
      await Bun.write(join(directory, file), contents);
    }
    const generation = await buildProduction({
      projectDirectory: directory,
      routesDirectory: join(directory, "src/routes"),
      outputDirectory: join(directory, "output"),
      basePath: "/recovery",
      mode,
    });
    const brokenRoute = generation.manifest.routing.routes.find(
      (route) => route.id === "/broken",
    )!;
    const brokenChunk =
      generation.manifest.client.nodes[String(brokenRoute.leaf)]!.page!.url;
    const built = await Bun.build({
      entrypoints: [join(import.meta.dir, "navigation-recovery-bootstrap.ts")],
      target: "browser",
      define: {
        recoveryRegistryUrl: JSON.stringify(generation.manifest.client.url),
        recoveryDataHeader: JSON.stringify(recoveryDataHeader),
      },
    });
    if (!built.success || built.logs.length)
      throw new Error(built.logs.map(String).join("\n"));
    const bootstrap = await built.outputs[0]!.text();
    application = await createApplication({ generation });
    server = Bun.serve({
      hostname: "127.0.0.1",
      port: 0,
      async fetch(request) {
        const url = new URL(request.url);
        if (url.pathname === brokenChunk) {
          chunkRequests.push(url.pathname);
          if (missing !== "never") {
            if (missing === "once") missing = "never";
            return new Response("Missing fixture chunk", { status: 404 });
          }
        }
        if (url.pathname === "/recovery/bootstrap.js")
          return new Response(bootstrap, {
            headers: { "content-type": "text/javascript" },
          });
        if (
          request.headers.get("accept")?.includes("text/html") &&
          !request.headers.get("accept")?.includes(dataMediaType)
        ) {
          documents.push(url.pathname);
          return new Response(
            '<!doctype html><html><head><link rel="icon" href="data:,"></head><body><nav><a href="/recovery/broken">broken</a><a href="/recovery/evaluation">evaluation</a><a href="/recovery/" data-velveteen-reload>healthy</a></nav><p data-recovery-status>Starting</p><div id="app"></div><script type="module" src="/recovery/bootstrap.js"></script></body></html>',
            { headers: { "content-type": "text/html" } },
          );
        }
        const response = await application!.fetch(request);
        if (!response.headers.get("content-type")?.startsWith(dataMediaType))
          return response;
        // Recovery has no deferred values. Serve its complete data as a
        // fixed-length response so document replacement only interrupts the
        // deliberately failed module request.
        const body = await response.arrayBuffer();
        const headers = new Headers(response.headers);
        headers.set("content-length", String(body.byteLength));
        return new Response(body, { headers, status: response.status });
      },
    });
    return {
      origin: server.url.origin,
      brokenChunk,
      documents,
      chunkRequests,
      setMissing(value: typeof missing) {
        missing = value;
      },
      reset() {
        documents.length = 0;
        chunkRequests.length = 0;
        missing = "never";
      },
      async stop() {
        await application!.dispose();
        await server!.stop(true);
        await rm(directory, { recursive: true, force: true });
      },
    };
  } catch (cause) {
    await application?.dispose();
    await server?.stop(true);
    await rm(directory, { recursive: true, force: true });
    throw cause;
  }
}
