import { describe, expect, test } from 'bun:test';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { buildRelease } from './build-release.ts';

describe('the signed release archive', () => {
  // load-proof: real signed archive build deterministically verifies relocated host artifacts.
  // spawn-free: the real archive witness is the process-boundary behavior under test.
  test('builds and inspects a real relocated release archive', async () => {
    if (process.platform !== 'darwin' || process.arch !== 'arm64') return;
    const output = await mkdtemp(join(tmpdir(), 'interborough-release-test-'));
    try {
      const archive = await buildRelease(['--version', '0.0.0-test', '--outdir', output]);
      expect(await Bun.file(archive).exists()).toBe(true);
      const manifest = JSON.parse(
        await readFile(join(output, 'interborough', 'release.json'), 'utf8'),
      ) as { version: string; sourceSha: string; target: string };
      expect(manifest).toMatchObject({ version: '0.0.0-test', target: 'darwin-arm64' });
      expect(manifest.sourceSha).toMatch(/^[0-9a-f]{40}$/);
      const exportsMap = JSON.parse(
        await readFile(
          join(
            output,
            'interborough',
            'share/interborough/plugin-runtime/node_modules/@lostgradient/interborough-plugin/package.json',
          ),
          'utf8',
        ),
      ).exports as Record<string, string>;
      expect(exportsMap).toEqual({ '.': './index.js', './testing': './testing/index.js' });
    } finally {
      await rm(output, { recursive: true, force: true });
    }
  }, 30_000);
});
