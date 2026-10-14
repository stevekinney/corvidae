import { describe, expect, it } from 'bun:test';
import { existsSync } from 'node:fs';
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { cleanPlayground } from './clean.ts';

describe('cleanPlayground', () => {
  it('removes build output, the export report, and scratch directories, and nothing else', async () => {
    const root = await mkdtemp(join(tmpdir(), 'playground-clean-'));
    try {
      for (const directory of ['.tmp', 'build', 'build-report', 'src/.tmp-abc', 'src/examples']) {
        await mkdir(join(root, directory), { recursive: true });
      }
      await writeFile(join(root, 'build-report', 'export-report.json'), '{}');
      await writeFile(join(root, 'src', 'examples', 'kept.ts'), '');

      await cleanPlayground(root);

      for (const removed of ['.tmp', 'build', 'build-report', 'src/.tmp-abc']) {
        expect(existsSync(join(root, removed))).toBe(false);
      }
      expect(existsSync(join(root, 'src', 'examples', 'kept.ts'))).toBe(true);
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });
});
