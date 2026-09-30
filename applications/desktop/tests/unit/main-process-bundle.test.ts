import { afterEach, beforeEach, describe, expect, test } from 'bun:test';
import { mkdtemp, readdir, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';

import { throwingRejectionOf } from '@lostgradient/testing';

import {
  bundleMainProcess,
  mainProcessBundlePath,
  mainProcessEntrypoint,
} from '../../scripts/bundle-main-process.ts';

const projectRoot = path.resolve(import.meta.dir, '../..');

/**
 * COR-1389: Electrobun bundles `bun.entrypoint` with Cottontail's native
 * `Bun.build`, which segfaults intermittently on the real main-process graph.
 * The `build` scripts therefore hand it a file Bun already bundled. These tests
 * pin the three places that arrangement can quietly come apart.
 */
describe('the pre-bundled main process', () => {
  let directory: string;

  beforeEach(async () => {
    directory = await mkdtemp(path.join(os.tmpdir(), 'desktop-main-bundle-'));
  });

  afterEach(async () => {
    await rm(directory, { force: true, recursive: true });
  });

  test('inlines local modules, leaves Electrobun for its own build, and writes only the entry', async () => {
    await Bun.write(path.join(directory, 'helper.ts'), "export const greeting = 'hello';\n");
    await Bun.write(path.join(directory, 'styles.css'), 'body { color: red; }\n');
    await Bun.write(
      path.join(directory, 'entry.ts'),
      [
        "import { BrowserWindow } from 'electrobun/main';",
        "import { greeting } from './helper.ts';",
        "import './styles.css';",
        'console.log(greeting, BrowserWindow);',
        '',
      ].join('\n'),
    );
    const outputPath = path.join(directory, 'out', 'index.js');

    await bundleMainProcess({ entrypoint: path.join(directory, 'entry.ts'), outputPath });

    const bundle = await Bun.file(outputPath).text();
    expect(bundle).toContain('"electrobun/main"');
    expect(bundle).toContain('var greeting = "hello"');
    expect(bundle).not.toMatch(/from\s+"\.\/helper/u);
    // The stylesheet import comes back from Bun as a second output. Only the
    // entry point may reach the directory Electrobun reads.
    expect(await readdir(path.dirname(outputPath))).toEqual(['index.js']);
  });

  test('fails instead of writing a partial file when the graph does not resolve', async () => {
    await Bun.write(path.join(directory, 'entry.ts'), "import './missing.ts';\n");
    const outputPath = path.join(directory, 'out', 'index.js');

    expect(
      await throwingRejectionOf(
        bundleMainProcess({ entrypoint: path.join(directory, 'entry.ts'), outputPath }),
      ),
    ).toThrow('failed');
    expect(await Bun.file(outputPath).exists()).toBe(false);
  });

  test('is the entrypoint the build config uses only when the build scripts ask for it', async () => {
    const configurationPath = path.join(projectRoot, 'electrobun.config.ts');
    const originalFlag = process.env['DESKTOP_PREBUNDLED_MAIN'];
    try {
      delete process.env['DESKTOP_PREBUNDLED_MAIN'];
      const development = await import(`${configurationPath}?development`);
      process.env['DESKTOP_PREBUNDLED_MAIN'] = '1';
      const prebundled = await import(`${configurationPath}?prebundled`);

      expect(development.default.build.bun.entrypoint).toBe(mainProcessEntrypoint);
      expect(prebundled.default.build.bun.entrypoint).toBe(mainProcessBundlePath);
    } finally {
      if (originalFlag === undefined) delete process.env['DESKTOP_PREBUNDLED_MAIN'];
      else process.env['DESKTOP_PREBUNDLED_MAIN'] = originalFlag;
    }
  });

  test('is produced before, and selected for, every script that runs `electrobun build`', async () => {
    const packageJson: { scripts: Record<string, string> } = await Bun.file(
      path.join(projectRoot, 'package.json'),
    ).json();
    const buildScripts = Object.entries(packageJson.scripts).filter(([, command]) =>
      command.includes('electrobun build'),
    );

    expect(buildScripts.map(([name]) => name).toSorted()).toEqual(['build', 'build:stable']);
    for (const [name, command] of buildScripts) {
      const bundling = command.indexOf('bun run build:main');
      const building = command.indexOf('electrobun build');
      expect(bundling, `${name} must bundle the main process`).toBeGreaterThanOrEqual(0);
      expect(bundling, `${name} must bundle before Electrobun builds`).toBeLessThan(building);
      expect(command.slice(bundling, building), name).toContain('DESKTOP_PREBUNDLED_MAIN=1');
    }
    expect(packageJson.scripts['build:main']).toBe('bun scripts/bundle-main-process.ts');
  });
});
