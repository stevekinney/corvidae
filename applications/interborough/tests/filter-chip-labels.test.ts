/**
 * The filter bar prints each applied chip as `<label>: <the option's label>`, so an `appliedFilters`
 * label must be the facet's label alone. A label that already carries the value prints it twice
 * (`Status: Paused: Paused`, COR-1992). This scans every route component that passes `appliedFilters`.
 */
import { Glob } from 'bun';
import { describe, expect, test } from 'bun:test';
import { join } from 'node:path';

const routesDirectory = join(import.meta.dir, '..', 'src', 'routes');

/** A `label:` whose template literal interpolates a value after a colon, such as `${facet}: ${value}`. */
const LABEL_WITH_VALUE = /label:\s*`[^`]*:\s*\$\{[^`]*`/;

describe('applied filter chip labels', () => {
  test('no route component bakes the filter value into an appliedFilters label', async () => {
    const offenders: string[] = [];
    let scanned = 0;
    for await (const path of new Glob('**/*.svelte').scan(routesDirectory)) {
      const source = await Bun.file(join(routesDirectory, path)).text();
      if (!source.includes('appliedFilters')) continue;
      scanned += 1;
      source.split('\n').forEach((line, index) => {
        if (LABEL_WITH_VALUE.test(line)) offenders.push(`${path}:${index + 1}: ${line.trim()}`);
      });
    }
    expect(scanned).toBeGreaterThanOrEqual(5);
    expect(offenders).toEqual([]);
  });
});
