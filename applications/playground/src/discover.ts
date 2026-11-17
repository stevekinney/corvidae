/**
 * Discovery utilities for the cinder component playground.
 *
 * Scans every configured component package for public Svelte components, and
 * each component's own `examples/` directory for its scenario files. All
 * scanning uses `Bun.Glob` with absolute paths.
 */

import { stat } from 'node:fs/promises';
import { join } from 'node:path';

import {
  COMPONENT_SOURCES,
  type ComponentSource,
  exampleFilePathIn,
  examplesDirectoryIn,
  resetComponentLocations,
} from './component-sources.ts';
/**
 * Compose-only leaf components (`composeOnly: true` in their `<name>.meta.json`) and the compound
 * families. Compose-only leaves are public components with no meaningful standalone usage: they
 * are always rendered inside a parent compound, so the sidebar's single parent entry covers the
 * family, but they remain in `discoverComponents()` so direct `/c/<leaf>` routing still works.
 */
import {
  COMPOSE_ONLY_COMPONENTS,
  COMPOUND_COMPONENT_FAMILIES,
} from './shell-app/compound-families.generated.ts';

export { COMPOSE_ONLY_COMPONENTS, COMPOUND_COMPONENT_FAMILIES };

export type DiscoveredComponent = {
  name: string;
  filePath: string;
  importPath: string;
  source: ComponentSource;
};

/** One `*.example.svelte` file of a discovered component. */
export type ExampleFile = {
  component: string;
  scenario: string;
  /** Absolute path to the file. */
  filePath: string;
  /** `<component>/<scenario>.example.svelte`, the key reports and allowlists use. */
  relativePath: string;
};

/**
 * Scans a component-source root for the absolute paths of every public
 * component `.svelte` file. Covers both the legacy flat layout
 * (`<root>/<name>.svelte`) and the per-directory migrated layout
 * (`<root>/<name>/<name>.svelte`).
 *
 * Exclusions, applied identically to both layouts:
 *  - underscore-prefixed names (internal-only),
 *  - the `icons/` directory,
 *  - directories whose `<name>/<name>.svelte` file does not exist.
 *
 * This is the single source of truth shared by {@link discoverComponents}
 * (which derives kebab names) and the playground analyzer's `analyzeAll`
 * (which reads the files). Returned paths are deduplicated but unsorted.
 */
export async function discoverComponentFilePaths(root: string): Promise<string[]> {
  const filePaths = new Set<string>();

  // Flat (legacy) components.
  for await (const file of new Bun.Glob('*.svelte').scan({ cwd: root })) {
    if (file.startsWith('_')) continue;
    filePaths.add(join(root, file));
  }

  // Directory-shaped (migrated) components: `<name>/<name>.svelte`.
  for await (const dir of new Bun.Glob('*/').scan({ cwd: root, onlyFiles: false })) {
    const dirName = dir.replace(/\/$/, '');
    if (dirName.startsWith('_')) continue;
    if (dirName === 'icons') continue;
    // Confirm the directory holds a top-level .svelte file matching its name.
    const candidate = join(root, dirName, `${dirName}.svelte`);
    if (await Bun.file(candidate).exists()) filePaths.add(candidate);
  }

  return [...filePaths];
}

/**
 * Memoized result of {@link scanComponents}. `null` means "cold" — the next
 * {@link discoverComponents} call performs the full glob scan and caches the
 * in-flight promise here. Cleared by {@link invalidateDiscoveryCache} on every
 * watcher rebuild so renamed/added/removed components are picked up.
 *
 * The cache stores the *promise*, not the resolved array, so concurrent first
 * callers share a single scan instead of each kicking off their own.
 */
let componentsCache: Promise<string[]> | null = null;
let componentDefinitionsCache: Promise<DiscoveredComponent[]> | null = null;

/**
 * Monotonic discovery generation. {@link invalidateDiscoveryCache} bumps it on
 * every watcher rebuild. Each memoized getter captures the generation when it
 * starts a scan and ignores the cache (re-scanning) if the generation has moved
 * on by the time it reads it — so a caller that started awaiting a scan *before*
 * an invalidation never serves the now-stale result back as if it were fresh.
 * Nulling the cache pointers alone could not fix that: a caller already holding
 * the in-flight promise would still resolve to pre-invalidation data.
 */
let discoveryGeneration = 0;

