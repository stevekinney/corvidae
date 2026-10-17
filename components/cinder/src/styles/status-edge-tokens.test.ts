/**
 * A status-tinted edge uses `--cinder-status-*-border`, never the solid fill.
 *
 * The solid status tones are fills: saturated, and tuned so a label reads on
 * them. As a 1px edge they shout over the content they frame, and they are a
 * different color from the soft status surface they usually border. Each
 * status has a `border` token for exactly this. The one edge that does need the
 * danger fill, an invalid control's boundary, reaches it through
 * `--cinder-control-border-invalid`, so it never names a status solid here.
 *
 * Scans every workspace's component source, not only Cinder's, because Chat and
 * the applications paint status edges too.
 */

import { Glob } from 'bun';
import { join } from 'node:path';

import { expect, test } from 'bun:test';

const repositoryRoot = join(import.meta.dir, '..', '..', '..', '..');
const SOURCES = new Glob('{components,packages,applications}/*/src/**/*.{css,svelte}');
const STATUS_SOLID_EDGE =
  /(?:^|[;{\s])(border(?:-[a-z]+)*)\s*:\s*([^;{}]*var\(\s*--cinder-status-[a-z]+-solid[^;{}]*)/g;

test('no border declaration paints a status solid', async () => {
  const offenders: string[] = [];
  for await (const path of SOURCES.scan({ cwd: repositoryRoot })) {
    if (/[\\/](?:build|node_modules|\.svelte-kit)[\\/]/.test(path)) continue;
    const source = await Bun.file(join(repositoryRoot, path)).text();
    for (const match of source.matchAll(STATUS_SOLID_EDGE)) {
      const line = source.slice(0, match.index).split('\n').length;
      offenders.push(`${path}:${line}  ${match[1]}: ${match[2]!.trim()}`);
    }
  }
  expect(offenders, offenders.join('\n')).toEqual([]);
});
