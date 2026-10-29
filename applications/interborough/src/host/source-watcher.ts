/**
 * The development host's source watch. A rebuild depends on every workspace the browser bundle
 * imports (this application, Cinder, Chat, Markdown, and whatever those import in turn), and that
 * set changes whenever an import does, so it is not listed by hand: the build records the files it
 * read (`--inputs-file`, written by `scripts/build.ts`), and this module watches the directories
 * that hold them, refreshing the set after every build.
 *
 * Only directories that held an input are watched. A file that is not imported cannot change the
 * bundle, and a new import is an edit to a file that is already watched, after which the next
 * build records the new directory.
 *
 * @module source-watcher
 */

import { existsSync, watch as watchPath } from 'node:fs';
import { readFile } from 'node:fs/promises';
import { basename, dirname, join, sep } from 'node:path';

/** One thing to watch: a directory, with or without its subdirectories. */
export type WatchTarget = {
  readonly directory: string;
  /** Whether changes in subdirectories count. A package root is watched without them. */
  readonly recursive: boolean;
  /** When set, only a change to one of these names directly inside `directory` counts. */
  readonly files?: ReadonlySet<string>;
};

/** What {@link watchTargets} needs to know about the filesystem and the build. */
export type WatchTargetOptions = {
  /** Input files that are watched some other way, such as the entry page. */
  readonly ignore?: readonly string[];
  /** Whether `directory` is a package root. The default looks for a `package.json` in it. */
  readonly isPackageRoot?: (directory: string) => boolean;
};

const NODE_MODULES = `${sep}node_modules${sep}`;

function isPackageRootOnDisk(directory: string): boolean {
  return existsSync(join(directory, 'package.json'));
}

/**
 * The directories to watch for a build that read `inputs` (absolute file paths). Installed
 * dependencies are left out: a workspace is imported from its own directory, never from
 * `node_modules`. A directory that holds an input is watched recursively, and a directory beneath
 * another watched one is dropped, so a workspace's `src` is one watcher. A package root is the
 * exception: its subdirectories hold `node_modules` and tool output, so only the input files
 * that sit directly in it are watched.
 */
export function watchTargets(
  inputs: readonly string[],
  options: WatchTargetOptions = {},
): WatchTarget[] {
  const ignored = new Set(options.ignore ?? []);
  const isPackageRoot = options.isPackageRoot ?? isPackageRootOnDisk;
  const filesByDirectory = new Map<string, Set<string>>();
  for (const input of inputs) {
    if (ignored.has(input) || input.includes(NODE_MODULES)) continue;
    const directory = dirname(input);
    const files = filesByDirectory.get(directory) ?? new Set<string>();
    files.add(basename(input));
    filesByDirectory.set(directory, files);
  }
  const recursiveDirectories = [...filesByDirectory.keys()].filter(
    (directory) => !isPackageRoot(directory),
  );
  const covered = (directory: string): boolean =>
    recursiveDirectories.some(
      (other) => other !== directory && directory.startsWith(`${other}${sep}`),
    );
  const targets: WatchTarget[] = [];
  for (const [directory, files] of filesByDirectory) {
    if (covered(directory)) continue;
    targets.push(
      isPackageRoot(directory)
        ? { directory, recursive: false, files }
        : { directory, recursive: true },
    );
  }
  return targets.toSorted((left, right) => left.directory.localeCompare(right.directory));
}

/**
 * The absolute paths a build recorded in `file`, or `undefined` when the file is missing or is not
 * a JSON array of strings.
 */
export async function readBuildInputs(file: string): Promise<string[] | undefined> {
  let parsed: unknown;
  try {
    parsed = JSON.parse(await readFile(file, 'utf8'));
  } catch {
    return undefined;
  }
  if (!Array.isArray(parsed)) return undefined;
  return parsed.filter((entry): entry is string => typeof entry === 'string');
}

/** A started watch. */
export type DirectoryWatcher = {
  close(): void;
  on(event: 'error', listener: (error: Error) => void): unknown;
};

/** Start watching `path`; `fs.watch` by default, replaceable in tests. */
export type WatchDirectory = (
  path: string,
  options: { readonly recursive: boolean },
  listener: (event: string, filename: string | null) => void,
) => DirectoryWatcher;

