import { describe, expect, test } from 'bun:test';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';

import { findDriftedCopies, TEST_SUPPORT_COPIES } from './check-test-support-copies';

function repositoryWith(files: Record<string, string>): string {
  const directory = mkdtempSync(join(tmpdir(), 'test-support-copies-'));
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
    TEST_SUPPORT_COPIES.flatMap(({ source, copy }): [string, string][] => [
      [source, `export const source = ${JSON.stringify(source)};\n`],
      [copy, `export const source = ${JSON.stringify(source)};\n`],
    ]),
  );
}

describe('copies of @lostgradient/testing modules', () => {
  test('are the Svelte plugin and its environment module for Weft, and the hang guard for Weft and the root', () => {
    expect(TEST_SUPPORT_COPIES).toEqual([
      {
        source: 'testing/testing/src/svelte-plugin.ts',
        copy: 'packages/weft/scripts/lib/svelte-plugin.ts',
      },
      {
        source: 'testing/testing/src/environment-configuration.ts',
        copy: 'packages/weft/scripts/lib/environment-configuration.ts',
      },
      {
        source: 'testing/testing/src/hang-guard.ts',
        copy: 'packages/weft/scripts/lib/hang-guard.ts',
      },
      { source: 'testing/testing/src/hang-guard.ts', copy: 'scripts/hang-guard.ts' },
    ]);
  });

  test('match their sources in this repository', async () => {
    expect(await findDriftedCopies(join(import.meta.dir, '..'))).toEqual([]);
  });

  test('report nothing when every copy matches its source', async () => {
    const directory = repositoryWith(matchingFiles());
    try {
      expect(await findDriftedCopies(directory)).toEqual([]);
    } finally {
      rmSync(directory, { recursive: true, force: true });
    }
  });

  test.each(TEST_SUPPORT_COPIES.map(({ copy }) => copy))(
    'report %s when it differs from its source by one byte',
    async (copy) => {
      const files = matchingFiles();
      files[copy] = `${files[copy] ?? ''} `;
      const directory = repositoryWith(files);
      try {
        expect(await findDriftedCopies(directory)).toEqual([copy]);
      } finally {
        rmSync(directory, { recursive: true, force: true });
      }
    },
  );

  test.each(TEST_SUPPORT_COPIES.map(({ copy }) => copy))(
    'report %s when it is missing',
    async (copy) => {
      const files = matchingFiles();
      delete files[copy];
      const directory = repositoryWith(files);
      try {
        expect(await findDriftedCopies(directory)).toEqual([copy]);
      } finally {
        rmSync(directory, { recursive: true, force: true });
      }
    },
  );
});
