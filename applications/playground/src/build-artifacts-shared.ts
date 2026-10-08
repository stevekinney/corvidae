import type { BuildArtifact } from 'bun';

import { curatedShikiAdapterPlugin } from './curated-shiki-adapter-plugin.ts';
import { playgroundSveltePlugin } from './playground-svelte-plugin.ts';

/**
 * Family identifier used by `findArtifactForFamily` to constrain which
 * artifacts a given route may serve. Each family corresponds to one of the
 * four artifact maps below.
 */
export type ArtifactFamily = 'page' | 'shell' | 'scenario' | 'fixture';

/**
 * Prefixes that identify a hashed entry artifact for each bundle family.
 * Bun's `naming` template uses the entrypoint basename for `[name]`, and
 * each family's compile step writes its entry basename with one of these
 * prefixes (see `compilePageBundleArtifacts`, `compileShellBundleArtifacts`,
 * and `buildBundle`). Content-hashed peer chunks (e.g. `core-abc123.js`,
 * `commonmark-def456.js`) do NOT have any of these prefixes — they're
 * emitted by Bun's code-splitter without a family label.
 */
export const ENTRY_PREFIXES: Record<ArtifactFamily, string> = {
  page: 'page-',
  shell: 'shell-',
  scenario: 'bundle-',
  fixture: 'fixture-',
};

/**
 * Per-family `publicPath` baked into each emitted chunk's import URL.
 *
 * The page and scenario families share `/page-bundle/` because scenario chunks
 * have always resolved through that route — there is no separate scenario
 * bundle route. Shell gets its own `/shell-bundle/` so any future dynamic
 * import in the shell tree resolves through the shell route.
 */
export const PUBLIC_PATH_BY_FAMILY: Record<ArtifactFamily, string> = {
  page: '/page-bundle/',
  shell: '/shell-bundle/',
  scenario: '/page-bundle/',
  fixture: '/fixture-bundle/',
};

/**
 * Shared Bun.build options used by every family.
 *
 * Each compile site supplies its own `publicPath` so that dynamic-import URLs
 * emitted by the splitter resolve through the matching route. The shell entry
 * has no dynamic imports today, but parameterizing `publicPath` keeps the
 * route boundary honest the moment a shell descendant ever uses `import()`,
 * rather than relying on `findArtifactForFamily`'s cross-family fallback to
 * paper over chunks that bake in the wrong URL.
 *
 * Putting chunks in a `chunks/` subdir triggers a Bun publicPath quirk where
 * peer-chunk imports get the subdirectory stripped from their URL, so the
 * naming template stays flat.
 */
export const SHARED_BUILD_OPTIONS = {
  plugins: [
    playgroundSveltePlugin({ generate: 'client', injectCss: true }),
    curatedShikiAdapterPlugin(),
  ],
  target: 'browser',
  format: 'esm',
  // The workspace component packages (`@lostgradient/cinder`, `chat`, `editor`)
  // and `@lostgradient/markdown` each declare one `"."` export that points at
  // `./src/index.ts`, so they resolve to source under any condition set and
  // `svelte` is only needed for dependencies that publish a `svelte` condition.
  // The page bundles themselves are browser bundles, so we use `browser` and
  // avoid the `bun` condition: a dependency such as
  // `@lostgradient/environmentalist` maps `bun` to its Node build, which does
  // not belong in a browser bundle.
  conditions: ['browser', 'svelte'],
  splitting: true,
  naming: {
    entry: '[name]-[hash].js',
    // Use a distinct prefix for shared chunks so they cannot collide with
    // the entry's `[name]` template. Some Bun builds on Linux emit shared
    // chunks where `[name]` resolves to the entry basename (e.g.
    // `page-code-block`), and when multiple such chunks exist in one build
    // they share the entry's name and race to the same output path. A
    // distinct `chunk-` prefix sidesteps this entirely while keeping chunks
    // in the flat top-level layout (a `chunks/` subdir triggers a separate
    // Bun publicPath quirk where the subdir is stripped from peer-chunk
    // import URLs).
    chunk: 'chunk-[hash].js',
    asset: '[name]-[hash][ext]',
  },
} as const satisfies Omit<Parameters<typeof Bun.build>[0], 'entrypoints' | 'publicPath'>;

