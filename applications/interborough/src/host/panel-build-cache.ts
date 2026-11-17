/**
 * A cache of built panel pages in the host's storage directory (COR-2219). Every start used to
 * rebuild every panel; a page whose inputs are unchanged is now read from one file instead.
 *
 * What an entry is keyed by: the entry file's bytes, the bytes of every file the build read (the
 * import graph, which includes the Cinder kit's own files), the Bun version, the resolved Svelte
 * and Cinder versions, and what the page is wrapped with (title and styles). The graph is stored
 * with the entry and read again on every lookup, so a change to any file in it, or to a file the
 * graph named that is now gone, is a miss. A file that appears in the graph without a stored file
 * having changed (a new file that shadows an old resolution) is the one change this cannot see, and
 * the next Bun, Svelte or Cinder version, or an edit of any file in the graph, replaces the entry.
 *
 * An entry is never served before it is completely written: a write goes to a temporary file that
 * is renamed over the entry, and a read checks the entry's own digest of its page and of its inputs,
 * so a file cut off at any byte is a miss. A page built while one of its inputs changed is served
 * and not stored, because the entry would name inputs the page was not built from.
 *
 * A process can also give its caches one shared {@link PanelBuildMemory}: a host started again in
 * the same process then serves a panel whose inputs are unchanged from what the first one built,
 * checking the same digest, without reading an entry. Each host of a test run starts that way.
 */
