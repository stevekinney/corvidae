/**
 * Build Interborough's browser application into `build/`, the directory its host serves.
 *
 * Run from `applications/interborough`: `bun scripts/build.ts`. The output is `build/index.html`
 * plus content-hashed JavaScript, CSS and WebAssembly under `build/assets/`, because the host
 * serves the page at its shell routes and only the files under `assets/` at `/assets/*`.
 *
 * The build is `Bun.build` over the real `index.html` entry with the browser, Svelte and unwasm
 * conditions, production `NODE_ENV`, the Svelte plugin from `@lostgradient/testing`, splitting
 * and minification. There is no second bundler: the development host rebuilds with the same
 * options ({@link browserBuildOptions}) and differs only in `development`, in minification, and
 * in where the files land.
 *
 * In development the previous build's hashed assets stay for one more generation
 * ({@link retainPreviousAssets}), so a page loaded before a rebuild can still fetch the chunks it
 * lazily imports. The production build keeps nothing of the build it replaces.
 *
 * The output directory is replaced only once a build succeeds: Bun writes into a staging
 * directory beside it, which {@link replaceDirectory} swaps into place, so a failed build or a
 * failed swap leaves the previous build intact and a reader never sees a half-written tree.
 */

import { cp, mkdir, mkdtemp, readdir, rename, rm } from 'node:fs/promises';
import { dirname, join, relative, resolve, sep } from 'node:path';
import { fileURLToPath } from 'node:url';

import { sveltePlugin } from '@lostgradient/testing';

/** The `@lostgradient/interborough` package root. */
export const PACKAGE_DIRECTORY = fileURLToPath(new URL('..', import.meta.url));

/** Where the application is built, and where the host looks by default. */
export const DEFAULT_BUILD_DIRECTORY = join(PACKAGE_DIRECTORY, 'build');

/** The page the build starts from. */
export const ENTRY_HTML_PATH = join(PACKAGE_DIRECTORY, 'index.html');

/** The directory, relative to the build root, that holds every file `index.html` loads. */
export const BUILD_ASSET_DIRECTORY = 'assets';

/**
 * Bun's `unwasm` condition exposes WebAssembly modules (Shiki's Oniguruma engine) as imports.
 * Bun emits each binary as an asset, and the module's default export instantiates it from that
 * asset's URL, which is the shape consumers of the condition expect.
 */
export const wasmPlugin: Bun.BunPlugin = {
  name: 'browser-wasm',
  setup(builder) {
    builder.onLoad({ filter: /\.wasm$/, namespace: 'file' }, ({ path }) => ({
      loader: 'js',
      contents: `import url from ${JSON.stringify(`wasm-asset:${path}`)};
export default (imports) => WebAssembly.instantiateStreaming(fetch(url), imports);`,
    }));
    builder.onResolve({ filter: /^wasm-asset:/ }, ({ path }) => ({
      // Keep the binary and its JavaScript module distinct in Bun's module graph.
      path: `${path.slice('wasm-asset:'.length)}.binary.wasm`,
      namespace: 'wasm-asset',
    }));
    builder.onLoad({ filter: /.*/, namespace: 'wasm-asset' }, async ({ path }) => ({
      contents: await Bun.file(path.slice(0, -'.binary.wasm'.length)).bytes(),
      loader: 'file',
    }));
  },
};

/**
 * The `Bun.build` options every browser build of the application shares: the development host
 * and the production build differ only in `development`, in minification, and in where the files
 * land.
 */
export function browserBuildOptions(options: {
  readonly entrypoints: string[];
  readonly outdir: string;
  readonly development: boolean;
}): Bun.BuildConfig & { readonly metafile: true } {
  return {
    entrypoints: options.entrypoints,
    outdir: options.outdir,
    conditions: ['browser', 'svelte', 'unwasm'],
    define: {
      'process.env.NODE_ENV': JSON.stringify(options.development ? 'development' : 'production'),
    },
    format: 'esm',
    publicPath: '/',
    target: 'browser',
    plugins: [
      wasmPlugin,
      sveltePlugin({ generate: 'client', injectCss: true, development: options.development }),
    ],
    optimizeImports: ['@lostgradient/cinder'],
    sourcemap: 'none',
    splitting: true,
    metafile: true,
    naming: {
      entry: '[name].[ext]',
      chunk: `${BUILD_ASSET_DIRECTORY}/[name]-[hash].[ext]`,
      asset: `${BUILD_ASSET_DIRECTORY}/[name]-[hash].[ext]`,
    },
  };
}

/**
 * Fail on a build that did not succeed, logged a warning, or produced no metafile. Warnings fail
 * the build because a warning from the Svelte compiler or the bundler is a defect here.
 */
export function assertCleanBuild(result: Bun.BuildOutput): Bun.BuildMetafile {
  if (!result.success) throw new AggregateError(result.logs, 'Browser compilation failed');
  const warnings = result.logs.filter((message) => message.level === 'warning');
  if (warnings.length > 0) {
    throw new AggregateError(warnings, 'Browser compilation emitted warnings');
  }
  if (result.metafile === undefined) {
    throw new Error('Browser compilation did not emit module provenance');
  }
  return result.metafile;
}

