import { describe, expect, test } from 'bun:test';
import { join } from 'node:path';

import { resolveRelativeSpecifier } from './check-virtual-list-dependency-free-graph.ts';
import { withTemporaryFileTree } from './check-virtual-list-dependency-free-test-utilities.ts';

describe('resolveRelativeSpecifier — unreadable candidates', () => {
  test('reports an unresolved import rather than crashing the guard', async () => {
    await withTemporaryFileTree({ 'entry.ts': '' }, async (root) => {
      expect(() =>
        resolveRelativeSpecifier('./nothing-here', join(root, 'entry.ts')),
      ).not.toThrow();
      expect(resolveRelativeSpecifier('./nothing-here', join(root, 'entry.ts'))).toBeUndefined();
    });
  });
});
