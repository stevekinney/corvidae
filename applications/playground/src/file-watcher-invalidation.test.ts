import { describe, expect, it } from 'bun:test';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { basename, dirname, join } from 'node:path';

import { pageArtifactByPath, publishPageArtifacts } from './build-artifacts-shared.ts';
import {
  COMPONENT_SOURCES,
  EDITOR_COMPONENT_SOURCE,
  componentExportNameFor,
  type ComponentSource,
} from './component-sources.ts';
import { invalidateCachesForChange, startWatcher, waitForPendingRebuild } from './file-watcher.ts';
import { pageEntryByName } from './page-bundle.ts';
import { PACKAGE_MAP_PATH } from './playground-paths.ts';
import { getRebuildGeneration } from './rebuild-generation.ts';

describe('invalidateCachesForChange', () => {
  // A watched `components.json` edit adds a component or renames an export. If the
  // export names read before the edit survived the invalidation, the next page
  // bundle would write a shim for an export that no longer exists, or fail to find
  // the new component, until the whole dev server restarted.
  it('makes the next page bundle read a changed components.json again', () => {
    const directory = mkdtempSync(join(tmpdir(), 'file-watcher-export-names-'));
    try {
      const manifestPath = join(directory, 'components.json');
      const write = (exportName: string) =>
        writeFileSync(manifestPath, JSON.stringify({ components: [{ id: 'alpha', exportName }] }));
      const source: ComponentSource = {
        ...EDITOR_COMPONENT_SOURCE,
        id: 'file-watcher-export-names-fixture',
        manifestPath,
      };

      write('Alpha');
      expect(componentExportNameFor(source, 'alpha')).toBe('Alpha');
      write('Beta');

      invalidateCachesForChange({ kind: 'components' });

      expect(componentExportNameFor(source, 'alpha')).toBe('Beta');
    } finally {
      rmSync(directory, { recursive: true, force: true });
    }
  });
});

describe('invalidateCachesForChange and the page chunks an example edit supersedes', () => {
  /**
   * What one page build publishes: its entry, the chunk holding its scenarios (content-hashed, so a
   * new one every time the example changes), and a chunk several pages share.
   */
  function publishPage(name: string, hash: string, sharedChunk = 'chunk-shared-core.js'): string {
    const entryPath = `page-${name}-${hash}.js`;
    publishPageArtifacts(
      name,
      new Map([
        [entryPath, `entry ${name} ${hash}`],
        [`chunk-${name}-scenarios-${hash}.js`, `scenarios ${name} ${hash}`],
        [sharedChunk, 'shared by every page'],
      ]),
    );
    pageEntryByName.set(name, entryPath);
    return entryPath;
  }

  function resetPageCaches(): void {
    invalidateCachesForChange({ kind: 'components' });
  }

  it('drops the chunks only the edited page referenced, so repeated saves do not accumulate them', () => {
    resetPageCaches();
    publishPage('alpha', 'a1');
    publishPage('beta', 'b1');
    const baseline = [...pageArtifactByPath.keys()].toSorted();

    for (const hash of ['a2', 'a3', 'a4']) {
      invalidateCachesForChange({ kind: 'examples', names: new Set(['alpha']) });
      publishPage('alpha', hash);
    }

    // Three saves later the map holds what one build of each page publishes, not three more
    // generations of alpha's scenario chunk.
    expect([...pageArtifactByPath.keys()].toSorted()).toEqual(
      [
        'chunk-alpha-scenarios-a4.js',
        'chunk-beta-scenarios-b1.js',
        'chunk-shared-core.js',
        'page-alpha-a4.js',
        'page-beta-b1.js',
      ].toSorted(),
    );
    expect(baseline).toHaveLength(pageArtifactByPath.size);
  });

  it('keeps a chunk another page still references and drops it with the last page that did', () => {
    resetPageCaches();
    publishPage('alpha', 'a1');
    publishPage('beta', 'b1');

    invalidateCachesForChange({ kind: 'examples', names: new Set(['alpha']) });
    expect(pageArtifactByPath.has('chunk-shared-core.js')).toBe(true);
    expect(pageArtifactByPath.has('page-beta-b1.js')).toBe(true);
    expect(pageArtifactByPath.has('page-alpha-a1.js')).toBe(false);

    invalidateCachesForChange({ kind: 'examples', names: new Set(['beta']) });
    expect(pageArtifactByPath.has('chunk-shared-core.js')).toBe(false);
    expect(pageArtifactByPath.size).toBe(0);
  });

  it('frees what a build that lost the race published after the edit on the next edit of that page', () => {
    resetPageCaches();
    publishPage('alpha', 'a1');

    // A build that started before the edit finishes after it: its artifacts still have to be
    // served to the request that triggered it, but no entry pointer is recorded for them.
    invalidateCachesForChange({ kind: 'examples', names: new Set(['alpha']) });
    publishPageArtifacts(
      'alpha',
      new Map([
        ['page-alpha-late.js', 'late entry'],
        ['chunk-alpha-scenarios-late.js', 'late scenarios'],
      ]),
    );
    expect(pageArtifactByPath.has('chunk-alpha-scenarios-late.js')).toBe(true);

    invalidateCachesForChange({ kind: 'examples', names: new Set(['alpha']) });
    expect(pageArtifactByPath.size).toBe(0);
  });

  it('clears every page artifact when a shell or component change invalidates every page', () => {
    resetPageCaches();
    publishPage('alpha', 'a1');
    publishPage('beta', 'b1');

    invalidateCachesForChange({ kind: 'shell' });

    expect(pageArtifactByPath.size).toBe(0);
    // Ownership is forgotten with them: a later single-page edit must not resurrect or leak anything.
    publishPage('alpha', 'a2');
    invalidateCachesForChange({ kind: 'examples', names: new Set(['alpha']) });
    expect(pageArtifactByPath.size).toBe(0);
  });
});