/**
 * Per-family artifact maps: artifact.path → JS source. Each family owns its
 * own map so the watcher rebuild can preserve one family's previously-published
 * artifacts when another family's rebuild fails. Routes resolve a filename by
 * checking the most-specific family first, then falling through to the others
 * (chunks can be shared between families via dedupe-by-content hash, and the
 * URL itself doesn't carry the family).
 *
 * All artifacts share a flat namespace under `/page-bundle/` and `/shell-bundle/`
 * URLs — there is no `chunks/` subdirectory; the Bun `naming` config emits
 * everything as `[name]-[hash].js` at the same level as entries. Entries can
 * never collide because they use disjoint `page-` / `bundle-` / `shell-`
 * basename prefixes.
 */
export const pageArtifactByPath = new Map<string, string>();

/**
 * The pages that published each page-family artifact, by artifact path. Chunks are
 * content-hashed and shared across pages, so an artifact is dropped only when the
 * last page that published it lets go. Without this, an example-scoped
 * invalidation could remove only the page's entry artifact, and every save of the
 * same example left the superseded scenario chunk resident and servable until a
 * broader invalidation or a restart.
 */
const pageArtifactOwners = new Map<string, Set<string>>();

/**
 * Publish every artifact one page build emitted into the page family's map and
 * record `componentName` as an owner of each.
 *
 * A build that lost a race with an invalidation still publishes: the entry it hands
 * back imports content-hashed chunk URLs that must resolve for the request that
 * triggered it. Those artifacts are owned like any other, so the page's next
 * invalidation frees them.
 */
export function publishPageArtifacts(
  componentName: string,
  artifacts: ReadonlyMap<string, string>,
): void {
  for (const [path, code] of artifacts) {
    pageArtifactByPath.set(path, code);
    let owners = pageArtifactOwners.get(path);
    if (owners === undefined) {
      owners = new Set();
      pageArtifactOwners.set(path, owners);
    }
    owners.add(componentName);
  }
}

/**
 * Let go of everything `componentName` published, dropping each artifact that no
 * other page still owns. A page that is built again republishes what it needs.
 */
export function evictPageArtifacts(componentName: string): void {
  for (const [path, owners] of pageArtifactOwners) {
    if (!owners.delete(componentName) || owners.size > 0) continue;
    pageArtifactOwners.delete(path);
    pageArtifactByPath.delete(path);
  }
}

/** Drop every page artifact and every ownership record, as a shell or component change must. */
export function clearPageArtifacts(): void {
  pageArtifactByPath.clear();
  pageArtifactOwners.clear();
}

export const shellArtifactByPath = new Map<string, string>();

/**
 * The shell generation in which each artifact in {@link shellArtifactByPath} was last published.
 * A generation is one current shell build; a build that lost a race with an invalidation joins the
 * generation that is current when it lands.
 */
const shellArtifactGenerationByPath = new Map<string, number>();
let shellGeneration = 0;

/** Forget every shell artifact and its generation. Tests start from an empty shell with it. */
export function resetShellArtifacts(): void {
  shellArtifactByPath.clear();
  shellArtifactGenerationByPath.clear();
  shellGeneration = 0;
}

/**
 * Publish one shell build's artifacts.
 *
 * The shell is a single bundle, and the set already in the map is only the last-good fallback
 * until a build succeeds (see `buildShellBundle`). A build that is still current starts a new
 * generation. Keeping every generation would leave each content-hashed entry and its chunks
 * resident and servable for the life of the server, one set per watched edit, so the generation
 * before the previous one is dropped.
 *
 * The previous generation stays because entries already handed out still need its chunks. Two
 * builds overlap when an edit lands while one is running: the invalidation resets the in-flight
 * slot, a request that arrives afterwards starts the current build, and the stale build keeps
 * running. If the stale build finishes first, the browser that asked for it receives its entry and
 * then requests that entry's hashed chunks; the current build landing next must not 404 them.
 * The invalidation that made the build stale also sends `shell-reload`, so the browser moves to the
 * current entry, but not before the chunk requests already in flight.
 *
 * A build that lost a race with an invalidation is added alongside for the same reason: the entry
 * it hands back imports chunk URLs that must resolve. It joins the current generation, so it ages
 * out with it. An artifact that two generations share (a content-hashed chunk with unchanged
 * content) counts as published in the newer one, so it stays for as long as either build uses it.
 * The map is therefore bounded by two generations plus the lost-race builds that landed in them.
 */