/** The filesystem operations {@link replaceDirectory} uses, replaceable in tests. */
export type DirectoryOperations = {
  readonly rename: (from: string, to: string) => Promise<void>;
  readonly rm: (path: string, options: { recursive: true; force: true }) => Promise<void>;
};

const NODE_DIRECTORY_OPERATIONS: DirectoryOperations = { rename, rm };

function isMissingPath(error: unknown): boolean {
  return error instanceof Error && 'code' in error && error.code === 'ENOENT';
}

/**
 * Put `staging` at `directory`. Whatever was at `directory` is renamed aside first and deleted
 * only once `staging` is in place, so there is no moment with neither tree, and when the second
 * rename fails the previous tree is renamed back before the error is rethrown.
 */
export async function replaceDirectory(
  staging: string,
  directory: string,
  operations: DirectoryOperations = NODE_DIRECTORY_OPERATIONS,
): Promise<void> {
  const previous = join(dirname(directory), `.build-previous-${crypto.randomUUID()}`);
  let movedAside = true;
  try {
    await operations.rename(directory, previous);
  } catch (error) {
    if (!isMissingPath(error)) throw error;
    movedAside = false;
  }
  try {
    await operations.rename(staging, directory);
  } catch (error) {
    if (movedAside) await operations.rename(previous, directory);
    throw error;
  }
  if (movedAside) await operations.rm(previous, { recursive: true, force: true });
}

/** Names the assets carried over from the build before, which the next build must not carry again. */
export const RETAINED_ASSETS_FILE = '.retained-assets.json';

async function readRetainedAssets(directory: string): Promise<ReadonlySet<string>> {
  const file = Bun.file(join(directory, RETAINED_ASSETS_FILE));
  if (!(await file.exists())) return new Set();
  const names: unknown = await file.json();
  return new Set(Array.isArray(names) ? names.filter((name) => typeof name === 'string') : []);
}

/**
 * Copy the assets `directory` serves into `staging` beside the new build's own, and record which
 * ones they are in {@link RETAINED_ASSETS_FILE}. A page that was open before a rebuild keeps
 * lazily importing chunks by their old hashed names, and those would be gone once the directory
 * is swapped. Only the build immediately before is kept: assets that build itself carried over
 * are listed in its record and are dropped here, so nothing accumulates. A name the new build
 * also emitted is never overwritten.
 */
export async function retainPreviousAssets(staging: string, directory: string): Promise<string[]> {
  const previousAssets = join(directory, BUILD_ASSET_DIRECTORY);
  let names: string[];
  try {
    names = await readdir(previousAssets);
  } catch (error) {
    if (isMissingPath(error)) return [];
    throw error;
  }
  const carriedOver = await readRetainedAssets(directory);
  await mkdir(join(staging, BUILD_ASSET_DIRECTORY), { recursive: true });
  const retained: string[] = [];
  for (const name of names.toSorted()) {
    if (carriedOver.has(name)) continue;
    const target = join(staging, BUILD_ASSET_DIRECTORY, name);
    if (await Bun.file(target).exists()) continue;
    await cp(join(previousAssets, name), target);
    retained.push(name);
  }
  await Bun.write(join(staging, RETAINED_ASSETS_FILE), JSON.stringify(retained));
  return retained;
}

export type ApplicationBuild = {
  /** The directory the application was written to. */
  readonly directory: string;
  /** Every file written, as a path relative to {@link ApplicationBuild.directory}. */
  readonly files: readonly string[];
  /** Bun's metafile for the build, which is not written into the build directory. */
  readonly metafile: Bun.BuildMetafile;
};

/**
 * Build the application into `outdir` (by default `build/` at the package root), replacing what
 * was there only once the build succeeds. The default is the production build: minified, with
 * `NODE_ENV=production` compiled in. `development: true` keeps the Svelte compiler's diagnostics
 * and skips minification, for the development host.
 */
export async function buildApplication(
  options: {
    readonly outdir?: string;
    readonly development?: boolean;
    /** The bundler. `Bun.build` by default; a test supplies a fake so it need not bundle. */
    readonly bundle?: (configuration: Bun.BuildConfig) => Promise<Bun.BuildOutput>;
  } = {},
): Promise<ApplicationBuild> {
  const development = options.development ?? false;
  const directory = resolve(options.outdir ?? DEFAULT_BUILD_DIRECTORY);
  const parent = dirname(directory);
  const staging = await mkdtemp(join(parent, '.build-staging-'));
  try {
    const result = await (options.bundle ?? Bun.build)({
      ...browserBuildOptions({
        entrypoints: [ENTRY_HTML_PATH],
        outdir: staging,
        development,
      }),
      minify: !development,
    });
    const metafile = assertCleanBuild(result);
    const files = result.outputs
      .map((output) => relative(staging, output.path).split(sep).join('/'))
      .toSorted();
    if (development) await retainPreviousAssets(staging, directory);
    await replaceDirectory(staging, directory);
    return { directory, files, metafile };
  } finally {
    await rm(staging, { recursive: true, force: true });
  }
}

/** The command-line entry: build and report what was written. */
export async function runBuildCommand(
  log: (line: string) => void = console.log,
  runBuild: typeof buildApplication = buildApplication,
): Promise<ApplicationBuild> {
  const build = await runBuild();
  log(`Built Interborough into ${build.directory} (${build.files.length} files)`);
  return build;
}

if (import.meta.main) await runBuildCommand();