describe('startWatcher with watch events that carry no filename', () => {
  // Some filesystems and watch backends deliver an `fs.watch` event without a filename. The
  // component, markdown, examples, and playground-source trees each already say how far a change
  // there reaches, so a missing name must widen the invalidation, never drop the event.
  type WatchCallback = (event: string, filename: string | null) => void;

  function registerFakeWatchers(): { callbacks: WatchCallback[] } {
    const callbacks: WatchCallback[] = [];
    const fakeWatch = ((_path: string, ...rest: unknown[]) => {
      const callback = rest.find((argument) => typeof argument === 'function') as
        WatchCallback | undefined;
      if (callback !== undefined) callbacks.push(callback);
      return { close() {} };
    }) as unknown as Parameters<typeof startWatcher>[0];
    startWatcher(fakeWatch);
    return { callbacks };
  }

  it('invalidates when any watched tree reports a change without naming the file', async () => {
    const { callbacks } = registerFakeWatchers();
    expect(callbacks.length).toBeGreaterThan(0);

    for (const callback of callbacks) {
      const before = await waitForPendingRebuild();
      callback('change', null);
      const after = await waitForPendingRebuild();
      expect(after).toBeGreaterThan(before);
      expect(getRebuildGeneration()).toBe(after);
    }
  });
});

