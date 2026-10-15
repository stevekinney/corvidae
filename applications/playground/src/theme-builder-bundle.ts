import { randomUUID } from 'node:crypto';
import { rmSync } from 'node:fs';
import { join } from 'node:path';

import {
  SHARED_BUILD_OPTIONS,
  artifactRelativePath,
  coordinatedBuild,
} from './build-artifacts-shared.ts';
import { PLAYGROUND_TEMP_ROOT } from './playground-paths.ts';

/**
 * The theme builder's two browser bundles: the workbench (`/theme-builder`) and the
 * trusted preview frame (`/theme-builder/preview`).
 *
 * They are built together, in one `Bun.build`, so the code they share (the Cinder
 * barrel, the message protocol, the scene manifest) is emitted once as content-hashed
 * chunks. They are a separate family from the documentation shell and page bundles on
 * purpose: nothing a documentation route imports reaches this graph, and nothing here
 * reaches theirs, which is what keeps those bundles unchanged. Chunk URLs resolve
 * through `/theme-builder-bundle/`.
 *
 * The build is lazy and cached until a watched change invalidates it.
 */

export const THEME_BUILDER_BUNDLE_PUBLIC_PATH = '/theme-builder-bundle/';

export const THEME_BUILDER_ENTRY_SOURCES = {
  'theme-builder': '../../src/shell-app/theme-builder-entry.ts',
  'theme-preview': '../../src/shell-app/theme-preview-entry.ts',
  'theme-runtime-worker': '../../src/shell-app/theme-runtime-worker.ts',
} as const;

export type ThemeBuilderEntryName = keyof typeof THEME_BUILDER_ENTRY_SOURCES;

export function isThemeBuilderEntryName(name: string): name is ThemeBuilderEntryName {
  return Object.hasOwn(THEME_BUILDER_ENTRY_SOURCES, name);
}

type ThemeBuilderBuild = {
  entryPathByName: ReadonlyMap<ThemeBuilderEntryName, string>;
  artifacts: ReadonlyMap<string, string>;
};

let currentBuild: ThemeBuilderBuild | null = null;
/** The build before the current one, kept so chunk requests already in flight still resolve. */
let previousBuild: ThemeBuilderBuild | null = null;
let buildPromise: Promise<ThemeBuilderBuild | null> | null = null;
let invalidationGeneration = 0;

/** Drop the cached builds; the next request compiles again. Called by the file watcher. */
export function invalidateThemeBuilderBundles(): void {
  invalidationGeneration += 1;
  previousBuild = currentBuild;
  currentBuild = null;
  buildPromise = null;
}

/** Forget everything, including the previous build. Tests start from an empty cache with it. */
export function resetThemeBuilderBundles(): void {
  invalidationGeneration += 1;
  currentBuild = null;
  previousBuild = null;
  buildPromise = null;
}

async function compile(): Promise<ThemeBuilderBuild | null> {
  const tempDirectory = join(PLAYGROUND_TEMP_ROOT, randomUUID());
  try {
    const entrypoints: string[] = [];
    for (const [name, source] of Object.entries(THEME_BUILDER_ENTRY_SOURCES)) {
      const entryPath = join(tempDirectory, `${name}.ts`);
      // A side-effect import keeps the entry's top-level `mount()` from being tree-shaken.
      await Bun.write(entryPath, `import '${source}';\n`);
      entrypoints.push(entryPath);
    }
    const result = await coordinatedBuild(() =>
      Bun.build({
        entrypoints,
        publicPath: THEME_BUILDER_BUNDLE_PUBLIC_PATH,
        ...SHARED_BUILD_OPTIONS,
      }),
    );
    if (!result.success) {
      console.error('[playground] theme builder bundle failed:', result.logs);
      return null;
    }
    const artifacts = new Map<string, string>();
    const entryPathByName = new Map<ThemeBuilderEntryName, string>();
    for (const output of result.outputs) {
      const path = artifactRelativePath(output.path);
      artifacts.set(path, await output.text());
      if (output.kind !== 'entry-point') continue;
      for (const name of Object.keys(THEME_BUILDER_ENTRY_SOURCES)) {
        if (isThemeBuilderEntryName(name) && path.startsWith(`${name}-`)) {
          entryPathByName.set(name, path);
        }
      }
    }
    if (entryPathByName.size !== Object.keys(THEME_BUILDER_ENTRY_SOURCES).length) {
      console.error('[playground] theme builder bundle produced no entry chunk for every page');
      return null;
    }
    return { entryPathByName, artifacts };
  } finally {
    rmSync(tempDirectory, { recursive: true, force: true });
  }
}

async function ensureBuilt(): Promise<ThemeBuilderBuild | null> {
  if (currentBuild !== null) return currentBuild;
  if (buildPromise !== null) return buildPromise;
  const generation = invalidationGeneration;
  const promise = compile()
    .catch((error: unknown) => {
      console.error('[playground] theme builder bundle threw:', error);
      return null;
    })
    .then((build) => {
      // A build that lost a race with an invalidation still serves the request that
      // started it (its entry imports its own chunk URLs) but is not cached as current.
      if (build !== null && generation === invalidationGeneration) currentBuild = build;
      else if (build !== null) previousBuild = build;
      return build;
    });
  buildPromise = promise;
  try {
    return await promise;
  } finally {
    if (buildPromise === promise) buildPromise = null;
  }
}

/** The entry bundle's code for `name`, compiling on first use. `null` when the build failed. */
export async function themeBuilderEntryCode(name: ThemeBuilderEntryName): Promise<string | null> {
  const build = await ensureBuilt();
  const path = build?.entryPathByName.get(name);
  return path === undefined ? null : (build?.artifacts.get(path) ?? null);
}

/** A hashed chunk of the current (or immediately previous) build. */
export function themeBuilderArtifact(path: string): string | undefined {
  return currentBuild?.artifacts.get(path) ?? previousBuild?.artifacts.get(path);
}
