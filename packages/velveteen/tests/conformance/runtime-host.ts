import { createApplication } from "../../src/server/index.ts";
import type { ProductionGeneration } from "../../src/build/manifest-types.ts";
import {
  runtimeRemoteDefinitions,
  runtimeRemoteForms,
} from "./runtime-remote-definitions.ts";
const generation: ProductionGeneration = await Bun.file(process.argv[2]).json();
const app = await createApplication({
  generation,
  remotes: runtimeRemoteDefinitions,
  remoteForms: runtimeRemoteForms,
});
const server = Bun.serve({
  hostname: "127.0.0.1",
  port: 0,
  routes: app.routes,
  fetch: app.fetch,
});
console.log(JSON.stringify({ url: String(server.url), bun: Bun.version }));
process.on("SIGTERM", async () => {
  await app.dispose();
  await server.stop(true);
  process.exit(0);
});
