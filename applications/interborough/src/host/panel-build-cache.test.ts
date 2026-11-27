/**
 * The panel build cache (COR-2219): a page built from unchanged inputs is served from the host's
 * storage directory without building it again, and a page is never served from an entry that is not
 * completely written. The counters and files are the subject, so every row below is a case with a
 * required result, run by one table-driven test per column that matters.
 *
 * | Row | Situation | Required result |
 * | --- | --- | --- |
 * | cold build | an empty directory | the build runs once, its page is returned, one entry is written |
 * | warm hit | the same inputs again | the build does not run, the page is the one built before |
 * | source changed | the entry file's bytes differ | the build runs, the entry holds the new page |
 * | import graph changed | a file the entry imports differs | the build runs |
 * | kit changed | a file of the Cinder kit in the graph differs | the build runs |
 * | Bun version changed | another Bun | the build runs |
 * | Svelte version changed | another resolved Svelte | the build runs |
 * | Cinder version changed | another resolved Cinder | the build runs |
 * | title or styles changed | what the page is wrapped with differs | the build runs |
 * | two builds at once | two callers, one panel, one moment | one build, both callers get its page |
 * | a build that fails | the build rejects | the caller gets the rejection, nothing is written, the next call builds |
 * | a build over the bound | never settles | the caller's deadline fires and reports it (panel-mounts.test.ts) |
 * | crash mid-write | the write of an entry stops half way | no entry is served from it, the next call builds and repairs |
 * | torn or edited entry | an entry that is not valid JSON, or whose bytes its digest does not name | a miss, and the next entry replaces it |
 * | source changed during the build | an input is newer than the build's start | the page is served, no entry is written |
 * | saved while the entry is hashed | an input is saved between the build and the digest | the page is served, no entry is written (the digest is taken first, the times checked after) |
 * | two roots, one home | the same panel, svelte and Cinder resolved from another root | the build runs; the first root's page is never served for the second |
 * | the host's build code changed | another digest of the build module | the build runs |
 * | restart | a new cache over the same directory | a hit, with no build |
 * | no recorded graph | the build reports no input files | the page is served, no entry is written |
 * | no directory | a remote home | the page is served and nothing is written, and one build still serves two callers |
 * | shared memory | a second cache of one process, with a directory of its own | the build does not run, and the directory is not read |
 * | shared memory, input changed | a file of the graph differs | the build runs |
 * | shared memory, one build at once | two caches, one panel, one moment | one build serves both |
 *
 * No row waits on a clock: the cache reads the time only through `now`, which each row sets.
 */