import { mkdir, readFile, rename, rm, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { z } from 'zod';

import { digestOf, type BuiltPanel } from './panel-build.ts';

/** The name of the folder in the host's content directory that holds the built pages. */
export const PANEL_BUILD_CACHE_FOLDER_NAME = 'panel-builds';

/** Bumped when what a build produces changes without any input changing. */
const PANEL_BUILD_FORMAT = 1;

/** What a page is built from, besides the files the build reads. */
export type PanelBuildInputs = {
  /** The panel's entry, as a `file:` URL. */
  readonly entry: string;
  /** The page's title. */
  readonly title: string;
  /** The plugin's own styles, placed after the kit's. */
  readonly styles: string;
  /** The Bun version that builds it. */
  readonly bunVersion: string;
  /** What names the host's Svelte: its version, or a digest of where it is and its manifest. */
  readonly svelteVersion: string;
  /** What names the host's Cinder: its version, or, with none, a digest of where it is and its manifest. */
  readonly cinderVersion: string;
  /** The real path of the `node_modules` `svelte` and Cinder resolve from, so two installs sharing a home never share a page. */
  readonly dependencies: string;
  /** A digest of the host's own build code, so a changed build never serves an older build's page. */
  readonly buildCode: string;
};

/** A built page, and the files the build read to make it when the builder reports them. */
export type CachedPage = BuiltPanel & {
  /** The absolute path of every file the build read. A page without them is not stored. */
  readonly inputs?: readonly string[];
};

/** The file operations the cache makes, so a test can stop one half way. */
export type PanelBuildCacheFileSystem = {
  /** Read an entry as text. */
  readonly readFile: (path: string) => Promise<string>;
  /** Write a whole file. */
  readonly writeFile: (path: string, contents: string) => Promise<void>;
  /** Move a file over another in one step. */
  readonly rename: (from: string, to: string) => Promise<void>;
  /** Make a directory and every parent. */
  readonly mkdir: (path: string) => Promise<void>;
  /** Remove a file, and nothing when it is absent. */
  readonly rm: (path: string) => Promise<void>;
};

/** What {@link createPanelBuildCache} takes. */
export type PanelBuildCacheOptions = {
  /** The directory the entries live in. Absent for a home with no local directory: nothing is stored. */
  readonly directory?: string;
  /** The file operations; each one not given is the real one. */
  readonly fileSystem?: Partial<PanelBuildCacheFileSystem>;
  /** The time, in milliseconds since the epoch. A page is stored only when no input is newer than its build's start. */
  readonly now?: () => number;
  /** Told why a page could not be stored. The page is served either way. */
  readonly report?: (message: string) => void;
  /**
   * What this process remembers of the pages it built, shared by every cache that is given it: a
   * second host started in the process serves a panel whose inputs did not change without reading
   * its entry or building it. Without it the cache remembers nothing between calls but what the
   * directory holds.
   */
  readonly memory?: PanelBuildMemory;
  /** Reads a file's bytes for the digest of the inputs; the file system's, unless a test saves a file as it is read. */
  readonly readBytes?: (path: string) => Promise<Uint8Array>;
};

/** What a process remembers of the pages it built, and the builds it has running. */
export type PanelBuildMemory = {
  /** The last page built for each panel, with the digest of its inputs and the files it read. */
  readonly pages: Map<
    string,
    { readonly inputsDigest: string; readonly files: readonly string[]; readonly page: BuiltPanel }
  >;
  /** The builds running now, so two callers for one panel share one. */
  readonly flights: Map<string, Promise<BuiltPanel>>;
};

/** An empty {@link PanelBuildMemory}. */
export function createPanelBuildMemory(): PanelBuildMemory {
  return { pages: new Map(), flights: new Map() };
}

/** A cache of built panel pages. */
export type PanelBuildCache = {
  /**
   * The page of `panel` for `inputs`: the stored one when every input is unchanged, otherwise the
   * result of `build`, which is stored. Two calls for one panel and one set of inputs at the same
   * moment share one build. A build that rejects rejects here, stores nothing, and is not shared
   * with a later call.
   */
  serve(
    panel: string,
    inputs: PanelBuildInputs,
    build: () => Promise<CachedPage>,
  ): Promise<BuiltPanel>;
};

const entrySchema = z.object({
  schemaVersion: z.literal(1),
  panel: z.string(),
  inputsDigest: z.string(),
  files: z.array(z.string()),
  html: z.string(),
  contentDigest: z.string(),
});

const REAL_FILE_SYSTEM: PanelBuildCacheFileSystem = {
  readFile: (path) => readFile(path, 'utf8'),
  writeFile: (path, contents) => writeFile(path, contents),
  rename,
  mkdir: async (path) => {
    await mkdir(path, { recursive: true });
  },
  rm: (path) => rm(path, { force: true }),
};

/** How many files are read at once when the graph is hashed. */
const HASH_BATCH = 64;

/** The bytes of the file at `path`. */
type ReadBytes = (path: string) => Promise<Uint8Array>;

const readFileBytes: ReadBytes = (path) => Bun.file(path).bytes();

/** The sha256 of a file's bytes, or `absent` when it cannot be read. */
async function fileDigest(path: string, readBytes: ReadBytes): Promise<string> {
  try {
    return new Bun.CryptoHasher('sha256').update(await readBytes(path)).digest('hex');
  } catch {
    return 'absent';
  }
}

/** One digest over the inputs and the bytes of the entry and of every file in `files`. */
async function inputsDigest(
  inputs: PanelBuildInputs,
  files: readonly string[],
  readBytes: ReadBytes,
): Promise<string> {
  const hasher = new Bun.CryptoHasher('sha256');
  hasher.update(
    JSON.stringify([
      PANEL_BUILD_FORMAT,
      inputs.entry,
      inputs.bunVersion,
      inputs.svelteVersion,
      inputs.cinderVersion,
      inputs.dependencies,
      inputs.buildCode,
      inputs.title,
      inputs.styles,
    ]),
  );
  hasher.update(`\0${await fileDigest(fileURLToPath(inputs.entry), readBytes)}`);
  for (let start = 0; start < files.length; start += HASH_BATCH) {
    const batch = files.slice(start, start + HASH_BATCH);
    const digests = await Promise.all(batch.map((file) => fileDigest(file, readBytes)));
    for (const [index, file] of batch.entries()) hasher.update(`\0${file}\0${digests[index]}`);
  }
  return hasher.digest('hex');
}

/** The cache of built panel pages over `options.directory`. */
export function createPanelBuildCache(options: PanelBuildCacheOptions = {}): PanelBuildCache {
  const { directory } = options;
  const files: PanelBuildCacheFileSystem = { ...REAL_FILE_SYSTEM, ...options.fileSystem };
  const now = options.now ?? Date.now;
  const { memory } = options;
  const readBytes = options.readBytes ?? readFileBytes;
  const flights = memory?.flights ?? new Map<string, Promise<BuiltPanel>>();

  /** The file an entry lives in: named by a digest of the panel, so no panel name is a path. */
  function entryPath(panel: string): string | undefined {
    if (directory === undefined) return undefined;
    const name = new Bun.CryptoHasher('sha256').update(panel).digest('hex').slice(0, 32);
    return join(directory, `${name}.json`);
  }

  async function lookup(
    panel: string,
    inputs: PanelBuildInputs,
    path: string | undefined,
  ): Promise<BuiltPanel | undefined> {
    const remembered = memory?.pages.get(panel);
    if (
      remembered !== undefined &&
      (await inputsDigest(inputs, remembered.files, readBytes)) === remembered.inputsDigest
    ) {
      return remembered.page;
    }
    return path === undefined ? undefined : readEntry(panel, inputs, path);
  }

  async function readEntry(
    panel: string,
    inputs: PanelBuildInputs,
    path: string,
  ): Promise<BuiltPanel | undefined> {
    let text: string;
    try {
      text = await files.readFile(path);
    } catch {
      return undefined;
    }
    let entry: z.infer<typeof entrySchema>;
    try {
      entry = entrySchema.parse(JSON.parse(text));
    } catch {
      return undefined;
    }
    if (entry.panel !== panel || digestOf(entry.html) !== entry.contentDigest) return undefined;
    if ((await inputsDigest(inputs, entry.files, readBytes)) !== entry.inputsDigest) {
      return undefined;
    }
    const page = { html: entry.html, contentDigest: entry.contentDigest };
    memory?.pages.set(panel, { inputsDigest: entry.inputsDigest, files: entry.files, page });
    return page;
  }

  async function store(
    panel: string,
    inputs: PanelBuildInputs,
    path: string | undefined,
    page: CachedPage,
    startedAt: number,
  ): Promise<void> {
    const graph = page.inputs;
    if (graph === undefined) return;
    // The digest is taken first and the times are checked after it. A save between the two would
    // otherwise be hashed in with the page built from the bytes before it; checked after, it is
    // newer than the build's start and the page is not stored.
    const digest = await inputsDigest(inputs, graph, readBytes);
    // An input newer than the start of the build may not be what the build read. A file that is
    // gone reads as newer than any build, so a graph that names one is not stored either.
    for (const file of [fileURLToPath(inputs.entry), ...graph]) {
      if (Bun.file(file).lastModified >= startedAt) return;
    }
    const entry = {
      schemaVersion: 1,
      panel,
      inputsDigest: digest,
      files: [...graph],
      html: page.html,
      contentDigest: page.contentDigest,
    };
    memory?.pages.set(panel, {
      inputsDigest: entry.inputsDigest,
      files: entry.files,
      page: { html: page.html, contentDigest: page.contentDigest },
    });
    if (path === undefined) return;
    const temporary = `${path}.tmp`;
    try {
      await files.mkdir(directory!);
      await files.writeFile(temporary, JSON.stringify(entry));
      await files.rename(temporary, path);
    } catch (error) {
      await files.rm(temporary).catch(() => undefined);
      options.report?.(
        `The built page of ${panel} was not stored: ${error instanceof Error ? error.message : String(error)}`,
      );
    }
  }

  async function serve(
    panel: string,
    inputs: PanelBuildInputs,
    build: () => Promise<CachedPage>,
  ): Promise<BuiltPanel> {
    const path = entryPath(panel);
    const stored = await lookup(panel, inputs, path);
    if (stored !== undefined) return stored;
    const startedAt = now();
    const built = await build();
    await store(panel, inputs, path, built, startedAt);
    return { html: built.html, contentDigest: built.contentDigest };
  }

  return {
    serve(panel, inputs, build) {
      const key = `${panel}\0${JSON.stringify(inputs)}`;
      const running = flights.get(key);
      if (running !== undefined) return running;
      // The entry leaves the table when the build settles, whichever way, so a failed build is
      // never handed to the call that comes after it.
      const flight = serve(panel, inputs, build).finally(() => flights.delete(key));
      flights.set(key, flight);
      return flight;
    },
  };
}
