/** Build and publish the native browser and authenticated document graphs together. */

import { existsSync, mkdtempSync, realpathSync, rmSync } from 'node:fs';
import { mkdir, readdir, rename, rm, writeFile } from 'node:fs/promises';
import { dirname, isAbsolute, join, relative, resolve, sep } from 'node:path';
import { fileURLToPath } from 'node:url';

import { buildProduction } from '@lostgradient/velveteen/build';
import { ensureCinderGenerated } from '../../../components/cinder/scripts/ensure-cinder-generated.ts';
import {
  BROWSER_BUILD_GENERATIONS,
  BUILD_INFO_FILE,
  readSourceInfo,
  UNKNOWN_COMMIT,
  type BuildInfo,
} from '../src/host/build-info.ts';
import { processEnvironment } from '../src/host/environment-configuration.ts';
import { NATIVE_DOCUMENT_DIRECTORY } from '../src/host/native-document-path.ts';
import { curatedShikiPlugin } from './browser-build.ts';
import { buildNativeDocuments } from './build-native-documents.ts';

/** The `@lostgradient/interborough` package root. */
export const PACKAGE_DIRECTORY = fileURLToPath(new URL('..', import.meta.url));

/** Where the application is built, and where the host looks by default. */
export const DEFAULT_BUILD_DIRECTORY = join(PACKAGE_DIRECTORY, 'build');

/** The repository root, which holds every workspace. */
export const REPOSITORY_ROOT = resolve(PACKAGE_DIRECTORY, '..', '..');

const stagingDirectories = new Set<string>();

/**
 * Publish both document graphs under one immutable generation, then commit one pointer.
 * A running reader keeps its original immutable directory until its requests finish.
 */
async function publishBrowserBuild(staging: string, directory: string, source: BuildInfo) {
  const generation = crypto.randomUUID();
  const generations = join(directory, BROWSER_BUILD_GENERATIONS);
  const published = join(generations, generation);
  const pending = join(directory, `.${BUILD_INFO_FILE}.${generation}`);
  await mkdir(generations, { recursive: true });
  await rename(staging, published);
  try {
    await writeFile(pending, `${JSON.stringify({ ...source, generation })}\n`);
    await rename(pending, join(directory, BUILD_INFO_FILE));
  } catch (error) {
    await rm(published, { recursive: true, force: true });
    throw error;
  } finally {
    await rm(pending, { force: true });
  }
  return published;
}

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
 * Refuse an output directory the build must never replace. The build publishes under the
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

/** Build native document graphs into a new directory and publish only when both succeed. */
export async function buildApplication(
  options: {
    readonly outdir?: string;
    readonly development?: boolean;
    readonly source?: BuildInfo;
    readonly ensureGenerated?: () => void | Promise<void>;
    readonly buildNative?: typeof buildNativeDocuments;
    readonly buildPrivate?: typeof buildProduction;
  } = {},
): Promise<ApplicationBuild> {
  const buildNative = options.buildNative ?? buildNativeDocuments;
  const buildPrivate = options.buildPrivate ?? buildProduction;
  const generationStarted = performance.now();
  const generated = await (options.ensureGenerated ?? ensureCinderGenerated)();
  const profiling = processEnvironment()['INTERBOROUGH_STARTUP_PROFILE'] === '1';
  if (profiling) {
    console.error(
      `STARTUP ${JSON.stringify({ stage: 'cinder', milliseconds: performance.now() - generationStarted, generated })}`,
    );
  }
  const bundleStarted = performance.now();
  const mode = options.development === true ? 'development' : 'production';
  const directory =
    options.outdir === undefined
      ? DEFAULT_BUILD_DIRECTORY
      : assertSafeOutputDirectory(options.outdir);
  const staging = mkdtempSync(join(dirname(directory), '.build-staging-'));
  stagingDirectories.add(staging);
  try {
    const source = options.source ?? { commit: UNKNOWN_COMMIT, changes: '' };
    const metafile: Bun.BuildMetafile = { inputs: {}, outputs: {} };
    const collect: NonNullable<Parameters<typeof buildProduction>[0]['onBuildMetadata']> = ({
      browser,
      server,
    }) => {
      Object.assign(metafile.inputs, browser.inputs, server.inputs);
      Object.assign(metafile.outputs, browser.outputs);
    };
    await buildNative(join(staging, NATIVE_DOCUMENT_DIRECTORY), { mode, onBuildMetadata: collect });
    await buildPrivate({
      projectDirectory: PACKAGE_DIRECTORY,
      routesDirectory: join(PACKAGE_DIRECTORY, 'src/private-routes'),
      outputDirectory: join(staging, 'private'),
      mode,
      browserPlugins: [curatedShikiPlugin],
      onBuildMetadata: collect,
    });
    await writeFile(join(staging, BUILD_INFO_FILE), `${JSON.stringify(source)}\n`);
    const entries = await readdir(staging, { recursive: true, withFileTypes: true });
    const files = entries
      .filter((entry) => entry.isFile())
      .map((entry) => relative(staging, join(entry.parentPath, entry.name)).split(sep).join('/'));
    const published = await publishBrowserBuild(staging, directory, source);
    if (profiling) {
      console.error(
        `STARTUP ${JSON.stringify({ stage: 'ui-bundle', milliseconds: performance.now() - bundleStarted })}`,
      );
    }
    return { directory: published, files: files.toSorted(), metafile };
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
    .filter((input) => !/(?:^|\/)(?:native-documents-|\.velveteen-graph-)[^/]+\//u.test(input))
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

/**
 * Build the application and record the checkout's current source in it. Every build made inside a
 * checkout goes through this (the command line, the end-to-end server, the release build), so a
 * server accepts it; {@link buildApplication} alone records an unknown commit, which a server
 * inside a checkout refuses.
 */
export const buildCheckoutApplication: typeof buildApplication = (options) =>
  buildApplication({ ...options, source: readSourceInfo(PACKAGE_DIRECTORY) });

if (import.meta.main) {
  // Only the command line reads the checkout's commit, so no unit test starts Git.
  await runBuildMain(process.argv.slice(2), undefined, undefined, buildCheckoutApplication);
}
