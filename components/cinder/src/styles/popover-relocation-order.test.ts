import { readFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';

import { describe, expect, test } from 'bun:test';

/**
 * The popover's base rules used to load from an aggregator imported between `feed/feed.css` and
 * `file-upload/file-upload.css`. They now live in `popover/popover-surface.css`, imported from
 * `components.css` at that same position and from nowhere else. Keeping the position keeps the
 * cascade order against every competing rule, and the single import keeps the rules from being
 * served again by the sidecars that import `popover/popover.css`.
 */
const stylesDirectory = import.meta.dir;
const componentsDirectory = resolve(stylesDirectory, '../components');
const componentsStylesheet = resolve(stylesDirectory, 'components.css');
const surface = resolve(componentsDirectory, 'popover/popover-surface.css');
const IMPORT = /@import\s+(?:url\(\s*)?["']?([^"')\s]+\.css)["']?/g;

function importsOf(file: string): string[] {
  const source = readFileSync(file, 'utf8');
  return [...source.matchAll(IMPORT)].map((match) => resolve(dirname(file), match[1]!));
}

describe('popover surface stylesheet', () => {
  const entries = importsOf(componentsStylesheet);
  const at = entries.indexOf(surface);

  test('sits where the experimental aggregator sat: after feed.css, before file-upload.css', () => {
    expect(at).toBeGreaterThan(0);
    expect(entries[at - 1]).toBe(resolve(componentsDirectory, 'feed/feed.css'));
    expect(entries[at + 1]).toBe(resolve(componentsDirectory, 'file-upload/file-upload.css'));
  });

  test('is imported once, by components.css, and by no other stylesheet or module', async () => {
    expect(entries.filter((entry) => entry === surface)).toHaveLength(1);
    const importers: string[] = [];
    for (const pattern of ['src/**/*.css', 'src/**/*.ts', 'src/**/*.svelte']) {
      for await (const file of new Bun.Glob(pattern).scan({
        cwd: resolve(stylesDirectory, '../..'),
        absolute: true,
      })) {
        if (file.endsWith('popover-relocation-order.test.ts')) continue;
        if ((await Bun.file(file).text()).includes('popover-surface.css')) importers.push(file);
      }
    }
    expect(importers).toEqual([componentsStylesheet]);
  });

  test('the popover surface is a single cinder.components block', () => {
    const source = readFileSync(surface, 'utf8');
    expect(source.match(/^@layer cinder\.components \{/gm)).toHaveLength(1);
  });
});
