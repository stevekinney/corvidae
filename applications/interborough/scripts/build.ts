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

import { existsSync, mkdtempSync, realpathSync, rmSync } from 'node:fs';
import { cp, mkdir, readdir, rename, rm, writeFile } from 'node:fs/promises';
import { dirname, isAbsolute, join, relative, resolve, sep } from 'node:path';
import { fileURLToPath } from 'node:url';

import { sveltePlugin } from '@lostgradient/testing';

/** The `@lostgradient/interborough` package root. */
export const PACKAGE_DIRECTORY = fileURLToPath(new URL('..', import.meta.url));

/** Where the application is built, and where the host looks by default. */
export const DEFAULT_BUILD_DIRECTORY = join(PACKAGE_DIRECTORY, 'build');

/** The repository root, which holds every workspace. */
export const REPOSITORY_ROOT = resolve(PACKAGE_DIRECTORY, '..', '..');

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

/** The module the complete Shiki registries are resolved to (`src/lib/curated-shiki-registries.ts`). */
export const CURATED_SHIKI_REGISTRIES = join(
  PACKAGE_DIRECTORY,
  'src',
  'lib',
  'curated-shiki-registries.ts',
);

/**
 * Cinder exports a highlighter over Shiki's complete language and theme registries
 * (`fullShikiHighlighter`), whose lookup tables (`shiki/langs` and `shiki/themes`) make a bundler
 * emit every grammar and theme Shiki ships. `@lostgradient/chat` publishes that highlighter for
 * every code block in a transcript, so the registries are reachable and Chat does use them: it
 * highlights each tool call's JSON arguments and result with it. Both specifiers are therefore
 * resolved to a module that holds curated tables (`src/lib/curated-shiki-registries.ts`): the
 * grammars and themes the application already ships, and nothing else. Tables that were empty
 * would keep the bundle small and break the highlighter, which renders every block as plain text
 * with a console warning.
 */