/**
 * Memoized result of {@link computeDiscoverAll}. Derived from the cached
 * component list plus a per-component example scan; invalidated alongside
 * {@link componentsCache}.
 */
let discoverAllCache: Promise<Array<{ name: string; exampleCount: number }>> | null = null;

/**
 * Drop every memoized discovery result so the next call re-scans the
 * filesystem. Called by the playground server whenever the file watcher kicks
 * off a rebuild (i.e. when `rebuildGeneration` increments), guaranteeing the
 * sidebar and component routes reflect on-disk renames, additions, and
 * deletions without a server restart.
 */
export function invalidateDiscoveryCache(): void {
  discoveryGeneration += 1;
  resetComponentLocations();
  componentsCache = null;
  componentDefinitionsCache = null;
  discoverAllCache = null;
}

/**
 * Reject ambiguous route slugs before they can silently select one package.
 * A slug is the shared key for pages, examples, documentation, and tests, so
 * two packages claiming it is always a configuration error.
 */
export function assertUniqueComponentSlugs(components: readonly DiscoveredComponent[]): void {
  const ownerByName = new Map<string, DiscoveredComponent>();
  for (const component of components) {
    const existing = ownerByName.get(component.name);
    if (existing !== undefined) {
      throw new Error(
        `[playground] duplicate component slug "${component.name}" discovered in ${existing.source.packageName} and ${component.source.packageName}`,
      );
    }
    ownerByName.set(component.name, component);
  }
}

/**
 * Every component each configured package lists. Cinder's come from core's manifest, which names
 * the directory of each component wherever it lives, in core or in a family package (COR-2085);
 * chat's and editor's come from their components roots.
 */
async function scanComponentDefinitions(): Promise<DiscoveredComponent[]> {
  const definitions = COMPONENT_SOURCES.flatMap((source) =>
    [...source.components()].map(([name, location]): DiscoveredComponent => ({
      name,
      filePath: join(location.directory, `${name}.svelte`),
      importPath: source.importPath(name),
      source,
    })),
  );

  assertUniqueComponentSlugs(definitions);
  return definitions.toSorted((left, right) => left.name.localeCompare(right.name));
}

/** Return every component together with the package that owns it. */
export async function discoverComponentDefinitions(): Promise<DiscoveredComponent[]> {
  for (;;) {
    const generationAtStart = discoveryGeneration;
    componentDefinitionsCache ??= scanComponentDefinitions();
    const result = await componentDefinitionsCache;
    if (generationAtStart === discoveryGeneration) return result;
  }
}

/** Resolve one route slug to its owning package and public import path. */
export async function discoverComponentDefinition(
  componentName: string,
): Promise<DiscoveredComponent | undefined> {
  const definitions = await discoverComponentDefinitions();
  return definitions.find((component) => component.name === componentName);
}

/**
 * Perform the actual scan for public component kebab names. Pure and uncached —
 * {@link discoverComponents} owns the memoization. Reads every package's
 * component list through {@link discoverComponentDefinitions}, then derives
 * sorted, deduplicated kebab names. Kept separate so the cache layer and the
 * scan logic stay independently testable.
 */
async function scanComponents(): Promise<string[]> {
  const definitions = await discoverComponentDefinitions();
  return definitions.map((component) => component.name);
}

/**
 * Returns a sorted array of component kebab names across every configured
 * package. Discovers both legacy flat files and per-component directories.
 * Underscore-prefixed names are excluded as internal-only.
 *
 * The result is memoized at module scope: this function runs on every `/`,
 * `/c/:name`, and `/page/:name` request, so the full `Bun.Glob` scan only
 * happens once per watcher generation. Call {@link invalidateDiscoveryCache}
 * to force a re-scan after a rebuild. The cache stores the in-flight promise,
 * so the resolved array is identical between calls and preserves exact sorting.
 */
export async function discoverComponents(): Promise<string[]> {
  // Re-scan until a scan completes without an invalidation racing it. A single
  // post-await generation check is not enough: a second invalidation *during*
  // the retry scan would otherwise be missed, returning stale data again. The
  // loop converges as soon as no rebuild lands while a scan is in flight, which
  // it always does because rebuilds are debounced and finite.
  for (;;) {
    const generationAtStart = discoveryGeneration;
    componentsCache ??= scanComponents();
    const result = await componentsCache;
    if (generationAtStart === discoveryGeneration) return result;
  }
}

