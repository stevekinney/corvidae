/**
 * Dev harness server (plan §2, T0.3, PROJECT-BRIEF "Dev harness"). Boots a
 * seeded local Weft server on port 7233 that the Bun browser host targets.
 * Run directly with `bun run dev:server`.
 *
 * **It starts Weft through `dashboard()`, so port 7233 also serves the
 * console.** `dashboard()` is `serve()` plus the console's page routes and
 * its `/assets/*` route, so everything below about `serve()` holds for it.
 * The console it serves is compiled once into `build/dashboard/` (ignored,
 * like the browser host's own `build/`) in the layout `dashboard()` expects:
 * `index.html` at the top and every script, stylesheet, and chunk under
 * `assets/`. That compile runs only when `build/dashboard/index.html` is
 * missing, because `bun --watch` restarts this process on every Weft edit;
 * delete the directory to pick up console changes here. The browser host on
 * port 5173 rebuilds on every change and remains the place to work on the
 * console itself. This harness compile is not Weft's production dashboard
 * build, which writes `packages/weft/dashboard/` and is what `dashboard()`
 * serves when no `distDir` is passed.
 *
 * It calls Weft with no cast, no manual `/api`-prefix stripping (`serve()`
 * does that itself — `src/server/runtime/authentication-bridge.ts`'s
 * `stripApiPrefix()`), and no reimplemented event feed (`serve()` wires
 * both the fleet feed and the per-workflow feed via its own
 * `wireEventBroadcasting()` / `createWorkflowEventFeed()` internally), so
 * WebSocket upgrades and JSON-RPC over HTTP (`/api/jsonrpc`) work in this
 * dev harness.
 *
 * **Auth — real, not full-trust, and narrower than the old harness.**
 * `unauthenticatedAccess: 'warn'` only controls whether `serve()` refuses to
 * *start* with no `auth` configured (fail-closed vs warn-and-proceed) — it
 * has no per-request effect once the process is up
 * (`assertAuthenticationPosture`, `weft/src/server/serve-internals.ts`).
 * Every credential-less request still resolves to `anonymousPrincipal()`
 * (zero scopes, `weft/src/server/handler/auth-context-principal.ts`), so
 * only `access: { kind: 'public' }` operations — most workflow reads and
 * single-item actions — actually succeed here. `access: 'scoped'`/
 * `'authenticated'` operations (schedules list/get, reviews list, storage,
 * system/registry, …) 401 with no credential, confirmed live (`curl
 * localhost:7233/api/v1/schedules` → `401 {"error":"authentication
 * required"}`). This is narrower than the OLD `handleRequest`-based harness,
 * which hand-injected a full-scope `principalFromStdioLocal()` principal on
 * every request regardless of credentials — `serve()` has no equivalent
 * hook; the only way to grant elevated scopes to anonymous callers would be
 * `serve({ auth: { apiKeys: […] } })` plus a matching token the console
 * itself sends — which is exactly what this harness now does, as of the
 * weft 0.18.0 adoption. The deferral reasoned that it "touches the frozen
 * `index.html`/`client.ts` runtime-config contract"; it turns out not to,
 * because the Bun browser host attaches the header on the way
 * through and no build artifact ever carries a token. See
 * `dev-credentials.ts` for why an authenticated harness became
 * necessary once `resolvePrincipal()` started reporting the server's real
 * answer instead of optimistically granting every scope. Scoped surfaces
 * (schedules, storage, system, workers) work here now; they used to 401.
 * This is a dev-only harness serving a `MemoryStorage`-backed engine on
 * localhost; there is no real access boundary to preserve for what IS
 * reachable.
 *
 * **Seed-after-serve, not serve-after-seed.** `serve()` binds the port and
 * wires event broadcasting synchronously (no `await` inside it), so calling
 * `seed(engine)` immediately after — rather than before — `serve()` means
 * every fixture workflow's lifecycle events fire AFTER a live listener
 * exists, landing them in the fleet feed's replay buffer exactly like a
 * production workflow started after boot would. Seeding first would trade
 * that away: `wireEventBroadcasting()`'s fleet feed only captures events
 * from the moment its listener attaches (`createFleetEventFeed`,
 * `weft/src/server/fleet-event-feed.ts`), so pre-boot events would be
 * permanently invisible to `/api/v1/events/sse` replay — and the shell's
 * notification bell deliberately renders that replay backlog on first
 * connect (`src/app/engine-status.svelte.ts`), so an empty backlog would be
 * a visible dev/demo regression, not just an implementation detail.
 *
 * The cost of that ordering: `serve()` exposes no pre-request hook, so
 * there is a real (small, single-digit-millisecond) window between the port
 * accepting connections and `seed()` finishing where `GET /v1/health` can
 * already answer while the fixtures are still being written. This is
 * ordinary `serve()` boot behavior — indistinguishable from a production
 * deployment's own empty-then-populated startup — not a bug specific to
 * this harness. It is a real behavior change from the previous revision of
 * this file, which hand-built a `readyPromise` gate in front of its own
 * `Bun.serve()` fetch handler so no response (including health) could beat
 * `seed()`. Reproducing that exact guarantee on top of `serve()` would mean
 * wrapping it in another app-local `Bun.serve()` proxy — the composition
 * this rewrite exists to delete. Documented here rather than silently
 * dropped: if a caller needs a hard readiness guarantee, poll
 * `GET /api/v1/workflows` for a non-empty result instead of trusting
 * `/v1/health` alone.
 */