import { throwingRejectionOf } from '@lostgradient/testing/promise-outcome';
import { afterEach, describe, expect, test } from 'bun:test';
import { createHash } from 'node:crypto';
import { mkdir, mkdtemp, readdir, readFile, rm, utimes, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';

import {
  createPanelBuildCache,
  createPanelBuildMemory,
  type CachedPage,
  type PanelBuildCache,
  type PanelBuildCacheFileSystem,
  type PanelBuildInputs,
  type PanelBuildMemory,
} from './panel-build-cache.ts';
import { digestOf } from './panel-build.ts';

const directories: string[] = [];

afterEach(async () => {
  for (const directory of directories.splice(0)) {
    await rm(directory, { recursive: true, force: true });
  }
});

async function temporary(prefix: string): Promise<string> {
  const directory = await mkdtemp(join(tmpdir(), prefix));
  directories.push(directory);
  return directory;
}

/** A panel on disk: an entry, a file it imports, and a Cinder file, with the inputs that name them. */
async function panelSources() {
  const root = await temporary('panel-build-cache-sources-');
  const entry = join(root, 'panel.ts');
  const imported = join(root, 'model.ts');
  const kit = join(root, 'cinder', 'panel.ts');
  await mkdir(join(root, 'cinder'), { recursive: true });
  await writeFile(entry, "import './model.ts';\n");
  await writeFile(imported, 'export const model = 1;\n');
  await writeFile(kit, 'export const kit = 1;\n');
  const inputs: PanelBuildInputs = {
    entry: pathToFileURL(entry).href,
    title: 'Fixture panel',
    styles: 'body{margin:0}',
    bunVersion: '1.4.4',
    svelteVersion: '5.57.0',
    cinderVersion: 'unversioned:1',
    dependencies: '/roots/release-a/node_modules',
    buildCode: 'code-1',
  };
  return { root, entry, imported, kit, inputs, graph: [entry, imported, kit] };
}

/** A build that counts its runs and returns a page naming the run. */
function countingBuild(graph: readonly string[] | undefined) {
  const counter = { runs: 0 };
  const build = async (): Promise<CachedPage> => {
    counter.runs += 1;
    const html = `<html>build ${counter.runs}</html>`;
    return {
      html,
      contentDigest: digestOf(html),
      ...(graph === undefined ? {} : { inputs: graph }),
    };
  };
  return { counter, build };
}

/** The entry files (not the leftovers of an interrupted write) a cache directory holds. */
async function entriesIn(directory: string): Promise<string[]> {
  const names = await readdir(directory);
  return names.filter((name) => name.endsWith('.json')).toSorted((a, b) => a.localeCompare(b));
}

const PANEL = 'inspectors/run-inspector';
const LONG_AGO = () => 1_000;

function cacheOver(
  directory: string | undefined,
  extra: { fileSystem?: Partial<PanelBuildCacheFileSystem>; memory?: PanelBuildMemory } = {},
) {
  return createPanelBuildCache({
    ...(directory === undefined ? {} : { directory }),
    // Every source file below was written after this instant, which a row that wants a stored entry
    // overrides: a file newer than the build's start is a change during the build.
    now: () => Date.now() + 60_000,
    ...extra,
  });
}

describe('cold build and warm hit', () => {
  test('the first call builds once and writes one entry, the second serves it without building', async () => {
    const sources = await panelSources();
    const directory = await temporary('panel-build-cache-');
    const cache = cacheOver(directory);
    const { counter, build } = countingBuild(sources.graph);

    const first = await cache.serve(PANEL, sources.inputs, build);
    expect(counter.runs).toBe(1);
    // An entry is named by the first 32 hex digits of the SHA-256 of its panel's name.
    expect(await entriesIn(directory)).toEqual([
      `${createHash('sha256').update(PANEL).digest('hex').slice(0, 32)}.json`,
    ]);

    const second = await cache.serve(PANEL, sources.inputs, build);
    expect(counter.runs).toBe(1);
    expect(second).toEqual(first);
    expect(second.html).toBe('<html>build 1</html>');
  });

  test('a new cache over the same directory, a restart, serves the entry without building', async () => {
    const sources = await panelSources();
    const directory = await temporary('panel-build-cache-');
    const { counter, build } = countingBuild(sources.graph);
    const before = await cacheOver(directory).serve(PANEL, sources.inputs, build);

    const after = await cacheOver(directory).serve(PANEL, sources.inputs, build);
    expect(counter.runs).toBe(1);
    expect(after).toEqual(before);
  });

  test('every panel has an entry of its own', async () => {
    const sources = await panelSources();
    const directory = await temporary('panel-build-cache-');
    const cache = cacheOver(directory);
    const { counter, build } = countingBuild(sources.graph);
    await cache.serve('inspectors/run-inspector', sources.inputs, build);
    await cache.serve('inspectors/pending-review', sources.inputs, build);
    await cache.serve('inspectors/run-inspector', sources.inputs, build);
    expect(counter.runs).toBe(2);
    expect(await entriesIn(directory)).toHaveLength(2);
  });
});

describe('an input that changes misses the cache, one case for each', () => {
  type Change = (sources: Awaited<ReturnType<typeof panelSources>>) => Promise<PanelBuildInputs>;
  const rows: ReadonlyArray<readonly [name: string, change: Change]> = [
    [
      'the entry bytes',
      async (sources) => {
        await writeFile(sources.entry, "import './model.ts';\n// edited\n");
        return sources.inputs;
      },
    ],
    [
      'a file the entry imports (the import graph)',
      async (sources) => {
        await writeFile(sources.imported, 'export const model = 2;\n');
        return sources.inputs;
      },
    ],
    [
      'a file of the Cinder kit in the graph (the kit)',
      async (sources) => {
        await writeFile(sources.kit, 'export const kit = 2;\n');
        return sources.inputs;
      },
    ],
    [
      'a file the graph named that is gone',
      async (sources) => {
        await rm(sources.imported);
        // The build that follows no longer reads it.
        sources.graph.splice(sources.graph.indexOf(sources.imported), 1);
        return sources.inputs;
      },
    ],
    ['the Bun version', async (sources) => ({ ...sources.inputs, bunVersion: '1.4.5' })],
    [
      'the resolved Svelte version',
      async (sources) => ({ ...sources.inputs, svelteVersion: '5.58.0' }),
    ],
    [
      'the resolved Cinder version',
      async (sources) => ({ ...sources.inputs, cinderVersion: '0.1.0' }),
    ],
    [
      'the root the host resolves svelte and Cinder from (two roots, one home)',
      async (sources) => ({ ...sources.inputs, dependencies: '/roots/release-b/node_modules' }),
    ],
    ['the host’s own build code', async (sources) => ({ ...sources.inputs, buildCode: 'code-2' })],
    ['the title', async (sources) => ({ ...sources.inputs, title: 'Another title' })],
    ['the styles', async (sources) => ({ ...sources.inputs, styles: 'body{margin:1px}' })],
  ];

  test.each(rows.map((row) => [...row]))('%s', async (_name, change) => {
    const sources = await panelSources();
    const directory = await temporary('panel-build-cache-');
    const cache = cacheOver(directory);
    const { counter, build } = countingBuild(sources.graph);
    await cache.serve(PANEL, sources.inputs, build);
    expect(counter.runs).toBe(1);

    const changed = await change(sources);
    const page = await cache.serve(PANEL, changed, build);
    expect(counter.runs).toBe(2);
    expect(page.html).toBe('<html>build 2</html>');

    // The new entry replaced the old one: the same inputs now hit.
    await cache.serve(PANEL, changed, build);
    expect(counter.runs).toBe(2);
    expect(await entriesIn(directory)).toHaveLength(1);
  });

  test('inputs that did not change still hit after a file outside the graph changes', async () => {
    const sources = await panelSources();
    const directory = await temporary('panel-build-cache-');
    const cache = cacheOver(directory);
    const { counter, build } = countingBuild(sources.graph);
    await cache.serve(PANEL, sources.inputs, build);
    await writeFile(join(sources.root, 'unrelated.ts'), 'export {};\n');
    await cache.serve(PANEL, sources.inputs, build);
    expect(counter.runs).toBe(1);
  });
});

describe('two builds at once', () => {
  test('one panel built twice at once runs one build and gives both callers its page', async () => {
    const sources = await panelSources();
    const directory = await temporary('panel-build-cache-');
    const cache = cacheOver(directory);
    const gate = Promise.withResolvers<void>();
    let runs = 0;
    const build = async (): Promise<CachedPage> => {
      runs += 1;
      await gate.promise;
      const html = '<html>shared</html>';
      return { html, contentDigest: digestOf(html), inputs: sources.graph };
    };
    const first = cache.serve(PANEL, sources.inputs, build);
    const second = cache.serve(PANEL, sources.inputs, build);
    gate.resolve();
    const [one, two] = await Promise.all([first, second]);
    expect(runs).toBe(1);
    expect(two).toEqual(one);
    expect(await entriesIn(directory)).toHaveLength(1);
  });

  test('two panels at once build independently', async () => {
    const sources = await panelSources();
    const cache = cacheOver(await temporary('panel-build-cache-'));
    const { counter, build } = countingBuild(sources.graph);
    await Promise.all([
      cache.serve('inspectors/run-inspector', sources.inputs, build),
      cache.serve('inspectors/pending-review', sources.inputs, build),
    ]);
    expect(counter.runs).toBe(2);
  });

  test('a failed build is not shared with the call that comes after it', async () => {
    const sources = await panelSources();
    const cache = cacheOver(await temporary('panel-build-cache-'));
    const gate = Promise.withResolvers<void>();
    const failing = async (): Promise<CachedPage> => {
      await gate.promise;
      throw new Error('did not build');
    };
    const pending = cache.serve(PANEL, sources.inputs, failing);
    gate.resolve();
    expect(await throwingRejectionOf(pending)).toThrow('did not build');
    const { counter, build } = countingBuild(sources.graph);
    await cache.serve(PANEL, sources.inputs, build);
    expect(counter.runs).toBe(1);
  });
});

describe('a build that fails', () => {
  test('rejects to its caller, writes nothing, and is built again by the next call', async () => {
    const sources = await panelSources();
    const directory = await temporary('panel-build-cache-');
    const cache = cacheOver(directory);
    let runs = 0;
    const failing = async (): Promise<CachedPage> => {
      runs += 1;
      throw new Error(`failure ${runs}`);
    };
    expect(await throwingRejectionOf(cache.serve(PANEL, sources.inputs, failing))).toThrow(
      'failure 1',
    );
    expect(await readdir(directory)).toEqual([]);
    expect(await throwingRejectionOf(cache.serve(PANEL, sources.inputs, failing))).toThrow(
      'failure 2',
    );
    expect(runs).toBe(2);
  });

  test('a failure leaves the entry an earlier build wrote, to serve the unchanged inputs', async () => {
    const sources = await panelSources();
    const directory = await temporary('panel-build-cache-');
    const cache = cacheOver(directory);
    const { counter, build } = countingBuild(sources.graph);
    await cache.serve(PANEL, sources.inputs, build);
    await writeFile(sources.entry, '// edited\n');
    expect(
      await throwingRejectionOf(
        cache.serve(PANEL, sources.inputs, async () => {
          throw new Error('did not build');
        }),
      ),
    ).toThrow('did not build');
    // The old entry stays, though it no longer matches the edited entry: nothing wrong is served.
    expect(await entriesIn(directory)).toHaveLength(1);
    await cache.serve(PANEL, sources.inputs, build);
    expect(counter.runs).toBe(2);
  });
});

describe('an entry that is not completely written', () => {
  test('a crash mid-write leaves no entry to serve, and the next call builds and repairs it', async () => {
    const sources = await panelSources();
    const directory = await temporary('panel-build-cache-');
    const { writeFile: realWriteFile } = await import('node:fs/promises');
    let crash = true;
    const fileSystem: Partial<PanelBuildCacheFileSystem> = {
      writeFile: async (path, contents) => {
        if (!crash) return realWriteFile(path, contents);
        // Half of the bytes reach the disk, then the process is gone.
        await realWriteFile(path, contents.slice(0, Math.floor(contents.length / 2)));
        throw new Error('crash');
      },
    };
    const cache = cacheOver(directory, { fileSystem });
    const { counter, build } = countingBuild(sources.graph);

    // The page is served: a failed cache write never fails a panel.
    const first = await cache.serve(PANEL, sources.inputs, build);
    expect(first.html).toBe('<html>build 1</html>');
    expect(await entriesIn(directory)).toEqual([]);

    // The restart finds no entry, only what the write left beside it.
    const restarted = cacheOver(directory);
    const second = await restarted.serve(PANEL, sources.inputs, build);
    expect(counter.runs).toBe(2);
    expect(second.html).toBe('<html>build 2</html>');
    expect(await entriesIn(directory)).toHaveLength(1);

    crash = false;
    await cacheOver(directory).serve(PANEL, sources.inputs, build);
    expect(counter.runs).toBe(2);
  });

  test('an entry cut off at its final path is a miss that the next build replaces', async () => {
    const sources = await panelSources();
    const directory = await temporary('panel-build-cache-');
    const { counter, build } = countingBuild(sources.graph);
    await cacheOver(directory).serve(PANEL, sources.inputs, build);
    const [name] = await entriesIn(directory);
    const whole = await readFile(join(directory, name!), 'utf8');
    await writeFile(join(directory, name!), whole.slice(0, whole.length - 20));

    const page = await cacheOver(directory).serve(PANEL, sources.inputs, build);
    expect(counter.runs).toBe(2);
    expect(page.html).toBe('<html>build 2</html>');
    JSON.parse(await readFile(join(directory, name!), 'utf8'));
  });

  test('an entry whose page was edited after it was written is a miss', async () => {
    const sources = await panelSources();
    const directory = await temporary('panel-build-cache-');
    const { counter, build } = countingBuild(sources.graph);
    await cacheOver(directory).serve(PANEL, sources.inputs, build);
    const [name] = await entriesIn(directory);
    const entry = JSON.parse(await readFile(join(directory, name!), 'utf8')) as { html: string };
    entry.html = '<html>edited</html>';
    await writeFile(join(directory, name!), JSON.stringify(entry));

    const page = await cacheOver(directory).serve(PANEL, sources.inputs, build);
    expect(page.html).toBe('<html>build 2</html>');
    expect(counter.runs).toBe(2);
  });

  test('an entry of a shape this cache does not write is a miss', async () => {
    const sources = await panelSources();
    const directory = await temporary('panel-build-cache-');
    const { counter, build } = countingBuild(sources.graph);
    await cacheOver(directory).serve(PANEL, sources.inputs, build);
    const [name] = await entriesIn(directory);
    await writeFile(join(directory, name!), JSON.stringify({ schemaVersion: 2, html: '<p>' }));
    await cacheOver(directory).serve(PANEL, sources.inputs, build);
    expect(counter.runs).toBe(2);
  });
});

describe('what is not stored', () => {
  test('a page built while an input changed is served and not stored', async () => {
    const sources = await panelSources();
    const directory = await temporary('panel-build-cache-');
    // The build started at 1 second after the epoch; every file was written after that.
    const cache = createPanelBuildCache({ directory, now: LONG_AGO });
    await utimes(sources.entry, 5, 5);
    const { counter, build } = countingBuild(sources.graph);
    const page = await cache.serve(PANEL, sources.inputs, build);
    expect(page.html).toBe('<html>build 1</html>');
    expect(await readdir(directory).catch(() => [])).toEqual([]);
    await cache.serve(PANEL, sources.inputs, build);
    expect(counter.runs).toBe(2);
  });

  test('an input saved while the entry is being hashed is not stored under the new bytes’ digest', async () => {
    const sources = await panelSources();
    const directory = await temporary('panel-build-cache-');
    // Every file is old, so none is newer than the build's start until the save below.
    for (const file of sources.graph) await utimes(file, 5, 5);
    let saved = false;
    const cache = createPanelBuildCache({
      directory,
      now: Date.now,
      // The save lands as the cache reads the graph, after the page was built from the old bytes.
      readBytes: async (path) => {
        if (!saved && path === sources.imported) {
          saved = true;
          await writeFile(path, 'export const model = 2;\n');
        }
        return new Uint8Array(await Bun.file(path).arrayBuffer());
      },
    });
    const { counter, build } = countingBuild(sources.graph);
    await cache.serve(PANEL, sources.inputs, build);
    expect(saved).toBe(true);
    // The old page must not be served for the new bytes: nothing was stored, so this builds again.
    const page = await cache.serve(PANEL, sources.inputs, build);
    expect(counter.runs).toBe(2);
    expect(page.html).toBe('<html>build 2</html>');
  });

  test('an input saved during the build is not stored when the file clock trails now', async () => {
    const sources = await panelSources();
    const directory = await temporary('panel-build-cache-');
    for (const file of sources.graph) await utimes(file, 5, 5);
    let saved = false;
    const cache = createPanelBuildCache({
      directory,
      // Linux stamps a write from a clock that lags `Date.now()`; running `now` ahead stands in.
      now: () => Date.now() + 500,
      readBytes: async (path) => {
        if (!saved && path === sources.imported) {
          saved = true;
          await writeFile(path, 'export const model = 2;\n');
        }
        return new Uint8Array(await Bun.file(path).arrayBuffer());
      },
    });
    const { counter, build } = countingBuild(sources.graph);
    await cache.serve(PANEL, sources.inputs, build);
    expect(saved).toBe(true);
    await cache.serve(PANEL, sources.inputs, build);
    expect(counter.runs).toBe(2);
  });

  test('a page built with no recorded input files is served and not stored', async () => {
    const sources = await panelSources();
    const directory = await temporary('panel-build-cache-');
    const cache = cacheOver(directory);
    const { counter, build } = countingBuild(undefined);
    await cache.serve(PANEL, sources.inputs, build);
    await cache.serve(PANEL, sources.inputs, build);
    expect(counter.runs).toBe(2);
    expect(await readdir(directory).catch(() => [])).toEqual([]);
  });

  test('a home with no directory builds every time and still shares one build between two callers', async () => {
    const sources = await panelSources();
    const cache: PanelBuildCache = cacheOver(undefined);
    const { counter, build } = countingBuild(sources.graph);
    await cache.serve(PANEL, sources.inputs, build);
    await cache.serve(PANEL, sources.inputs, build);
    expect(counter.runs).toBe(2);

    const gate = Promise.withResolvers<void>();
    let runs = 0;
    const slow = async (): Promise<CachedPage> => {
      runs += 1;
      await gate.promise;
      return { html: '<html>x</html>', contentDigest: digestOf('<html>x</html>') };
    };
    const both = Promise.all([
      cache.serve(PANEL, sources.inputs, slow),
      cache.serve(PANEL, sources.inputs, slow),
    ]);
    gate.resolve();
    await both;
    expect(runs).toBe(1);
  });
});

describe('what a process remembers between hosts', () => {
  test('a second cache of the process serves the page without building, and without reading its directory', async () => {
    const sources = await panelSources();
    const memory = createPanelBuildMemory();
    const { counter, build } = countingBuild(sources.graph);
    const first = await cacheOver(await temporary('panel-build-cache-'), { memory }).serve(
      PANEL,
      sources.inputs,
      build,
    );

    const emptyDirectory = await temporary('panel-build-cache-');
    const second = await cacheOver(emptyDirectory, { memory }).serve(PANEL, sources.inputs, build);
    expect(counter.runs).toBe(1);
    expect(second).toEqual(first);
    // It never needed the directory, so it wrote nothing there.
    expect(await readdir(emptyDirectory)).toEqual([]);
  });

  test('serves a home with no directory from memory too', async () => {
    const sources = await panelSources();
    const memory = createPanelBuildMemory();
    const { counter, build } = countingBuild(sources.graph);
    await cacheOver(undefined, { memory }).serve(PANEL, sources.inputs, build);
    await cacheOver(undefined, { memory }).serve(PANEL, sources.inputs, build);
    expect(counter.runs).toBe(1);
  });

  test('misses when a file of the graph changed since the page was built', async () => {
    const sources = await panelSources();
    const memory = createPanelBuildMemory();
    const { counter, build } = countingBuild(sources.graph);
    await cacheOver(undefined, { memory }).serve(PANEL, sources.inputs, build);
    await writeFile(sources.kit, 'export const kit = 2;\n');
    const page = await cacheOver(undefined, { memory }).serve(PANEL, sources.inputs, build);
    expect(counter.runs).toBe(2);
    expect(page.html).toBe('<html>build 2</html>');
  });

  test('a page the directory held is remembered once it is read, so the next cache does not read it', async () => {
    const sources = await panelSources();
    const directory = await temporary('panel-build-cache-');
    const { counter, build } = countingBuild(sources.graph);
    await cacheOver(directory).serve(PANEL, sources.inputs, build);

    const memory = createPanelBuildMemory();
    await cacheOver(directory, { memory }).serve(PANEL, sources.inputs, build);
    await rm(directory, { recursive: true, force: true });
    await cacheOver(directory, { memory }).serve(PANEL, sources.inputs, build);
    expect(counter.runs).toBe(1);
  });

  test('two caches that share memory share one build of a panel at once', async () => {
    const sources = await panelSources();
    const memory = createPanelBuildMemory();
    const gate = Promise.withResolvers<void>();
    let runs = 0;
    const build = async (): Promise<CachedPage> => {
      runs += 1;
      await gate.promise;
      return { html: '<html>shared</html>', contentDigest: digestOf('<html>shared</html>') };
    };
    const first = cacheOver(undefined, { memory }).serve(PANEL, sources.inputs, build);
    const second = cacheOver(undefined, { memory }).serve(PANEL, sources.inputs, build);
    gate.resolve();
    await Promise.all([first, second]);
    expect(runs).toBe(1);
  });

  test('caches that share nothing share nothing', async () => {
    const sources = await panelSources();
    const { counter, build } = countingBuild(sources.graph);
    await cacheOver(undefined).serve(PANEL, sources.inputs, build);
    await cacheOver(undefined).serve(PANEL, sources.inputs, build);
    expect(counter.runs).toBe(2);
  });
});
