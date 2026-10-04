import { describe, expect, it } from 'bun:test';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import {
  EDITOR_COMPONENT_SOURCE,
  componentExportNameFor,
  type ComponentSource,
} from './component-sources.ts';
import { invalidateCachesForChange } from './file-watcher.ts';

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
