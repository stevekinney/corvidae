import { describe, expect, test } from 'bun:test';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { buildRelease, parseReleaseArguments } from './build-release.ts';

describe('release arguments', () => {
  test('requires a semver and output directory', () => {
    expect(parseReleaseArguments(['--version', '1.2.3', '--outdir', '/tmp/release'])).toEqual({
      version: '1.2.3',
      outdir: '/tmp/release',
    });
    expect(() => parseReleaseArguments(['--outdir', '/tmp/release'])).toThrow('--version');
    expect(() =>
      parseReleaseArguments(['--version', 'latest', '--outdir', '/tmp/release']),
    ).toThrow('semver');
  });

  test('rejects unknown arguments', () => {
    expect(() => parseReleaseArguments(['--version', '1.2.3', '--nope'])).toThrow(
      'Unknown release argument',
    );
  });

  test('builds and inspects a real signed release archive', async () => {
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
