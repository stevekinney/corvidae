import { describe, expect, it } from 'bun:test';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { pageArtifactByPath, publishPageArtifacts } from './build-artifacts-shared.ts';
import {
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

describe('startWatcher and the package map the documentation reads its versions from', () => {
  type WatchCallback = (event: string, filename: string | null) => void;

  // Every documentation page shows its package's `lastPublishedVersion`, which it reads from the
  // mirror's package map. A dev server that never noticed that file change would keep showing the
  // old version until it restarted.
  it('watches the package map and invalidates when it changes', async () => {
    const callbackByPath = new Map<string, WatchCallback>();
    const fakeWatch = ((path: string, ...rest: unknown[]) => {
      const callback = rest.find((argument) => typeof argument === 'function') as
        WatchCallback | undefined;
      if (callback !== undefined) callbackByPath.set(path, callback);
      return { close() {} };
    }) as unknown as Parameters<typeof startWatcher>[0];
    startWatcher(fakeWatch);

    const onPackageMapChange = callbackByPath.get(PACKAGE_MAP_PATH);
    expect(onPackageMapChange).toBeDefined();

    const before = await waitForPendingRebuild();
    onPackageMapChange!('change', 'package-map.json');
    const after = await waitForPendingRebuild();
    expect(after).toBeGreaterThan(before);
  });
});