import { sveltePlugin } from '@lostgradient/testing';
import { AUTHORIZATION_SCOPES, dashboard, Engine } from '@lostgradient/weft';
import { existsSync, renameSync, rmSync } from 'node:fs';
import { join } from 'node:path';

import { DEV_API_KEY } from './dev-credentials.ts';

import {
  DYNAMIC_SOURCE_FAILING_REVISION,
  DYNAMIC_SOURCE_LOADABLE_REVISION,
  DYNAMIC_SOURCE_WORKFLOW_NAME,
  seedDynamicSources,
} from '../../fixtures/dynamic-sources.ts';
import { seedWorkflowRevisions } from '../../fixtures/workflow-revisions.ts';
import { seed, workflows } from '../../fixtures/workflows.ts';

const PORT = 7233;
const DASHBOARD_DIRECTORY = join(import.meta.dir, 'build', 'dashboard');

/**
 * Compile the console into `dashboard()`'s layout unless a previous run
 * already did. The output is written beside the target and renamed into
 * place, so an interrupted compile never leaves an `index.html` behind that a
 * later run would mistake for a finished one.
 */
async function ensureDashboardBuild(directory: string): Promise<void> {
  if (existsSync(join(directory, 'index.html'))) return;
  const partialDirectory = `${directory}.partial`;
  rmSync(partialDirectory, { recursive: true, force: true });
  console.log(`Compiling the console into ${directory} (delete it to recompile)…`);
  const result = await Bun.build({
    entrypoints: [join(import.meta.dir, 'index.html')],
    outdir: partialDirectory,
    conditions: ['browser', 'svelte'],
    define: { 'process.env.NODE_ENV': JSON.stringify('development') },
    format: 'esm',
    publicPath: '/',
    naming: {
      entry: '[name].[ext]',
      chunk: 'assets/[name]-[hash].[ext]',
      asset: 'assets/[name]-[hash].[ext]',
    },
    target: 'browser',
    plugins: [sveltePlugin({ generate: 'client', injectCss: true, development: true })],
    optimizeImports: ['@lostgradient/cinder'],
    sourcemap: 'none',
    splitting: true,
  });
  const problems = result.logs.filter((log) => log.level === 'error' || log.level === 'warning');
  if (!result.success || problems.length > 0) {
    throw new AggregateError(problems, 'Console compilation failed');
  }
  rmSync(directory, { recursive: true, force: true });
  renameSync(partialDirectory, directory);
}

await ensureDashboardBuild(DASHBOARD_DIRECTORY);

const engine = await Engine.create({ workflows });

const server = dashboard({
  engine,
  port: PORT,
  auth: { apiKeys: [DEV_API_KEY], defaultApiKeyScopes: AUTHORIZATION_SCOPES },
  distDir: DASHBOARD_DIRECTORY,
});

await seed(engine);

// After `seed()` starts `order-processing` at least once, its eager
// registration has already installed + activated the original revision
// (`ensureWorkflowCatalogReady`) — installing the deliberately
// incompatible candidate now leaves it installed-but-not-active, exactly
// the "second installed revision" WFT-115's Revisions panel e2e test
// needs (`fixtures/workflow-revisions.ts`'s own module doc).
await seedWorkflowRevisions(engine);

// WFT-116: two `registerSource()` revisions of one dynamic workflow name,
// neither loaded — see `fixtures/dynamic-sources.ts` for why each state
// matters. `registerSource()` refuses a name already registered eagerly, and
// this name deliberately is not one.
seedDynamicSources(engine);

console.log(`weft dev server and console listening on ${server.url}`);
console.log(
  'Seeded fixture workflows: order-processing, payment-failing, long-sleeper, review-gate, ' +
    'signal-stepped, checkout-coordination, trip-booking-saga, sandbox-session, ' +
    'ship-package-async, fulfillment-parent (+ validate-shipment, monitor-delivery), ' +
    'audit-trail-sweep, customer-outreach-campaign (x4), ' +
    'timeout/cancellation/resource/system-failure-demo, content-review (x3), ' +
    'inventory-sync-sweep, nightly-reconciliation (start-new continuation chain)',
);
console.log(
  'Seeded schedules: inventory-sync-every-5-minutes (active), nightly-inventory-audit (paused)',
);
console.log(
  'Seeded workflow catalog: order-processing has a second, installed-but-inactive, ' +
    'deliberately incompatible revision "order-processing-candidate-2" — Registry > Revisions.',
);
console.log(
  `Seeded dynamic workflow source: ${DYNAMIC_SOURCE_WORKFLOW_NAME} at ${DYNAMIC_SOURCE_LOADABLE_REVISION} ` +
    `(idle, preloads cleanly) and ${DYNAMIC_SOURCE_FAILING_REVISION} (idle, loader rejects) — ` +
    'System > Registry > Dynamic workflow sources. It appears in the source list while remaining ' +
    'absent from the registered-definitions table; weft.system.registry lists eager registrations only.',
);
console.log(
  'Fleet SSE (/api/v1/events/sse), per-workflow SSE/WebSocket tails ' +
    '(/api/v1/workflows/:id/events/sse, /api/v1/workflows/:id/watch), and JSON-RPC ' +
    '(/api/jsonrpc) are all live against real engine state.',
);
