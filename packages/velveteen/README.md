# Velveteen

Velveteen is a private Bun-native Svelte compiler and application framework. Corvidae consumers can depend on `@lostgradient/velveteen` with `workspace:*` and import `@lostgradient/velveteen/compiler` to use its Bun build plugin.

From this directory, run `bun run test` for the workspace tests and `bun run test:package-consumer` to verify the packed compiler and TypeScript starter in independent applications. Run `bun run prepare:reference` before `bun run typecheck:reference` or `bun run test:batch-j`, which includes the pinned SvelteKit comparisons.

Production builds write `velveteen-manifest.js` and `velveteen-registry.js` alongside `manifest.json`. A host can import both modules and pass their `manifest` and `registry` values to `createApplication`, avoiding a runtime filesystem import of the generation. Supply an `assets` source when the host owns static assets. `fetchAssetSource(env.ASSETS)` adapts a Fetch binding such as a Cloudflare Workers `ASSETS` binding and delegates asset responses without Velveteen compression.

A production build can run on Node through any Fetch host, including `@lostgradient/node-host`. The build, compiler, and development server remain Bun tools.

## Cloudflare Workers

Build the application before bundling a Worker, then make the Worker entry import the build-output modules. The entry constructs `createApplication` with the generated `manifest` and `registry`, and passes `fetchAssetSource(env.ASSETS)` for the Worker static-assets binding. It can also pass `env` as `platform`, mount Fetch services, and export Durable Object classes normally:

```ts
import {
  createApplication,
  fetchAssetSource,
} from "@lostgradient/velveteen/server";
import { manifest } from "./velveteen-manifest.js";
import { registry } from "./velveteen-registry.js";

let application;

export default {
  async fetch(request, env) {
    application ??= createApplication({
      generation: { directory: "", manifest },
      registry,
      assets: fetchAssetSource(env.ASSETS),
      platform: env,
    });
    return (await application).fetch(request);
  },
};
```

The Worker needs Cloudflare's `nodejs_compat` compatibility flag because request context uses `AsyncLocalStorage`. Route compilation and the production build remain build-time work; the Worker only imports their generated modules and serves requests. Wrangler bundles that entry and generated output, while its assets binding owns response cache headers.

The original prototype plan and evidence summaries are in [FEASIBILITY.md](./FEASIBILITY.md) and [EXECUTION.md](./EXECUTION.md).
