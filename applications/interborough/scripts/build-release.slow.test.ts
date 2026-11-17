import { describe, expect, test } from 'bun:test';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { digestOf } from '../src/host/panel-build.ts';
import { prebuiltPanelSchema } from '../src/host/panel-mounts.ts';
import { buildRelease, workspacePanels } from './build-release.ts';

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
      // `buildRelease` has already started the relocated executable with `PATH` empty and had it
      // build a folder plugin's Cinder panel (a Svelte component through `@lostgradient/cinder/panel`)
      // from the staged runtime, and refused the release otherwise (COR-2217). What it built from is
      // staged here, and every workspace plugin's panels are prebuilt pages the host accepts.
      const runtime = join(
        output,
        'interborough',
        'share/interborough/plugin-runtime/node_modules',
      );
      for (const file of [
        'svelte/compiler/index.js',
        'svelte/package.json',
        '@lostgradient/cinder/src/panel/index.ts',
        '@lostgradient/cinder/src/panel/panel.css',
        '@modelcontextprotocol/ext-apps/package.json',
      ]) {
        expect(await Bun.file(join(runtime, file)).exists(), file).toBe(true);
      }
      const panels = await workspacePanels();
      expect(panels.length).toBeGreaterThan(0);
      for (const { plugin, app } of panels) {
        const prebuilt = prebuiltPanelSchema.parse(
          await Bun.file(
            join(output, 'interborough', 'share/interborough/panels', `${app.name}.json`),
          ).json(),
        );
        expect(prebuilt.uri, `${plugin}: ${app.name}`).toBe(app.uri);
        expect(digestOf(prebuilt.html), `${plugin}: ${app.name}`).toBe(prebuilt.contentDigest);
      }
    } finally {
      await rm(output, { recursive: true, force: true });
    }
  });
});
