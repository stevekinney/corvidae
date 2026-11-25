/**
 * What the host reads of its home and its environment to mount its panels (COR-2216, COR-2217,
 * COR-2219): where the release left prebuilt pages, which packages a build resolves `svelte` and
 * Cinder from, and where built pages are kept between starts. Each is a decision about the host's
 * surroundings, so they are here and not in `startHost`, which is already as large as it may be.
 */
import type { Bungalow } from '@lostgradient/bungalow';

import { HOST_DEPENDENCIES, PLUGIN_RUNTIME_DIRECTORY_VARIABLE } from './folder-plugins.ts';
import { localContentDirectory, type ContentKinds } from './locations.ts';
import {
  createPanelBuildCache,
  createPanelBuildMemory,
  PANEL_BUILD_CACHE_FOLDER_NAME,
} from './panel-build-cache.ts';
import {
  PANEL_PREBUILT_DIRECTORY_VARIABLE,
  type PanelFallback,
  type PanelMountOptions,
} from './panel-mounts.ts';

/**
 * The local directory that keeps built panel pages between starts: the home's own, or `undefined`
 * for a remote one. A read-only home that has no such directory yet refuses to make one; that is
 * told to `log`, and the host then builds every start, which is all the cache ever saves.
 */
export function panelCacheDirectoryOf(
  bungalow: Pick<Bungalow, 'content'>,
  kinds: ContentKinds,
  log: (message: string) => void,
): string | undefined {
  try {
    return localContentDirectory(bungalow.content(PANEL_BUILD_CACHE_FOLDER_NAME), kinds);
  } catch (error) {
    log(`The panel build cache is off: ${error instanceof Error ? error.message : String(error)}`);
    return undefined;
  }
}

/** A variable's value, trimmed, or `undefined` when it is unset or blank. */
function variableOf(
  environment: Readonly<Record<string, string | undefined>>,
  name: string,
): string | undefined {
  const value = environment[name]?.trim();
  return value === undefined || value === '' ? undefined : value;
}

/**
 * The options the host mounts its panels with: the release's prebuilt pages when its supervisor
 * names them, the plugin runtime of a relocated release (or the application's own `node_modules`)
 * as the place a build resolves `svelte` and Cinder from, and a cache of built pages in
 * `cacheDirectory`. `overrides` replace the build and its clock, for a test.
 */
export function hostPanelMountOptions(options: {
  readonly environment: Readonly<Record<string, string | undefined>>;
  readonly cacheDirectory: string | undefined;
  readonly log: (message: string) => void;
  readonly overrides?: Pick<PanelMountOptions, 'build' | 'clock'>;
}): PanelMountOptions {
  const { environment, cacheDirectory, log, overrides } = options;
  const prebuiltDirectory = variableOf(environment, PANEL_PREBUILT_DIRECTORY_VARIABLE);
  return {
    ...(prebuiltDirectory === undefined ? {} : { prebuiltDirectory }),
    dependencies: variableOf(environment, PLUGIN_RUNTIME_DIRECTORY_VARIABLE) ?? HOST_DEPENDENCIES,
    ...(environment['INTERBOROUGH_STARTUP_PROFILE'] === '1'
      ? { observe: (event) => log(`STARTUP ${JSON.stringify({ stage: 'panel', ...event })}`) }
      : {}),
    cache: createPanelBuildCache({
      ...(cacheDirectory === undefined ? {} : { directory: cacheDirectory }),
      report: log,
      // A host started again in this process serves the pages the first one built, but a build a
      // test replaces is never answered from what a real one left.
      ...(overrides?.build === undefined ? { memory: PROCESS_MEMORY } : {}),
    }),
    ...overrides,
  };
}

/** The pages this process has built, which every host in it shares. */
const PROCESS_MEMORY = createPanelBuildMemory();

/** Tell `log` of each prebuilt page the host could not use and built itself instead, and why. */
export function reportPanelFallbacks(
  fallbacks: readonly PanelFallback[],
  log: (message: string) => void,
): void {
  for (const fallback of fallbacks) {
    log(
      `Plugin ${fallback.plugin}: the prebuilt page of its panel ${fallback.app} was not used, so the host built it: ${fallback.reason}`,
    );
  }
}
