import { describe, expect, test } from 'bun:test';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';

import { findDriftedSvelteCopies, SVELTE_PLUGIN_COPIES } from './check-svelte-plugin-copies';

function repositoryWith(files: Record<string, string>): string {
  const directory = mkdtempSync(join(tmpdir(), 'svelte-plugin-copies-'));
  for (const [file, contents] of Object.entries(files)) {
    const path = join(directory, file);
    mkdirSync(dirname(path), { recursive: true });
    writeFileSync(path, contents);
  }
  return directory;
}

/** Every source and every copy, each copy equal to its source. */
function matchingFiles(): Record<string, string> {
  return Object.fromEntries(
    SVELTE_PLUGIN_COPIES.flatMap(({ source, copy }): [string, string][] => [
      [source, `export const source = ${JSON.stringify(source)};\n`],
      [copy, `export const source = ${JSON.stringify(source)};\n`],
    ]),
  );
}

describe('Weft’s copies of the Svelte compile plugin', () => {
  test('copy the plugin and the environment module it imports into Weft’s scripts/lib', () => {
    expect(SVELTE_PLUGIN_COPIES).toEqual([
      {
        source: 'testing/testing/src/svelte-plugin.ts',
        copy: 'packages/weft/scripts/lib/svelte-plugin.ts',
      },
      {
        source: 'testing/testing/src/environment-configuration.ts',
        copy: 'packages/weft/scripts/lib/environment-configuration.ts',
      },
    ]);
  });

  test('match their sources in this repository', async () => {
    expect(await findDriftedSvelteCopies(join(import.meta.dir, '..'))).toEqual([]);
  });

  test('report nothing when every copy matches its source', async () => {
    const directory = repositoryWith(matchingFiles());
    try {
      expect(await findDriftedSvelteCopies(directory)).toEqual([]);
    } finally {
      rmSync(directory, { recursive: true, force: true });
    }
  });

  test.each(SVELTE_PLUGIN_COPIES.map(({ copy }) => copy))(
    'report %s when it differs from its source by one byte',
    async (copy) => {
      const files = matchingFiles();
      files[copy] = `${files[copy] ?? ''} `;
      const directory = repositoryWith(files);
      try {
        expect(await findDriftedSvelteCopies(directory)).toEqual([copy]);
      } finally {
        rmSync(directory, { recursive: true, force: true });
      }
    },
  );

  test.each(SVELTE_PLUGIN_COPIES.map(({ copy }) => copy))(
    'report %s when it is missing',
    async (copy) => {
      const files = matchingFiles();
      delete files[copy];
      const directory = repositoryWith(files);
      try {
        expect(await findDriftedSvelteCopies(directory)).toEqual([copy]);
      } finally {
        rmSync(directory, { recursive: true, force: true });
      }
    },
  );
});