async function scanExamples(definition: DiscoveredComponent): Promise<string[]> {
  const glob = new Bun.Glob('*.example.svelte');
  const scenarios: string[] = [];
  const cwd = examplesDirectoryIn(definition.source, definition.name);
  // A component without examples has no `examples/` directory, and a glob over a missing
  // directory throws.
  if (!(await directoryExists(cwd))) return [];
  for await (const fileName of glob.scan({ cwd })) {
    scenarios.push(fileName.replace(/\.example\.svelte$/, ''));
  }
  return scenarios.toSorted();
}

async function directoryExists(path: string): Promise<boolean> {
  try {
    const stats = await stat(path);
    return stats.isDirectory();
  } catch {
    return false;
  }
}

/**
 * Returns a sorted array of scenario names (basename without `.example.svelte`)
 * for a given component name, read from the `examples/` directory beside the
 * component's own source. A name no package discovers has none.
 */
export async function discoverExamples(componentName: string): Promise<string[]> {
  const definition = await discoverComponentDefinition(componentName);
  return definition === undefined ? [] : scanExamples(definition);
}

/**
 * The file of one example scenario: `examples/<scenario>.example.svelte` in the
 * component's directory, whether or not it exists. Throws for a component no
 * package discovers, which has nowhere to keep examples.
 */
export async function exampleFilePath(componentName: string, scenario: string): Promise<string> {
  const definition = await discoverComponentDefinition(componentName);
  if (definition === undefined) {
    throw new Error(`[playground] no package discovers a component named ${componentName}`);
  }
  return exampleFilePathIn(definition.source, componentName, scenario);
}

/** Every example of every discovered component, sorted by `<component>/<file>`. */
export async function discoverExampleFiles(): Promise<ExampleFile[]> {
  const definitions = await discoverComponentDefinitions();
  const files = await Promise.all(
    definitions.map(async (definition) => {
      const scenarios = await scanExamples(definition);
      return scenarios.map((scenario): ExampleFile => ({
        component: definition.name,
        scenario,
        filePath: exampleFilePathIn(definition.source, definition.name, scenario),
        relativePath: `${definition.name}/${scenario}.example.svelte`,
      }));
    }),
  );
  return files
    .flat()
    .toSorted((left, right) => left.relativePath.localeCompare(right.relativePath));
}

/**
 * Pair every component with its example count. Pure and uncached —
 * {@link discoverAll} owns the memoization. Relies on {@link discoverComponents}
 * (itself cached) for the component list, then scans each component's example
 * directory once.
 */
async function computeDiscoverAll(): Promise<Array<{ name: string; exampleCount: number }>> {
  const components = await discoverComponents();

  const results = await Promise.all(
    components.map(async (name) => {
      const examples = await discoverExamples(name);
      return { name, exampleCount: examples.length };
    }),
  );

  return results;
}

/**
 * Returns all components paired with their example count. Memoized under the
 * same invalidation as {@link discoverComponents}, since `/` and `/c/:name`
 * drive {@link discoverSidebarComponents} (which calls this) on every request.
 * Call {@link invalidateDiscoveryCache} to force a re-scan after a rebuild.
 */
export async function discoverAll(): Promise<Array<{ name: string; exampleCount: number }>> {
  // Loop until a compute completes without an invalidation racing it — the same
  // convergence guard as discoverComponents(), so a second rebuild during the
  // retry can't leave stale example counts cached.
  for (;;) {
    const generationAtStart = discoveryGeneration;
    discoverAllCache ??= computeDiscoverAll();
    const result = await discoverAllCache;
    if (generationAtStart === discoveryGeneration) return result;
  }
}

/**
 * Components that should appear in the playground sidebar — those with at least
 * one `.example.svelte` file, minus any compose-only leaf listed in
 * `COMPOSE_ONLY_COMPONENTS`. Compose-only subcomponents are demonstrated on
 * their parent's page (for example, `Tabs.List` is shown in the `tabs` entry),
 * so they would only add noise to the sidebar.
 */
export async function discoverSidebarComponents(): Promise<string[]> {
  const all = await discoverAll();
  return all
    .filter(({ exampleCount }) => exampleCount > 0)
    .map(({ name }) => name)
    .filter((name) => !COMPOSE_ONLY_COMPONENTS.has(name));
}