export const curatedShikiPlugin: Bun.BunPlugin = {
  name: 'curated-shiki',
  setup(builder) {
    builder.onResolve({ filter: /^shiki\/(?:langs|themes)$/ }, () => ({
      path: CURATED_SHIKI_REGISTRIES,
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
      curatedShikiPlugin,
      sveltePlugin({ generate: 'client', injectCss: true, development: options.development }),
    ],
    optimizeImports: ['@lostgradient/cinder'],
    // Development links a map beside each chunk so the browser shows the original source;
    // production ships none.
    sourcemap: options.development ? 'linked' : 'none',
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

/** The `href` of every `<link rel="stylesheet">` in `html`. */
export function linkedStylesheets(html: string): string[] {
  const hrefs: string[] = [];
  for (const [tag] of html.matchAll(/<link\b[^>]*>/g)) {
    if (!/\brel="stylesheet"/.test(tag)) continue;
    const href = /\bhref="([^"]+)"/.exec(tag)?.[1];
    if (href !== undefined) hrefs.push(href);
  }
  return hrefs;
}

/**
 * Delete the stylesheets (and their source maps) that `index.html` does not link, and return the
 * files that remain. Bun makes one CSS bundle per JavaScript entry or dynamically imported chunk,
 * and each bundle is the whole CSS graph reachable from that chunk, so Cinder's token block and
 * every shared layer are emitted once per lazy route. Nothing loads those bundles: no chunk
 * imports them and the page links only the one the HTML entry produces, which already holds the
 * CSS of every lazily imported module, because the entry's graph reaches through dynamic imports.
 * Component `<style>` blocks are not in any of these files: the Svelte plugin injects them into
 * the JavaScript of the component that owns them.
 */
export async function pruneUnlinkedStylesheets(
  staging: string,
  files: readonly string[],
): Promise<string[]> {
  if (!files.includes('index.html')) return [...files];
  const html = await Bun.file(join(staging, 'index.html')).text();
  const linked = new Set(
    linkedStylesheets(html).map((href) => relative('/', href).split(sep).join('/')),
  );
  const unlinked = new Set(files.filter((file) => file.endsWith('.css') && !linked.has(file)));
  for (const stylesheet of unlinked) {
    await rm(join(staging, stylesheet), { force: true });
    await rm(join(staging, `${stylesheet}.map`), { force: true });
  }
  return files.filter((file) => !unlinked.has(file) && !unlinked.has(file.replace(/\.map$/, '')));
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

/** The staging directories of the builds running in this process. */
const stagingDirectories = new Set<string>();

/** Whether `path` is `directory` or lies beneath it. */
function isWithin(directory: string, path: string): boolean {
  const difference = relative(directory, path);
  return difference === '' || (!difference.startsWith('..') && !isAbsolute(difference));
}

/** `path` made absolute, with symbolic links resolved as far down as the path exists. */
function resolveExisting(path: string): string {
  const absolute = resolve(path);
  const missing: string[] = [];
  let existing = absolute;
  while (!existsSync(existing) && dirname(existing) !== existing) {
    missing.unshift(relative(dirname(existing), existing));
    existing = dirname(existing);
  }
  return join(realpathSync(existing), ...missing);
}

/**
 * Refuse an output directory the build must never replace. {@link replaceDirectory} renames the
 * directory it is given aside and deletes it, so an `--outdir` that is blank (which resolves to the
 * working directory), or that is, contains, or sits inside the working directory, the application,
 * the repository, or any of their source would delete work. An output directory is allowed outside
 * the repository, or at or beneath the default `build/`.
 */
export function assertSafeOutputDirectory(
  outdir: string,
  workingDirectory: string = process.cwd(),
): string {
  if (outdir.trim() === '') throw new Error('The output directory must not be blank.');
  const directory = resolveExisting(outdir);
  const protectedDirectories = [
    resolveExisting(workingDirectory),
    resolveExisting(PACKAGE_DIRECTORY),
    resolveExisting(REPOSITORY_ROOT),
  ];
  const defaultDirectory = resolveExisting(DEFAULT_BUILD_DIRECTORY);
  const replacesSource =
    protectedDirectories.some((protectedDirectory) => isWithin(directory, protectedDirectory)) ||
    (isWithin(resolveExisting(REPOSITORY_ROOT), directory) &&
      !isWithin(defaultDirectory, directory));
  if (replacesSource) {
    throw new Error(
      `Refusing to build into ${outdir}: it would replace the working directory, the application, or the repository's source.`,
    );
  }
  return resolve(outdir);
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
  const directory =
    options.outdir === undefined
      ? DEFAULT_BUILD_DIRECTORY
      : assertSafeOutputDirectory(options.outdir);
  const parent = dirname(directory);
  // Created and recorded in one synchronous step, so a stale build that is told to exit between
  // two awaits either has not made its staging directory yet or removes it.
  const staging = mkdtempSync(join(parent, '.build-staging-'));
  stagingDirectories.add(staging);
  try {
    const result = await (options.bundle ?? Bun.build)({
      ...browserBuildOptions({
        entrypoints: [ENTRY_HTML_PATH],
        outdir: staging,
        development,
      }),
      minify: !development,
    });
    const bundled = assertCleanBuild(result);
    const files = await pruneUnlinkedStylesheets(
      staging,
      result.outputs
        .map((output) => relative(staging, output.path).split(sep).join('/'))
        .toSorted(),
    );
    const written = new Set(files);
    // The metafile describes what is on disk: it keeps no entry for a stylesheet that was pruned.
    const metafile: Bun.BuildMetafile = {
      ...bundled,
      outputs: Object.fromEntries(
        Object.entries(bundled.outputs).filter(
          ([name]) => !name.endsWith('.css') || written.has(name.replace(/^\.\//, '')),
        ),
      ),
    };
    if (development) await retainPreviousAssets(staging, directory);
    await replaceDirectory(staging, directory);
    return { directory, files, metafile };
  } finally {
    await rm(staging, { recursive: true, force: true });
    stagingDirectories.delete(staging);
  }
}

/**
 * Exit, removing the staging directories of the builds still running, when standard input closes.
 * The development host runs the build as a child process with a pipe on standard input and never
 * writes to it, so the pipe closing means the host's generation ended (a `bun --watch` reload, a
 * stop, or a crash). The build is then stale, and it exits before it can replace the newer build.
 */
export function exitWhenStandardInputCloses(
  input: ReadableStream<Uint8Array> = Bun.stdin.stream(),
  exit: (code: number) => void = process.exit.bind(process),
): void {
  void (async () => {
    // Nothing is ever sent; reading only waits for the end of the stream.
    const reader = input.getReader();
    for (let chunk = await reader.read(); !chunk.done; chunk = await reader.read()) continue;
    for (const staging of stagingDirectories) rmSync(staging, { recursive: true, force: true });
    exit(1);
  })();
}

/** What the command line asks {@link buildApplication} for. */
export type BuildCommandOptions = {
  readonly development?: boolean;
  readonly outdir?: string;
};

/**
 * The command line: what to build, whether to stop when standard input closes, and where to
 * record the build's inputs ({@link writeBuildInputs}).
 */
export type BuildArguments = BuildCommandOptions & {
  readonly exitWithParent: boolean;
  readonly inputsFile?: string;
};

/**
 * The absolute path of every source file the bundler read, from the metafile's `inputs`. Bun
 * reports them relative to the working directory, and a workspace the application imports is
 * reported at its real path (`../../components/chat/src/...`). Inputs a plugin synthesized
 * (`wasm-asset:...`) are not files and are left out.
 */
export function buildInputPaths(
  metafile: Bun.BuildMetafile,
  workingDirectory: string = process.cwd(),
): string[] {
  return Object.keys(metafile.inputs)
    .filter((input) => !/^[a-z][a-z0-9+.-]*:/i.test(input))
    .map((input) => resolve(workingDirectory, input))
    .toSorted();
}

/**
 * Record the files the build read as a JSON array of absolute paths, which the development host
 * reads to decide which directories to watch (`source-watcher.ts`). The file is written beside
 * its final name and renamed into place, so the host never reads a half-written list.
 */
export async function writeBuildInputs(
  file: string,
  metafile: Bun.BuildMetafile,
  workingDirectory: string = process.cwd(),
): Promise<void> {
  const pending = `${file}.${process.pid}.tmp`;
  await writeFile(pending, JSON.stringify(buildInputPaths(metafile, workingDirectory)));
  await rename(pending, file);
}

/**
 * Read the command-line arguments: `--development` builds the unminified development bundle,
 * `--outdir <path>` builds somewhere other than `build/`, `--inputs-file <path>` records the files
 * the build read ({@link writeBuildInputs}), and `--exit-with-parent` stops the build when
 * standard input closes ({@link exitWhenStandardInputCloses}). The development host runs this
 * command in a child process, so an unknown argument fails loudly instead of building the wrong
 * thing.
 */
export function parseBuildArguments(argv: readonly string[]): BuildArguments {
  let development = false;
  let exitWithParent = false;
  let outdir: string | undefined;
  let inputsFile: string | undefined;
  for (let index = 0; index < argv.length; index += 1) {
    const argument = argv[index];
    if (argument === '--development') {
      development = true;
    } else if (argument === '--exit-with-parent') {
      exitWithParent = true;
    } else if (argument === '--outdir') {
      outdir = argv[index + 1];
      if (outdir === undefined || outdir.trim() === '') {
        throw new Error('--outdir needs a directory');
      }
      index += 1;
    } else if (argument === '--inputs-file') {
      inputsFile = argv[index + 1];
      if (inputsFile === undefined || inputsFile.trim() === '') {
        throw new Error('--inputs-file needs a file');
      }
      index += 1;
    } else {
      throw new Error(`Unknown build argument: ${argument}`);
    }
  }
  return {
    development,
    exitWithParent,
    ...(outdir === undefined ? {} : { outdir }),
    ...(inputsFile === undefined ? {} : { inputsFile }),
  };
}

/** The command-line entry: build and report what was written. */
export async function runBuildCommand(
  log: (line: string) => void = console.log,
  runBuild: typeof buildApplication = buildApplication,
  argv: readonly string[] = [],
): Promise<ApplicationBuild> {
  const { exitWithParent: _exitWithParent, inputsFile, ...options } = parseBuildArguments(argv);
  const build = await runBuild(options);
  if (inputsFile !== undefined) await writeBuildInputs(inputsFile, build.metafile);
  log(`Built Interborough into ${build.directory} (${build.files.length} files)`);
  return build;
}

/** The process entry: parse the command line, watch standard input when asked, and build. */
export async function runBuildMain(
  argv: readonly string[],
  exit: (code: number) => void = process.exit.bind(process),
  log: (line: string) => void = console.log,
  runBuild: typeof buildApplication = buildApplication,
  input?: ReadableStream<Uint8Array>,
): Promise<void> {
  const { exitWithParent } = parseBuildArguments(argv);
  if (exitWithParent) exitWhenStandardInputCloses(input, exit);
  await runBuildCommand(log, runBuild, argv);
  // The standard-input reader keeps the process alive, so a build that finished exits itself.
  if (exitWithParent) exit(0);
}

if (import.meta.main) await runBuildMain(process.argv.slice(2));
