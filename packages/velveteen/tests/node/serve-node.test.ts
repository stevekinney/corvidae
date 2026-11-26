import assert from "node:assert/strict";
import { test } from "node:test";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import { serve } from "../../../node-host/src/index.ts";
import { createProductionAssetRoutes } from "../../src/build/serving.ts";
import { createApplication } from "../../src/server/index.ts";
import { readVelveteenTestEnvironment } from "../environment-configuration.ts";

const directory = readVelveteenTestEnvironment().nodeGeneration;
if (!directory) throw new Error("VELVETEEN_NODE_GENERATION is required");

const { manifest } = await import(
  pathToFileURL(join(directory, "velveteen-manifest.js")).href
);
const { registry } = await import(
  pathToFileURL(join(directory, "velveteen-registry.js")).href
);

const counter = {
  idFromName: () => "velveteen",
  get: () => ({ fetch: async () => new Response("3") }),
};

void test("serves a built page, compressed asset, and cookie session", async () => {
  const application = await createApplication({
    generation: { directory, manifest },
    registry,
    platform: { COUNTER: counter },
  });
  const host = serve({
    port: 0,
    routes: createProductionAssetRoutes(
      { directory, manifest },
      { compression: true },
    ),
    fetch: (request) => application.fetch(request),
  });
  try {
    await host.ready;
    const first = await fetch(host.url);
    assert.equal(first.status, 200);
    assert.match(await first.text(), /visitor: anonymous/u);
    const cookie = first.headers.get("set-cookie")?.split(";", 1)[0];
    assert.ok(cookie);

    const asset = await fetch(new URL("/worker-asset.txt", host.url), {
      headers: { "accept-encoding": "br" },
    });
    assert.equal(asset.status, 200);
    assert.equal(asset.headers.get("content-encoding"), "br");
    assert.equal(await asset.text(), "asset bytes from workerd\n");

    const authenticated = await fetch(host.url, { headers: { cookie } });
    assert.match(await authenticated.text(), /visitor: authenticated/u);
  } finally {
    host.stop(true);
    await application.dispose();
  }
});
