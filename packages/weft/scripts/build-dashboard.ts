/**
 * Build Weft's production dashboard into `dashboard/`, the directory `dashboard()` serves by
 * default (`src/server/dashboard.ts`).
 *
 * Run from the `@lostgradient/weft` package: `bun scripts/build-dashboard.ts`. The output is
 * `dashboard/index.html` plus content-hashed JavaScript, CSS and WebAssembly under
 * `dashboard/assets/`, because `dashboard()` serves the page at its shell routes and only the
 * files under `assets/` at `/assets/*`. `scripts/check-dashboard-size.ts` holds the result to the
 * budget in `documentation/weft-ui-public-surface.md`.
 *
 * The build is the method that document records: Bun.build over an HTML entry with the browser,
 * Svelte and unwasm conditions, production `NODE_ENV`, the vendored Svelte plugin, splitting and
 * minification. The metafile stays in memory: written into `dashboard/` it would be about 2.3 MB,
 * past the disk budget and into the tarball. Pass `--metafile <path>` to write it elsewhere.
 *
 * The page entry is generated here as in-memory files rather than read from disk, so the build
 * reads nothing outside `src/` and the vendored helpers under `scripts/lib/`, and it imports
 * nothing from a private workspace.
 *
 * The output directory is replaced only once a build succeeds: Bun writes into a staging
 * directory beside it, which {@link replaceDirectory} swaps into place, so a failed build or a
 * failed swap leaves the previous dashboard intact and a reader never sees a half-written tree.
 */

import { mkdtemp, rename, rm } from 'node:fs/promises';
import { dirname, join, relative, resolve, sep } from 'node:path';
import { fileURLToPath } from 'node:url';

import { sveltePlugin } from './lib/svelte-plugin.ts';

/** The `@lostgradient/weft` package root. */
export const PACKAGE_DIRECTORY = fileURLToPath(new URL('..', import.meta.url));

/** Where the dashboard is written, and where `dashboard()` looks by default. */
export const DEFAULT_DASHBOARD_DIRECTORY = join(PACKAGE_DIRECTORY, 'dashboard');

/** The directory, relative to the dashboard root, that holds every file `index.html` loads. */
export const DASHBOARD_ASSET_DIRECTORY = 'assets';

/**
 * The generated page entry. Both files are virtual: the paths place them in the package's
 * `scripts/dashboard-entry/` directory (which does not exist on disk) so that `../../src/ui/index.ts`
 * and bare package specifiers resolve exactly as they would from a file there.
 */
const ENTRY_DIRECTORY = join(PACKAGE_DIRECTORY, 'scripts', 'dashboard-entry');
const ENTRY_HTML_PATH = join(ENTRY_DIRECTORY, 'index.html');
const ENTRY_SCRIPT_PATH = join(ENTRY_DIRECTORY, 'main.ts');

const ENTRY_HTML = `<!doctype html>
<html lang="en">
  <head>
    <meta charset="UTF-8" />
    <meta name="viewport" content="width=device-width, initial-scale=1.0" />
    <title>Weft</title>
  </head>
  <body>
    <div id="app"></div>
    <script type="application/json" id="weft-ui-config">
      { "baseUrl": "", "eventTransport": "auto" }
    </script>
    <script type="module" src="./main.ts"></script>
  </body>
</html>
`;

const ENTRY_SCRIPT = `import { mount } from 'svelte';
import { WeftDashboard } from '../../src/ui/index.ts';

const target = document.getElementById('app');
if (!target) throw new Error('Weft dashboard: #app mount element not found in index.html');
mount(WeftDashboard, { target });
`;

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
 * The Bun.build options every browser build of Weft's UI shares: the development host
 * (`scripts/ui-browser/server.ts`) and this production build differ only in `development`, in
 * minification, and in where the files land.
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
  const previous = join(dirname(directory), `.dashboard-previous-${crypto.randomUUID()}`);
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

export type DashboardBuild = {
  /** The directory the dashboard was written to. */
  readonly directory: string;
  /** Every file written, as a path relative to {@link DashboardBuild.directory}. */
  readonly files: readonly string[];
  /** Bun's metafile for the build, which is not written into the dashboard directory. */
  readonly metafile: Bun.BuildMetafile;
};

/**
 * Build the production dashboard into `outdir` (by default `dashboard/` at the package root),
 * replacing what was there only once the build succeeds.
 */
export async function buildDashboard(
  options: { readonly outdir?: string } = {},
): Promise<DashboardBuild> {
  const directory = resolve(options.outdir ?? DEFAULT_DASHBOARD_DIRECTORY);
  const parent = dirname(directory);
  const staging = await mkdtemp(join(parent, '.dashboard-build-'));
  try {
    const result = await Bun.build({
      ...browserBuildOptions({
        entrypoints: [ENTRY_HTML_PATH],
        outdir: staging,
        development: false,
      }),
      files: { [ENTRY_HTML_PATH]: ENTRY_HTML, [ENTRY_SCRIPT_PATH]: ENTRY_SCRIPT },
      minify: true,
      naming: {
        entry: '[name].[ext]',
        chunk: `${DASHBOARD_ASSET_DIRECTORY}/[name]-[hash].[ext]`,
        asset: `${DASHBOARD_ASSET_DIRECTORY}/[name]-[hash].[ext]`,
      },
    });
    const metafile = assertCleanBuild(result);
    const files = result.outputs
      .map((output) => relative(staging, output.path).split(sep).join('/'))
      .toSorted();
    await replaceDirectory(staging, directory);
    return { directory, files, metafile };
  } finally {
    await rm(staging, { recursive: true, force: true });
  }
}

/**
 * The `--metafile <path>` argument, resolved, or undefined when absent. A path inside the
 * dashboard directory is refused before anything is built, because the budget counts every file
 * there and the metafile alone is about 2.3 MB.
 */
export function readMetafileArgument(
  argv: readonly string[],
  dashboardDirectory: string = DEFAULT_DASHBOARD_DIRECTORY,
): string | undefined {
  const index = argv.indexOf('--metafile');
  if (index === -1) return undefined;
  const argument = argv[index + 1];
  if (argument === undefined || argument.startsWith('--')) {
    throw new Error('--metafile needs a path outside the dashboard directory');
  }
  const path = resolve(argument);
  const directory = resolve(dashboardDirectory);
  if (path === directory || path.startsWith(`${directory}${sep}`)) {
    throw new Error(`--metafile must point outside ${directory}`);
  }
  return path;
}

/** The command-line entry: build, report what was written, and optionally save the metafile. */
export async function runBuildDashboardCommand(
  argv: readonly string[],
  log: (line: string) => void = console.log,
): Promise<DashboardBuild> {
  const metafilePath = readMetafileArgument(argv);
  const build = await buildDashboard();
  if (metafilePath !== undefined) {
    await Bun.write(metafilePath, JSON.stringify(build.metafile));
    log(`Wrote the build metafile to ${metafilePath}`);
  }
  log(`Built Weft's dashboard into ${build.directory} (${build.files.length} files)`);
  return build;
}

if (import.meta.main) await runBuildDashboardCommand(Bun.argv.slice(2));