export function publishShellArtifacts(
  artifacts: ReadonlyMap<string, string>,
  replacesPrevious: boolean,
): void {
  if (replacesPrevious) {
    shellGeneration += 1;
    for (const [path, generation] of shellArtifactGenerationByPath) {
      if (generation >= shellGeneration - 1) continue;
      shellArtifactGenerationByPath.delete(path);
      shellArtifactByPath.delete(path);
    }
  }
  for (const [path, code] of artifacts) {
    shellArtifactByPath.set(path, code);
    shellArtifactGenerationByPath.set(path, shellGeneration);
  }
}
export const scenarioArtifactByPath = new Map<string, string>();
export const fixtureArtifactByPath = new Map<string, string>();

/**
 * In-flight lazy-build promises, keyed per family so two near-simultaneous
 * requests for the same not-yet-cached artifact (e.g. two browser tabs
 * hitting the same freshly invalidated page right after a save) share one
 * `Bun.build()` call instead of racing two. `pageBuildPromiseByKey` is keyed
 * by component name, `scenarioBuildPromiseByKey`/`fixtureBuildPromiseByKey`
 * by their own cache-key shapes (see `page-bundle.ts`/`scenario-bundle.ts`/
 * `fixture-bundle.ts`). The shell family's single in-flight slot lives in
 * `shell-bundle.ts` instead of a `Map` here — see that file for why.
 */
export const pageBuildPromiseByKey = new Map<string, Promise<string | null>>();
export const scenarioBuildPromiseByKey = new Map<string, Promise<string | null>>();
export const fixtureBuildPromiseByKey = new Map<string, Promise<string | null>>();

export type BuildGcCoordinator = {
  build<T>(task: () => Promise<T>): Promise<T>;
  collectGarbage(force: boolean): void;
};

/**
 * Coordinate compiler-graph lifetimes for the whole playground process.
 * Bun permits build calls to overlap, but forced GC must only run after the
 * last graph has settled. A pending collection is therefore drained by the
 * final build completion rather than racing whichever caller requested it.
 */
export function createBuildGcCoordinator(
  collect: (force: boolean) => void = (force) => Bun.gc?.(force),
): BuildGcCoordinator {
  let activeBuilds = 0;
  let requestedForce: boolean | null = null;

  const collectGarbage = (force: boolean): void => {
    requestedForce = requestedForce === null ? force : requestedForce || force;
    if (activeBuilds !== 0) return;
    const forceCollection = requestedForce;
    requestedForce = null;
    if (forceCollection !== null) collect(forceCollection);
  };

  return {
    async build<T>(task: () => Promise<T>): Promise<T> {
      activeBuilds += 1;
      try {
        return await task();
      } finally {
        activeBuilds -= 1;
        if (activeBuilds === 0 && requestedForce !== null) collectGarbage(requestedForce);
      }
    },
    collectGarbage,
  };
}

export const buildGcCoordinator = createBuildGcCoordinator();

export function coordinatedBuild<T>(task: () => Promise<T>): Promise<T> {
  return buildGcCoordinator.build(task);
}

export function collectCoordinatedGarbage(force = true): void {
  buildGcCoordinator.collectGarbage(force);
}

export function createSettledBuildCollector(
  interval: number,
  collectGarbage: (force: boolean) => void = collectCoordinatedGarbage,
): () => () => void {
  let activeBuilds = 0;
  let completedSinceCollection = 0;

  return () => {
    activeBuilds += 1;
    let settled = false;
    return () => {
      if (settled) return;
      settled = true;
      activeBuilds -= 1;
      completedSinceCollection += 1;
      if (activeBuilds === 0 && completedSinceCollection >= interval) {
        completedSinceCollection = 0;
        collectGarbage(true);
      }
    };
  };
}