const watchOnDisk: WatchDirectory = (path, options, listener) =>
  watchPath(path, { recursive: options.recursive }, (event, filename) => listener(event, filename));

/**
 * What a source watcher needs: the file the build records its inputs in, the directory to watch
 * until that file exists, and the callback for a change.
 */
export type SourceWatcherOptions = {
  /** The file the build records its inputs in. */
  readonly inputsFile: string;
  /** What to watch while that file is missing: the application's own source. */
  readonly fallbackDirectory: string;
  /** Called for every change under a watched directory. */
  readonly onChange: () => void;
  /** Input files that are watched some other way, such as the entry page. */
  readonly ignore?: readonly string[];
  /** Where the one line about the fallback goes. */
  readonly log?: (line: string) => void;
  readonly watch?: WatchDirectory;
  readonly isPackageRoot?: (directory: string) => boolean;
};

/** The watch over the sources a rebuild depends on. */
export type SourceWatcher = {
  /** Read the build's recorded inputs and watch the directories they name. */
  refresh(): Promise<void>;
  /** The directories being watched now, sorted. */
  directories(): string[];
  /** Stop watching. A later {@link SourceWatcher.refresh} does nothing. */
  close(): void;
};

type OpenWatch = { readonly key: string; readonly directory: string; readonly stop: () => void };

function targetKey(target: WatchTarget): string {
  const files = target.files === undefined ? '' : [...target.files].toSorted().join('\0');
  return `${target.recursive ? 'tree' : 'flat'}\0${target.directory}\0${files}`;
}

/**
 * Watch the directories the last build read from. Until a build has recorded its inputs, and
 * whenever the record cannot be read, only `fallbackDirectory` is watched and one line says so.
 */
export function createSourceWatcher(options: SourceWatcherOptions): SourceWatcher {
  const watch = options.watch ?? watchOnDisk;
  const log = options.log ?? ((line: string) => console.info(line));
  const open = new Map<string, OpenWatch>();
  let closed = false;
  let usingFallback = false;

  function start(target: WatchTarget): OpenWatch | undefined {
    try {
      const watcher = watch(
        target.directory,
        { recursive: target.recursive },
        (_event, filename) => {
          if (target.files !== undefined && filename !== null && !target.files.has(filename))
            return;
          options.onChange();
        },
      );
      // A watched directory that disappears (a renamed component folder) reports an error; the
      // rebuild it schedules refreshes the set.
      watcher.on('error', (error) => {
        log(`Watching ${target.directory} failed: ${error.message}`);
        options.onChange();
      });
      return { key: targetKey(target), directory: target.directory, stop: () => watcher.close() };
    } catch (error) {
      log(
        `Not watching ${target.directory}: ${error instanceof Error ? error.message : String(error)}`,
      );
      return undefined;
    }
  }

  return {
    async refresh() {
      const inputs = await readBuildInputs(options.inputsFile);
      if (closed) return;
      let targets =
        inputs === undefined
          ? []
          : watchTargets(inputs, {
              ...(options.ignore === undefined ? {} : { ignore: options.ignore }),
              ...(options.isPackageRoot === undefined
                ? {}
                : { isPackageRoot: options.isPackageRoot }),
            });
      if (targets.length === 0) {
        if (!usingFallback) {
          log(
            `No build inputs are recorded in ${options.inputsFile}; watching only ${options.fallbackDirectory}.`,
          );
        }
        usingFallback = true;
        targets = [{ directory: options.fallbackDirectory, recursive: true }];
      } else {
        usingFallback = false;
      }
      const wanted = new Map(targets.map((target) => [targetKey(target), target]));
      for (const [key, stale] of open) {
        if (wanted.has(key)) continue;
        stale.stop();
        open.delete(key);
      }
      for (const [key, target] of wanted) {
        if (open.has(key)) continue;
        const started = start(target);
        if (started !== undefined) open.set(key, started);
      }
    },
    directories() {
      return [...open.values()].map((entry) => entry.directory).toSorted();
    },
    close() {
      closed = true;
      for (const entry of open.values()) entry.stop();
      open.clear();
    },
  };
}
