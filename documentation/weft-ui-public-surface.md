# Weft UI public surface

COR-1447. This document records the published surface of `@lostgradient/weft/ui`, as the owner (Steve Kinney) decided it on 2026-10-13. A published subpath fixes an API, so each value below binds the issues that implement it: COR-1449 (the `./ui` entry and the renames), COR-1450 (the dashboard build and its size check), COR-1452 (the mirror surface, the peers, and the release), and COR-1454 (the Weft mirror's build). It replaces COR-1293, which asked the same questions for a separate package and was canceled without a decision.

The architecture is settled by the owner rulings on the Weft UI project (P-COR-82): the UI ships inside `@lostgradient/weft`, `dashboard()` in Weft's root entry serves the prebuilt dashboard, and `@lostgradient/weft/ui` exports the Svelte components. Engine code never imports the UI.

Evidence was gathered at corvidae `bd09f203` with Bun 1.4.2 and Node 26.9.0, except the size measurement, which used COR-1456's branch (see [Size budget](#size-budget)). The evidence predates COR-1455, which moved the UI from its own workspace into Weft; source paths below are given at their post-move locations under `packages/weft/src/ui/…` (the move changed no file's content), and the published paths use the same layout.

## Decisions at a glance

| Decision | Choice |
| --- | --- |
| `./ui` export list | The 36 names in [Export list](#export-list): every name the four shared layers and `lib/config.ts` export, `WeftDashboard`, and seven `…View` components. Nothing else. |
| Shared layers | The client provider, the TanStack Query helpers, the router, and the live-source plumbing are public Weft API under semver. |
| Renames | `WeftConsole` becomes `WeftDashboard`. The router's class `ConsoleRouter` becomes `DashboardRouter`. |
| Export shape | Cinder's published root conditions, in Cinder's order: `node`, `types`, `import`, `svelte`, `browser`, `default`. COR-1454 builds a compiled client build, a server build, and declarations. |
| CSS | `./ui` keeps its side-effect stylesheet import. Weft's `sideEffects` changes from `false` to `["**/*.css"]`. |
| `./ui/static` | No such subpath. The prebuilt files ship in `dashboard/`, which `dashboard()` serves by default; `distDir` covers custom locations. |
| Optional peers | Declared in corvidae's `packages/weft/package.json`: `svelte` `>=5.56.0 <6`; `@lostgradient/cinder` and `@lostgradient/markdown` as `workspace:*`; `@tanstack/svelte-query`, `@lucide/svelte`, `cron-parser`, `@shikijs/langs`, and `@shikijs/themes` as `catalog:`. All optional. |
| Size budget | At most 4,500,000 bytes on disk and at most 850,000 bytes of gzipped JavaScript, CSS, and HTML for `packages/weft/dashboard/`. |

## Export list

**Decision:** `@lostgradient/weft/ui` exports exactly the names in the block below. The four shared layers, `lib/client.ts`, `lib/query.ts`, `lib/router.svelte.ts`, and `lib/live-source/index.ts`, are public Weft API under semver, as is every other name in the block. The runtime configuration in `lib/config.ts` stays exported, as today. Sub-views and shell parts stay private.

**Rationale:** The owner ruled in the COR-901 session (recorded on COR-901's "Decision recorded (2026-10-13)" comment, in corvidae#189, and on COR-1447) that the four layers are public so a separate Bureau UI application can reuse them. The components are the whole application and one view per dashboard area. The layer names were enumerated with the TypeScript checker from `packages/weft/src/ui/lib/{client.ts,query.ts,router.svelte.ts,live-source/index.ts,config.ts}` (the same modules, before the move) at `bd09f203`.

```text
computeReconnectDelayMs
createClient
createQueryClient
DashboardView
FleetEventFilter
FleetEventFrame
FleetEventSource
FleetEventSourceConfig
getClient
isTerminalWorkflowEventType
LiveSource
LiveSourceStatus
matchRoute
PollingSource
PollingSourceOptions
provideClient
queryKeys
readRuntimeConfig
ReviewsView
RouteMatch
router
RouteState
SchedulesView
setApiKey
StorageView
SystemView
WeftDashboard
WeftUiRuntimeConfig
WorkersView
WorkflowAggregateGroupBy
workflowDetailPath
WorkflowEventTailOpener
WorkflowsView
workflowStatusForEventType
WorkflowTailSource
WorkflowTailSourceOptions
```

### How the list is read

- The block above is the only fenced `text` block in this document. COR-1449's test reads it and compares it, as a set, with the export names of `packages/weft/src/ui/index.ts`. Order carries no meaning: the names are sorted alphabetically, ignoring case.
- Type-only exports are listed by their bare name, with no `type` prefix, exactly as value exports are. The table below marks which they are. Because a runtime `Object.keys(module)` cannot see type-only exports, COR-1449's test must enumerate the entry's exports with the TypeScript checker (for example `checker.getExportsOfModule`), as `scripts/mirror/declaration-agreement.ts` already does to tell values from types.
- `index.ts` must not re-export anything that is not in the block.

| Name | Kind | Source module (pre-move) |
| --- | --- | --- |
| `createClient`, `setApiKey`, `provideClient`, `getClient` | value | `lib/client.ts` |
| `createQueryClient`, `queryKeys` | value | `lib/query.ts` |
| `WorkflowAggregateGroupBy` | type | `lib/query.ts` |
| `router`, `matchRoute`, `workflowDetailPath` | value | `lib/router.svelte.ts` |
| `RouteMatch`, `RouteState` | type | `lib/router.svelte.ts` |
| `FleetEventSource`, `WorkflowTailSource`, `PollingSource`, `computeReconnectDelayMs`, `isTerminalWorkflowEventType`, `workflowStatusForEventType` | value | `lib/live-source/index.ts` |
| `LiveSource`, `LiveSourceStatus`, `FleetEventFilter`, `FleetEventFrame`, `FleetEventSourceConfig`, `WorkflowEventTailOpener`, `WorkflowTailSourceOptions`, `PollingSourceOptions` | type | `lib/live-source/index.ts` |
| `readRuntimeConfig` | value | `lib/config.ts` |
| `WeftUiRuntimeConfig` | type | `lib/config.ts` |
| `WeftDashboard` | component | `app/app.svelte` (exported today as `WeftConsole`) |
| `DashboardView`, `WorkflowsView`, `ReviewsView`, `WorkersView`, `SchedulesView`, `StorageView`, `SystemView` | component | `routes/{dashboard,workflows,reviews,workers,schedules,storage,system}/index.svelte` |

The five modules export 28 names: 4 from `client.ts`, 3 from `query.ts`, 5 from `router.svelte.ts`, 14 from `live-source/index.ts`, and 2 from `config.ts`. Of those, 12 are type-only. With `WeftDashboard` and the seven views the list has 36 names. `live-source/cache-integration.ts` is not part of the surface, because `live-source/index.ts` deliberately does not re-export it. `ConsoleRouter` is not exported today and does not become an export under its new name.

### Components

- `WeftDashboard` is the whole application, renamed from `WeftConsole`.
- Each view is today's `routes/<area>/index.svelte`. None takes props, and all read the client and router from context. The `View` suffix follows `routes/workers/` (`fleet-view.svelte`, `worker-list-view.svelte`).
- `DashboardView` is the overview page at `/`, which the sidebar labels "Dashboard" (`app/shell/sidebar.svelte`). `/workflows` and `/workflows/:id` both render `WorkflowsView` (`app/routes.ts`).

### Renames

- `WeftConsole` becomes `WeftDashboard` (COR-1449).
- The router's class, `ConsoleRouter` in `lib/router.svelte.ts`, becomes `DashboardRouter`, because it appears in the published declarations as the type of `router` (COR-1449).

### What is not exported

A type that a listed export's signature mentions without the list naming it is public only as structure reachable through that export. Examples are `RouteDefinition` (in `RouteState` and `matchRoute`), `WorkflowListQuery` (in `queryKeys.workflows`), and `DashboardRouter` (the type of `router`). Changing such a type's shape is a semver change to the export that exposes it, but importing it by name is not supported. Shell parts such as `ToastHost`, and the providers in `lib/scopes.svelte.ts` and `app/engine-status.svelte.ts`, stay private. Adding a name later is a compatible change, and removing one is not.

### Semver

Every listed name is public API under semver, including the four shared layers. A change that would break a consumer of a listed name, or of a type reachable through one, ships only in a release semver marks as breaking. While Weft's major version is 0 (its last published version is 0.27.17 per `scripts/mirror/package-map.json`), that is a minor-version bump. Behavior the source already documents as frozen is part of that contract: the query-key shapes, `createQueryClient`'s defaults, the router's matching rules, and the six `LiveSourceStatus` states.

## Export shape

**Decision:** The published `./ui` entry is exactly:

```json
{
  "node": "./dist/ui/server/index.js",
  "types": "./dist/ui/index.d.ts",
  "import": "./dist/ui/index.js",
  "svelte": "./src/ui/index.ts",
  "browser": "./src/ui/index.ts",
  "default": "./dist/ui/index.js"
}
```

These are the same conditions, in the same order, as Cinder's published root entry (`npm view @lostgradient/cinder exports`, 0.27.1). The entry commits the Weft mirror's build (COR-1454) to three outputs for `./ui`: a compiled client build at `dist/ui/index.js`, a server (SSR) build at `dist/ui/server/index.js`, and declarations at `dist/ui/index.d.ts`.

**Rationale:** One export shape across Lost Gradient's Svelte packages, already proven by Cinder's mirror build and consumer smoke.

### Resolution, measured

Resolvers take the first key, in object order, whose condition they match, so `import` ahead of `svelte` and `browser` decides what ESM consumers get. Measured with a scratch package carrying this exact entry, Bun 1.4.2 and Node 26.9.0:

| Resolver | Resolves `./ui` to |
| --- | --- |
| `bun` runtime, with or without `--conditions svelte` or `--conditions browser` | `./dist/ui/server/index.js` (`node`) |
| `node`, with or without `--conditions browser` | `./dist/ui/server/index.js` (`node`) |
| `Bun.build`, `target: 'browser'`, with or without `conditions: ['browser', 'svelte']` | `./dist/ui/index.js` (`import`) |
| `Bun.build`, `target: 'bun'` or `target: 'node'` | `./dist/ui/server/index.js` (`node`) |

Consequences for the implementing issues:

- **Browser bundlers get the compiled client build**, not source. That is also how Cinder's root entry resolves today. The `svelte` and `browser` source targets are reached only by a resolver that matches neither `node` nor `import`.
- **The server build must import cleanly under Node and plain Bun with no optional peer installed.** `scripts/mirror/packaging.ts` puts every entry with a `node`, `import`, `require`, or `default` condition in the Node smoke list (`nodeImportableSpecifierEntries`), COR-1452 requires both the Bun and the Node consumer smoke to import `./ui`, and the smoke's consumer project installs only the packed tarballs. Bun 1.4.2 did not install a `file:` dependency's optional peer when measured. Three things stand in the way today:
  - `lib/router.svelte.ts` ends with `export const router = new ConsoleRouter()`, whose field initializer reads `window.location` and whose constructor calls `window.addEventListener`, so importing the entry without a DOM throws `ReferenceError: window is not defined`.
  - Node 26.9.0 cannot import `@tanstack/svelte-query` at all: `import('@tanstack/svelte-query')` fails with `ERR_UNKNOWN_FILE_EXTENSION` on its `.svelte` re-exports.
  - `./ui`'s side-effect `import './styles/index.css'` is not importable under Node.
- **Declarations** at `dist/ui/index.d.ts` must pass the mirror's `attw` gate, which treats `internal-resolution-error` as fatal (`checkTarball` in `scripts/mirror/packaging.ts`). svelte2tsx's `emitDts` is the emitter Cinder's mirror build uses for `.svelte` files (`scripts/mirror/declaration-portability.test.ts`).

[Open questions](#open-questions-for-the-owner) 3 and 4 record the defaults this document takes for these constraints.

### Published files

Weft is `packedBy: "files"` (`scripts/mirror/package-surface.json`), so every target must be inside its `files` allowlist (`isExpectedPackRewrite` in `scripts/mirror/surface.ts` excuses only `pack-script` packages). COR-1452 adds `dashboard/**`, the `dist/ui` outputs, and the `src/ui` files the `svelte` and `browser` targets reach, and excludes every test-only file under `src/ui`: `*.test.*`, `*.test-support.*`, `*.test-harness.svelte`, `*.test-host.svelte` (`lib/active-revision-comparisons.test-host.svelte` exists today), and everything under `src/ui/tests/` and `src/ui/fixtures/`.

## CSS

**Decision:** `./ui` keeps its side-effect `import './styles/index.css'` (today the first line of `packages/weft/src/ui/index.ts`). Weft's `sideEffects` changes from `false` to `["**/*.css"]` in both `packages/weft/package.json` and Weft's entry in `scripts/mirror/package-surface.json`, the value Cinder publishes. There is no separate stylesheet subpath.

**Rationale:** For JavaScript modules `["**/*.css"]` is identical to `false`, so every engine and UI module stays tree-shakable. It only stops bundlers that honor `sideEffects` from dropping the stylesheet import, and with it the UI's styles. Engine modules import no CSS, so engine consumers see no change.

Consequences:

- Importing anything from `./ui` brings the UI's stylesheet. `packages/weft/src/ui/styles/index.css` carries document-level rules (`html, body { height: 100% }`, `body { margin: 0 }`, and `:root` color-scheme), so a host page that imports only `queryKeys` gets those rules too.
- Components that import their own stylesheets keep working (`routes/workflows/detail/workflow-detail.svelte` imports `./workflow-detail.css`).
- The compiled client build `dist/ui/index.js` keeps the stylesheet import for the consumer's bundler. The server build cannot carry it (see [Resolution, measured](#resolution-measured)).

## `./ui/static`

**Decision:** There is no `./ui/static` subpath. The prebuilt files ship in the package's `dashboard/` directory. `dashboard()` from Weft's root entry serves it by default (COR-1448), and its `distDir` option covers custom locations.

**Rationale:** The project rulings defer host adapters and path-prefix mounting. `router.href` is the identity, "a seam for a future base path" (`packages/weft/src/ui/lib/router.svelte.ts`), so the files work only at an origin root, which `dashboard()` already serves. Because no subpath names them, the file layout inside `dashboard/` (COR-1450's hashed output) is not public API.

## Optional peer dependencies

**Decision:** corvidae's `packages/weft/package.json` declares these `peerDependencies`, each `optional: true` in `peerDependenciesMeta`, and the mirror renders them (COR-1452):

| Peer | Declared in corvidae as | Rendered in the published manifest as |
| --- | --- | --- |
| `svelte` | `>=5.56.0 <6` | The same literal range, Cinder's own published peer range |
| `@lostgradient/cinder` | `workspace:*` | `^` its `lastPublishedVersion` in `scripts/mirror/package-map.json` |
| `@lostgradient/markdown` | `workspace:*` | `^` its `lastPublishedVersion` in `scripts/mirror/package-map.json` |
| `@tanstack/svelte-query` | `catalog:` | The root catalog's range |
| `@lucide/svelte` | `catalog:` | The root catalog's range |
| `cron-parser` | `catalog:` | The root catalog's range |
| `@shikijs/langs` | `catalog:` | The root catalog's range |
| `@shikijs/themes` | `catalog:` | The root catalog's range |

**Rationale:** These are the packages that non-test UI source imports, apart from `@lostgradient/weft` itself. `@shikijs/langs` and `@shikijs/themes` are there because `lib/code-highlighter.ts` imports them; today they resolve only through hoisting from Cinder's and Markdown's own dependencies. Declaring the peers in corvidae makes `packages/weft/package.json` the single source of Weft's peers, so internal peers follow each release instead of a hand-maintained range in the Weft repository.

Notes:

- `@lucide/svelte` replaces Lucide's deprecated Svelte package. At `bd09f203` the root catalog still declared only the deprecated package (`^0.577.0`), so this peer could not be declared until COR-1460 added `@lucide/svelte` (`^1.56.0`) to the catalog. COR-1452 is blocked by COR-1460 for that reason.
- At `bd09f203` the other catalog ranges are `@tanstack/svelte-query` `^6.2.1`, `cron-parser` `^5.6.2`, `@shikijs/langs` `^3.21.0`, and `@shikijs/themes` `^3.21.0`. The published ranges follow the catalog at each sync.
- The minimum of every `@lostgradient/cinder` range Weft publishes must be at least the first Cinder release that contains COR-1456 (COR-1452). A lower floor brings back the 13 MB dashboard the project measured.
- `dashboard()` serves a fully built dashboard and needs none of these peers. Engine-only installs get none of them.
- Weft's six storage-driver peers stay as published; COR-1452 moves them into `packages/weft/package.json` beside these.

## Size budget

**Decision:** The prebuilt dashboard that `packages/weft/scripts/build-dashboard.ts` writes to `packages/weft/dashboard/` (COR-1450) is held to two limits, which `packages/weft/scripts/check-dashboard-size.ts` enforces:

- **At most 4,500,000 bytes on disk.** The sum of the byte sizes (`stat` size, not allocated blocks) of every file under `packages/weft/dashboard/`.
- **At most 850,000 bytes gzipped.** The sum, over every `.js`, `.css`, and `.html` file under `packages/weft/dashboard/`, of `Bun.gzipSync(bytes, { level: 9 }).byteLength`, each file compressed on its own (the equivalent of `gzip -9`).

The budget does not cover `dist/ui/` or the shipped `src/ui` files.

### Measured

| Build | Files | Bytes on disk | Gzipped JavaScript, CSS, and HTML | Grammars | Themes |
| --- | --- | --- | --- | --- | --- |
| COR-1456 implementation, `f8d6df87` | 58 | 3,825,992 | 744,955 | `json`, `typescript` | `github-dark`, `github-light` |
| Owner's measurement, 2026-10-13, COR-1456 simulated | 62 | 3,815,595 | 730,341 | `json`, `typescript` | `github-dark`, `github-light` |
| Simulation reproduced at `6be120d3` | 62 | 3,815,694 | 744,732 | `json`, `typescript` | `github-dark`, `github-light` |

Against the measured COR-1456 build, the budget leaves 17.6% headroom on disk (674,008 bytes) and 14.1% gzipped (105,045 bytes). That room absorbs ordinary UI growth and variation in Bun's minifier and chunking between versions. A regression that brings back Shiki's full registries (13 MB across 403 files and 2.17 MB gzipped, as measured without COR-1456) exceeds both limits by a wide margin.

The measured build's 58 files are 53 JavaScript chunks (2,152,420 bytes), 3 CSS files (1,206,469 bytes), `index.html` (493 bytes), and Shiki's Oniguruma engine `onig.wasm` (466,610 bytes, counted on disk but not in the gzipped sum). Under the gzip default level the same files total 752,377 bytes.

Why the numbers differ:

- **Files and bytes on disk.** The owner simulated COR-1456 by stubbing `shiki/langs` and `shiki/themes`. Reproduced that way at `6be120d3`, the build matches the owner's file count exactly and the owner's disk size within 99 bytes. The real change at `f8d6df87` emits 4 fewer files, because Cinder's default-highlighter module and the chunks for the stubbed registries no longer exist. It is 10,298 bytes larger, from source changes between `6be120d3` and COR-1456's base `6daabec1` (70 changed files across Cinder, Markdown, and the UI) plus COR-1456's own code.
- **Gzipped bytes.** The owner's gzip method was not recorded. The reproduced simulation gives 744,732 bytes under the per-file level-9 method above, 14,391 more than the owner's 730,341. A single gzip stream over all the files concatenated gives 732,809, so the owner's figure most likely compressed files together rather than one at a time. The real change adds only 223 gzipped bytes over the reproduced simulation. The per-file method is what a server pays when it compresses each response, so it is the one this budget uses.

### Method, for COR-1450 to reproduce

The measurement compiled the source the weft-ui development host compiles: entry `packages/weft/scripts/ui-browser/index.html` (which loads `main.ts` and mounts the app; before the move it was the UI workspace's `scripts/browser/index.html`), at corvidae `f8d6df87` (branch `cor-1456`), with Bun 1.4.2. It called `Bun.build` with the options of `buildBrowser` in `testing/testing/src/build-browser.ts`, switched to production and minified:

```ts
await Bun.build({
  entrypoints: ['packages/weft/scripts/ui-browser/index.html'],
  outdir,
  conditions: ['browser', 'svelte', 'unwasm'],
  define: { 'process.env.NODE_ENV': JSON.stringify('production') },
  format: 'esm',
  publicPath: '/',
  target: 'browser',
  plugins: [wasmPlugin, sveltePlugin({ generate: 'client', injectCss: true, development: false })],
  optimizeImports: ['@lostgradient/cinder'],
  sourcemap: 'none',
  splitting: true,
  metafile: true,
  minify: true,
});
```

`sveltePlugin` is `testing/testing/src/svelte-plugin.ts` (COR-1455 copies it to `packages/weft/scripts/lib/svelte-plugin.ts`), and `wasmPlugin` is the unexported plugin of the same name in `build-browser.ts`. The build logged no warnings. File counts and sizes came from `result.outputs`, which matched a walk of the output directory. Grammar and theme sets came from the keys of the metafile's `outputs[*].inputs`, classified by `/@shikijs\/langs\/dist\/([^/]+)\.mjs$/` and `/@shikijs\/themes\/dist\/([^/]+)\.mjs$/`.

Two notes for COR-1450:

- `buildBrowser` writes `metafile.json` into its output directory. For this build that file is 2,330,846 bytes, which would push `dashboard/` past the disk limit and ship in the tarball. The dashboard build must write its metafile somewhere else, or not at all.
- The three CSS files each repeat most of the same rules (1,926 of their `}`-terminated blocks appear in more than one file). If the dashboard ever approaches the budget, that duplication is the first place to look.

## Consequences for the issues this blocks

- **COR-1449.**
  - `packages/weft/src/ui/index.ts` exports exactly the [list](#export-list), keeps `import './styles/index.css'`, and re-exports the seven route views under their `…View` names.
  - `WeftConsole` becomes `WeftDashboard`, and `ConsoleRouter` becomes `DashboardRouter`.
  - Its test reads the `text` block above through the TypeScript checker, and a test asserts the entry imports its stylesheet.
- **COR-1450.** Builds `dashboard/` from source with the [method](#method-for-cor-1450-to-reproduce) above, minus the metafile in the output, and enforces the two [limits](#size-budget).
- **COR-1452.**
  - Writes the `./ui` entry exactly as above, `sideEffects: ["**/*.css"]` in both places, and the `files` additions, with no `./ui/static`.
  - Declares the [optional peers](#optional-peer-dependencies) in `packages/weft/package.json`.
- **COR-1454.** Builds `dist/ui/index.js`, `dist/ui/server/index.js`, and `dist/ui/index.d.ts` to satisfy the constraints in [Resolution, measured](#resolution-measured).

## Open questions for the owner

These carry over from the draft of this document. Each states the default this document takes if the owner says nothing.

1. **Rendering a view outside `WeftDashboard`.** Every view's component tree reads the principal store (`getPrincipalStore()`, for example in `routes/storage/index.svelte`), every view except the storage view reads the shared fleet event source (`getFleetEventSource()`), and both throw when no ancestor provided them. Today only `app/shell/shell.svelte` provides them. `createQueryClient`'s default `mutations.onError` also reports `showToast() called before <ToastHost> mounted` as an error when no `<ToastHost>` is mounted (`app/toast-host.svelte`). None of `providePrincipalStore`, `resolvePrincipal`, `provideFleetEventSource`, or `ToastHost` is exported. **Default:** the export list stays as decided, and COR-1449 makes each view render with only what a host can supply from the list (a client from `provideClient`, a `QueryClientProvider` around `createQueryClient()`, and the router), with the view supplying its own principal store, fleet event source, and toast handling when no ancestor provided them. A test renders each view outside `WeftDashboard`.
2. **Names left out.** The owner's list answers part of this: `readRuntimeConfig` and `WeftUiRuntimeConfig` are exported. `RouteDefinition`, `WorkflowListQuery`, `getPrincipalStore`, and `getFleetEventSource` are still not. **Default:** they stay out, public only as structure reachable through a listed export. Any of them can be added later as a compatible change.
3. **What the compiled builds bundle.** The owner's export shape replaces the draft's self-contained `bun` target, but the same constraint returns for the server build: the Bun and Node consumer smokes import `./ui` from the packed tarball with no optional peer installed, and Node cannot import `@tanstack/svelte-query`. The draft's probe of a self-contained, minified, code-split server build of its export list, at `6be120d3` without COR-1456, emitted about 2.3 MB of JavaScript. **Default:** COR-1454's server build bundles every dependency except `@lostgradient/weft` and runtime built-ins, carries no CSS import, and is compiled with Svelte `generate: 'server'`. The client build keeps `svelte` and the other peers external, so a consumer's tree shares one Svelte runtime and its context. The `svelte` and `browser` source targets stay in the map as decided, although ESM resolvers reach `import` first.
4. **Requirements the blocked issues do not state yet.** COR-1449 does not require `router` to be importable without a DOM, which the server build and both smokes need. COR-1452's tarball exclusions do not list `*.test-host.svelte`, and its unpacked-size criterion (the previous release plus 4,500,000 bytes plus the packed `src/ui` files) does not allow for `dist/ui/`. **Default:** COR-1449 changes `router` to read `window` on first use rather than at module evaluation, keeping its name, type, and members, and adds a test that imports the entry with no DOM. COR-1452 excludes `*.test-host.svelte` and adds the size of `dist/ui/` to its unpacked-size allowance.
5. **Values that wait on other work.** The owner decided the size budget, and this document records it with the measurement above. The Cinder minimum still waits on the version COR-1456 records after the Cinder mirror's release. **Default:** no Weft release publishes `./ui` until `scripts/mirror/package-map.json` records a Cinder release that contains COR-1456, so the rendered `workspace:*` peer and development ranges start at that version or later.
