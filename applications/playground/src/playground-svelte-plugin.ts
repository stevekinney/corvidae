import {
  compileSvelteComponentForBun,
  compileSvelteRuneModuleForBun,
  preserveServerComponentIdentity,
  type SvelteGenerationTarget,
} from '@lostgradient/testing';
import type { BunPlugin } from 'bun';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { VERSION as SVELTE_VERSION } from 'svelte/compiler';

import { readEnvironmentConfiguration } from './environment-configuration.ts';
import { PLAYGROUND_ROOT } from './playground-paths.ts';
import {
  createSvelteCompileCache,
  fingerprintCompiler,
  type SvelteCompileCache,
} from './svelte-compile-cache.ts';

const PLAYGROUND_SOURCE_MARKER = '/applications/playground/';

/**
 * Whether `path` is playground chrome: the documentation page, shell, and
 * examples. These are dev-only scaffolding, not part of the design-system
 * cascade, so they carry their own scoped styles.
 */
export function isPlaygroundPath(path: string): boolean {
  return path.replaceAll('\\', '/').includes(PLAYGROUND_SOURCE_MARKER);
}

/**
 * Keep a component's identity through a production server compile. Svelte's
 * `$$renderer.component()` calls need the compiled component as a second
 * argument for the server output to hydrate against the client's; development
 * compiles do not.
 */
export function transformPlaygroundServerOutput({
  code,
  path,
  dev,
}: {
  code: string;
  path: string;
  dev: boolean;
}): string {
  return dev ? code : preserveServerComponentIdentity(code, path);
}

/**
 * Fingerprint everything that shapes compiled output without being part of a cache key: the
 * compiler's version, the runtime that transpiles `lang="ts"` scripts, and the source of the two
 * modules that wrap the compiler (this one and the shared test plugin it calls). Editing either
 * wrapper, or upgrading Svelte or Bun, therefore starts a new cache rather than reading old output.
 */
export function playgroundCompilerFingerprint(inputs: {
  svelteVersion: string;
  bunVersion: string;
  pluginSource: string;
  testingPluginSource: string;
}): string {
  return fingerprintCompiler(
    inputs.svelteVersion,
    inputs.bunVersion,
    inputs.pluginSource,
    inputs.testingPluginSource,
  );
}

/** Where compiled Svelte output is kept: beside the other tool caches, outside the source tree. */
export const SVELTE_COMPILE_CACHE_DIRECTORY = join(
  PLAYGROUND_ROOT,
  'node_modules',
  '.cache',
  'svelte-compile',
);

let sharedCompileCache: SvelteCompileCache | null | undefined;

/**
 * The cache every playground build shares. `null` when its fingerprint cannot be computed, in
 * which case every component compiles: serving output that might not match the compiler is worse
 * than serving none.
 */
function sharedSvelteCompileCache(): SvelteCompileCache | null {
  if (sharedCompileCache !== undefined) return sharedCompileCache;
  try {
    const testingPluginPath = fileURLToPath(
      new URL('./svelte-plugin.ts', import.meta.resolve('@lostgradient/testing')),
    );
    sharedCompileCache = createSvelteCompileCache({
      directory: SVELTE_COMPILE_CACHE_DIRECTORY,
      compilerFingerprint: playgroundCompilerFingerprint({
        svelteVersion: SVELTE_VERSION,
        bunVersion: Bun.version,
        pluginSource: readFileSync(import.meta.filename, 'utf8'),
        testingPluginSource: readFileSync(testingPluginPath, 'utf8'),
      }),
    });
  } catch (error) {
    console.warn(
      `[playground] Svelte compile cache disabled; components compile on every build: ${
        error instanceof Error ? error.message : String(error)
      }`,
    );
    sharedCompileCache = null;
  }
  return sharedCompileCache;
}

/**
 * The Svelte compiler plugin every playground build uses.
 *
 * The shared test plugin compiles with `css: 'external'` unless `injectCss` is
 * set and discards the external CSS, which is right for library components
 * (their CSS ships as sidecar files) and wrong for playground chrome: its
 * scoped styles would never reach the server-rendered `head`, leaving the
 * landing page and documentation pages unstyled until the client bundle
 * loaded. Playground files therefore always inject their CSS, and every other
 * component follows `injectCss`. A production server compile also keeps
 * component identity (see {@link transformPlaygroundServerOutput}).
 *
 * Compiled output is cached on disk across processes (see
 * {@link createSvelteCompileCache}); pass `cache: null` to compile every time, or a cache of your
 * own to keep a test's entries out of the shared directory.
 */
export function playgroundSveltePlugin(options: {
  generate: SvelteGenerationTarget;
  injectCss?: boolean;
  cache?: SvelteCompileCache | null;
}): BunPlugin {
  const { generate } = options;
  const injectCss = options.injectCss ?? false;

  return {
    name: `playground-svelte-${generate}`,
    setup(builder) {
      builder.onLoad({ filter: /\.svelte$/ }, async ({ path }) => {
        const source = await Bun.file(path).text();
        const injectCssForFile = injectCss || isPlaygroundPath(path);
        const development = readEnvironmentConfiguration().nodeEnv !== 'production';
        const compile = () =>
          compileSvelteComponentForBun(
            source,
            path,
            { generate, injectCss: injectCssForFile },
            { transformServerOutput: transformPlaygroundServerOutput },
            development,
          );
        const cache = options.cache === undefined ? sharedSvelteCompileCache() : options.cache;
        if (cache === null) return compile();
        return cache.compile(
          {
            path,
            source,
            variant: `${generate}:${injectCssForFile ? 'css' : 'nocss'}:${development ? 'dev' : 'prod'}`,
          },
          compile,
        );
      });

      builder.onLoad({ filter: /\.svelte\.[jt]s$/ }, async ({ path }) =>
        compileSvelteRuneModuleForBun(await Bun.file(path).text(), path, generate),
      );
    },
  };
}
