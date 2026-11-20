// This fixture's small renderer is not the framework load/document/navigation runtime (E/F).
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import type { Component } from "svelte";
import type { render } from "svelte/server";
import { readProductionGeneration } from "../../src/build/publication.ts";
import { createProductionAssetRoutes } from "../../src/build/serving.ts";
import { matchRoute } from "../../src/routing/match.ts";

type ServerRegistry = {
  render: typeof render;
  nodes: Array<{
    page?: () => Promise<{ default: Component }>;
    endpoint?: () => Promise<{ GET: () => Response }>;
  }>;
};
const generation = await readProductionGeneration(
  join(import.meta.dir, "application"),
);
const { manifest } = generation;
const registry: ServerRegistry = await import(
  pathToFileURL(join(generation.directory, manifest.server.file)).href
);
if (typeof document !== "undefined")
  throw new Error("SSR fixture must be DOM-free");
const assets = createProductionAssetRoutes(
  generation,
  process.env.VELVETEEN_FIXTURE_COMPRESSION === "true"
    ? { compression: true }
    : undefined,
);
const base = manifest.basePath;
const missing = () => new Response("Not Found", { status: 404 });
const server = Bun.serve({
  hostname: "127.0.0.1",
  port: 0,
  development: false,
  routes: {
    ...assets,
    "/host-api": () => Response.json({ host: "preserved" }),
  },
  async fetch(request) {
    const { pathname } = new URL(request.url);
    if (base && pathname !== base && !pathname.startsWith(base + "/"))
      return missing();
    const path = pathname.slice(base.length) || "/";
    if (path.startsWith("/_assets/")) return missing();
    if (path === "/compiled-endpoint") {
      const root = manifest.routing.routes.find((route) => route.id === "/")!;
      const endpoint = await registry.nodes[root.node].endpoint!();
      return endpoint.GET();
    }
    const match = matchRoute(manifest.routing, path);
    if (!match || match.route.leaf === undefined) return missing();
    if (request.method !== "GET" && request.method !== "HEAD")
      return new Response(null, {
        status: 405,
        headers: { allow: "GET, HEAD" },
      });
    const component = await registry.nodes[match.route.leaf].page!();
    const rendered = await registry.render(component.default);
    const styles = manifest.routes[match.route.id].stylesheets
      .map((url) => `<link rel="stylesheet" href="${url}">`)
      .join("");
    const second = manifest.routing.routes.find(
      (route) => route.id === "/second",
    )!;
    const bootstrap = `import { nodes, hydrate } from ${JSON.stringify(manifest.client.url)}; const component = await nodes[${match.route.leaf}].page(); hydrate(component.default, {target: document.getElementById('app'), recover: false}); document.documentElement.dataset.hydrated = 'true'; document.getElementById('load-second').onclick = async () => { await nodes[${second.leaf}].page(); document.documentElement.dataset.secondLoaded = 'true'; };`;
    return new Response(
      `<!doctype html><html lang="en"><head><meta charset="utf-8">${rendered.head}${styles}</head><body><div id="app">${rendered.body}</div><button id="load-second">Load second module</button><script type="module">${bootstrap}</script></body></html>`,
      { headers: { "content-type": "text/html; charset=utf-8" } },
    );
  },
});
console.log(
  JSON.stringify({ url: server.url.href, bun: Bun.version, pid: process.pid }),
);
process.once("SIGTERM", async () => {
  await server.stop();
});
process.once("SIGINT", async () => {
  await server.stop();
});
