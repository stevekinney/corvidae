/**
 * The reviews route replaced the inbox route with no alias (COR-1492): a page that still sent a
 * person to the old path would land on a route that no longer exists. The path is spelled in pieces
 * here, so this file does not match its own search.
 */
import { Glob } from 'bun';
import { describe, expect, test } from 'bun:test';
import { join } from 'node:path';

import { matchRoute } from '../lib/router.svelte.ts';

const SOURCE_ROOT = join(import.meta.dir, '..');
const RETIRED_PATH = ['', 'inbox'].join('/');

describe('the retired inbox path', () => {
  test('is named by no file under the application source, in either quote style', async () => {
    const offenders: string[] = [];
    for await (const file of new Glob('**/*').scan({ cwd: SOURCE_ROOT, onlyFiles: true })) {
      const text = await Bun.file(join(SOURCE_ROOT, file)).text();
      for (const quote of ["'", '"', '`']) {
        if (text.includes(`${quote}${RETIRED_PATH}${quote}`)) offenders.push(`${file} (${quote})`);
      }
    }
    expect(offenders).toEqual([]);
  });

  test('matches no route, so there is no alias', () => {
    expect(matchRoute(RETIRED_PATH)).toBeNull();
  });

  test('is replaced by /reviews, in the reviews view', () => {
    expect(matchRoute('/reviews')).toEqual({ pattern: '/reviews', params: {} });
  });
});
