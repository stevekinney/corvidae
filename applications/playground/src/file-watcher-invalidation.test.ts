import { describe, expect, it } from 'bun:test';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import {
  EDITOR_COMPONENT_SOURCE,
  componentExportNameFor,
  type ComponentSource,
} from './component-sources.ts';
import { invalidateCachesForChange, startWatcher, waitForPendingRebuild } from './file-watcher.ts';
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
