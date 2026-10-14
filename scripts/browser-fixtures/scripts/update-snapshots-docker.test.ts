import { describe, expect, it } from 'bun:test';
import { mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { manifestFixtureNames, readSuiteResults } from './update-snapshots-docker.ts';

describe('update-snapshots-docker helpers', () => {
  it('reads fixture names per component from the rendered manifest', () => {
    const manifest = JSON.stringify({
      entries: [
        { slug: 'button', fixtures: [{ name: 'primary' }, { name: 'assertion' }] },
        { slug: 'select', fixtures: [{ name: 'assertion' }] },
      ],
    });
    expect(manifestFixtureNames(manifest)).toEqual(
      new Map([
        ['button', ['primary', 'assertion']],
        ['select', ['assertion']],
      ]),
    );
  });

  it('summarizes the container JSON report, or reports none when the run produced none', () => {
    const directory = mkdtempSync(join(tmpdir(), 'update-snapshots-docker-'));
    expect(readSuiteResults(directory)).toBeUndefined();
    writeFileSync(
      join(directory, 'results.json'),
      JSON.stringify({ stats: { expected: 3, unexpected: 0, flaky: 0, skipped: 1 }, suites: [] }),
    );
    expect(readSuiteResults(directory)).toEqual({
      expected: 3,
      unexpected: 0,
      flaky: 0,
      skipped: 1,
      failures: [],
      flakyTests: [],
    });
  });
});