describe('startWatcher and the metadata files that change what every page shows', () => {
  type WatchCallback = (event: string, filename: string | null) => void;

  /** Start the watcher over a fake `watch` and record every path it asked to watch. */
  function startWithFakeWatch(): {
    watchedPaths: string[];
    callbackByPath: Map<string, WatchCallback>;
  } {
    const watchedPaths: string[] = [];
    const callbackByPath = new Map<string, WatchCallback>();
    const fakeWatch = ((path: string, ...rest: unknown[]) => {
      watchedPaths.push(path);
      const callback = rest.find((argument) => typeof argument === 'function') as
        WatchCallback | undefined;
      if (callback !== undefined) callbackByPath.set(path, callback);
      return { close() {} };
    }) as unknown as Parameters<typeof startWatcher>[0];
    startWatcher(fakeWatch);
    return { watchedPaths, callbackByPath };
  }

  /** Report an event to a watcher and say whether it invalidated the caches. */
  async function invalidates(
    callback: WatchCallback,
    event: string,
    filename: string | null,
  ): Promise<boolean> {
    const before = await waitForPendingRebuild();
    callback(event, filename);
    const after = await waitForPendingRebuild();
    return after > before;
  }

  const metadataFiles = [
    { label: 'the package map', path: PACKAGE_MAP_PATH },
    ...COMPONENT_SOURCES.flatMap((source) => [
      { label: `${source.id}'s package.json`, path: join(source.packageRoot, 'package.json') },
      { label: `${source.id}'s components.json`, path: source.manifestPath },
    ]),
  ];

  // A tool that saves one of these files by writing a temporary file and renaming it over the
  // original leaves a watch on the file attached to the replaced inode (measured under Node on
  // macOS, where a file watch reported the first save and none after it), so every later save goes
  // unnoticed until the server restarts. A watch on the containing directory sees the rename
  // whichever inode now sits behind the name.
  it('watches each metadata file through its directory and never the file itself', () => {
    const { watchedPaths } = startWithFakeWatch();

    for (const { label, path } of metadataFiles) {
      expect(watchedPaths, `${label} is watched as a file`).not.toContain(path);
      expect(watchedPaths, `the directory of ${label} is not watched`).toContain(dirname(path));
    }
  });

  it('watches a directory that holds several metadata files once', () => {
    const { watchedPaths } = startWithFakeWatch();

    for (const source of COMPONENT_SOURCES) {
      expect(watchedPaths.filter((path) => path === source.packageRoot)).toHaveLength(1);
    }
  });

  // Every documentation page shows its package's `lastPublishedVersion`, which it reads from the
  // mirror's package map. A dev server that never noticed that file change would keep showing the
  // old version until it restarted.
  it('invalidates when the package map is replaced by a rename', async () => {
    const { callbackByPath } = startWithFakeWatch();
    const onMirrorDirectoryChange = callbackByPath.get(dirname(PACKAGE_MAP_PATH));
    expect(onMirrorDirectoryChange).toBeDefined();

    // An atomic save reaches a directory watcher as a rename of the target's name.
    expect(await invalidates(onMirrorDirectoryChange!, 'rename', 'package-map.json')).toBe(true);
    expect(await invalidates(onMirrorDirectoryChange!, 'change', 'package-map.json')).toBe(true);
  });

  it('invalidates when a component package replaces its package.json or components.json', async () => {
    const { callbackByPath } = startWithFakeWatch();

    for (const source of COMPONENT_SOURCES) {
      const onPackageRootChange = callbackByPath.get(source.packageRoot);
      expect(onPackageRootChange, `${source.id}'s package root is not watched`).toBeDefined();
      expect(await invalidates(onPackageRootChange!, 'rename', 'package.json')).toBe(true);
      expect(await invalidates(onPackageRootChange!, 'rename', basename(source.manifestPath))).toBe(
        true,
      );
    }
  });

  // The mirror directory holds the other mirror maps and scripts, and a package root holds its
  // README, tests, and build output; none of them changes what a page shows.
  it('ignores a change to any other file in a watched metadata directory', async () => {
    const { callbackByPath } = startWithFakeWatch();

    const onMirrorDirectoryChange = callbackByPath.get(dirname(PACKAGE_MAP_PATH));
    expect(await invalidates(onMirrorDirectoryChange!, 'change', 'layout-map.json')).toBe(false);
    for (const source of COMPONENT_SOURCES) {
      const onPackageRootChange = callbackByPath.get(source.packageRoot);
      expect(await invalidates(onPackageRootChange!, 'change', 'README.md')).toBe(false);
      expect(await invalidates(onPackageRootChange!, 'rename', '.tmp-package.json')).toBe(false);
    }
  });

  it('ignores a file of the same name that a backend reports from a nested directory', async () => {
    const { callbackByPath } = startWithFakeWatch();

    for (const source of COMPONENT_SOURCES) {
      const onPackageRootChange = callbackByPath.get(source.packageRoot);
      expect(await invalidates(onPackageRootChange!, 'change', 'src/package.json')).toBe(false);
    }
  });

  it('matches a metadata file named with the separators a Windows watcher reports', async () => {
    const { callbackByPath } = startWithFakeWatch();
    const onMirrorDirectoryChange = callbackByPath.get(dirname(PACKAGE_MAP_PATH));

    expect(await invalidates(onMirrorDirectoryChange!, 'change', '.\\package-map.json')).toBe(true);
  });
});