/**
 * Look up an artifact for a specific bundle family route.
 *
 * Rules:
 * - The requesting family's own map is searched first.
 * - On miss, other family maps are searched ONLY for chunk-style artifacts
 *   (names that don't begin with any family's entry prefix). This allows
 *   shared content-hashed chunks to be served regardless of which build
 *   produced them, while preventing `/shell-bundle/page-button-abc.js`
 *   from being satisfied by a page-bundle entry artifact in the page map.
 *
 * Returns the artifact source, or `undefined` if no family has a permitted
 * match.
 */
export function findArtifactForFamily(family: ArtifactFamily, path: string): string | undefined {
  const allMaps: Record<ArtifactFamily, Map<string, string>> = {
    page: pageArtifactByPath,
    shell: shellArtifactByPath,
    scenario: scenarioArtifactByPath,
    fixture: fixtureArtifactByPath,
  };
  const ownHit = allMaps[family].get(path);
  if (ownHit !== undefined) return ownHit;

  // Cross-family fallback is restricted to chunk-style artifacts (no entry
  // prefix). Entries belong to their family and must not be served under
  // another family's route.
  const isEntryName = Object.values(ENTRY_PREFIXES).some((prefix) => path.startsWith(prefix));
  if (isEntryName) return undefined;

  // Search every map *except* the requesting family's own (already checked).
  // Iterate entries so the value is the typed Map directly — no narrowing cast
  // on Object.keys (which is typed `string[]`, not `ArtifactFamily[]`).
  const ownMap = allMaps[family];
  for (const [, map] of Object.entries(allMaps)) {
    if (map === ownMap) continue;
    const hit = map.get(path);
    if (hit !== undefined) return hit;
  }
  return undefined;
}

/**
 * Normalize an artifact path returned by Bun.build to the relative form we
 * use as a cache key.
 *
 * When `outdir` is omitted, Bun returns paths as either basenames
 * (`page-chat.js`) or with the `chunk` template prefix
 * (`chunks/foo-ab12.js`). Older or different Bun versions may prefix with
 * `./` (or `.\\` on Windows). We:
 *
 *   1. Strip a leading `./` or `.\\` so cache keys don't carry a redundant
 *      relative-path prefix.
 *   2. Normalize backslashes to forward slashes — Bun on Windows can emit
 *      `dir\\file.js`, but URL paths and our regex routes use `/`.
 */
export function artifactRelativePath(path: string): string {
  return path.replace(/^\.[\\/]/, '').replaceAll('\\', '/');
}

/**
 * Walk `result.outputs` and return the entry path/code plus a map of EVERY
 * artifact produced by this build (entry plus all hashed chunks).
 *
 * This function is pure with respect to the module-level caches — it does NOT
 * write to any shared map. The caller decides whether to publish into the
 * shared cache directly (the lazy-build path) or accumulate into local maps
 * for an atomic publish (the watcher rebuild path).
 *
 * Returns `null` if no entry-point artifact was found (shouldn't happen with
 * a valid Bun.build result, but handled defensively).
 *
 * Shared across all four bundle families (`page-bundle.ts`, `shell-bundle.ts`,
 * `scenario-bundle.ts`, `fixture-bundle.ts`) — each family's compile step
 * calls this identically after its own `Bun.build()` invocation.
 */
export async function collectBuildArtifacts(
  outputs: BuildArtifact[],
): Promise<{ entryPath: string; entryCode: string; artifacts: Map<string, string> } | null> {
  const artifacts = new Map<string, string>();
  let entryCode: string | null = null;
  let entryPath: string | null = null;
  for (const output of outputs) {
    const path = artifactRelativePath(output.path);
    const code = await output.text();
    artifacts.set(path, code);
    if (output.kind === 'entry-point') {
      entryCode = code;
      entryPath = path;
    }
  }
  if (entryPath === null || entryCode === null) return null;
  return { entryPath, entryCode, artifacts };
}
