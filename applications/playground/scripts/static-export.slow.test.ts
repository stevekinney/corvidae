/**
 * The static export materializes a shell route for every navigable family child. It runs a real
 * export, which bundles the shell and renders every route it writes, so it is slow by nature and
 * lives in the `test:slow` lane (COR-1576). The rest of the export's tests are in
 * `static-export.test.ts`.
 */
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { describe, expect, test } from 'bun:test';

import { runStaticExport } from './static-export.ts';

describe('static export', () => {
  test('materializes shell routes for navigable family children', async () => {
    const outputDirectory = await mkdtemp(join(tmpdir(), 'cinder-static-export-family-'));
    try {
      const { files: rendered } = await runStaticExport({
        outputDirectory,
        sidebarComponents: ['chat'],
        allComponents: [],
      });
      // `/c/<name>` is a legacy alias redirected by the hosting configuration, so it must NOT
      // be written into build/ — that would restore a second documentation
      // surface on disk.
      expect(rendered.has('/c/chat')).toBe(false);
      expect(rendered.has('/c/chat-composer-popover')).toBe(false);
      expect(rendered.has('/page/chat-composer-popover')).toBe(true);
      expect(
        await readFile(
          join(outputDirectory, 'page', 'chat-composer-popover', 'index.html'),
          'utf8',
        ),
      ).toContain('data-component-page');
    } finally {
      await rm(outputDirectory, { recursive: true, force: true });
    }
  }, 120_000);
});
