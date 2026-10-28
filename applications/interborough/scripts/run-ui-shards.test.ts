import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { afterAll, describe, expect, it } from 'bun:test';

import {
  selectedFilesFor,
  SELECTION_VARIABLE,
  splitBunTestArguments,
  writeManifest,
} from '../../../scripts/affected-tests-manifest.ts';
import {
  discoverTestFiles,
  narrowToSelection,
  partitionIntoShards,
  SHARD_COUNT,
  shardReportName,
} from './run-ui-shards.ts';

const packageRoot = join(import.meta.dir, '..');
const scratch = mkdtempSync(join(tmpdir(), 'run-ui-shards-'));
afterAll(() => rmSync(scratch, { recursive: true, force: true }));

function touch(directory: string, path: string): void {
  const absolute = join(directory, path);
  mkdirSync(join(absolute, '..'), { recursive: true });
  writeFileSync(absolute, '');
}

/** The arguments the UI half of the package's `test` script passes to `run-ui-shards.ts`. */
async function packageUiArguments(): Promise<string[]> {
  const manifest = (await Bun.file(join(packageRoot, 'package.json')).json()) as {
    scripts: Record<string, string>;
  };
  const command = manifest.scripts['test']
    ?.split('&&')
    .map((part) => part.trim())
    .find((part) => part.includes('scripts/run-ui-shards.ts'));
  if (command === undefined) throw new Error('`test` does not call scripts/run-ui-shards.ts');
  return command
    .slice(command.indexOf('run-ui-shards.ts') + 'run-ui-shards.ts'.length)
    .trim()
    .split(/\s+/)
    .map((token) => token.replace(/^'(.*)'$/, '$1').replace(/='(.*)'$/, '=$1'));
}

function expectPartition(shards: readonly string[][], files: readonly string[]): void {
  const dealt = shards.flat();
  // No file in two shards, and none dropped.
  expect(new Set(dealt).size).toBe(dealt.length);
  expect(dealt.toSorted()).toEqual(files.toSorted());
}

describe('partitionIntoShards', () => {
  const files = Array.from(
    { length: 23 },
    (_, index) => `src/file-${String(index).padStart(2, '0')}.test.ts`,
  );

  it('deals every file to exactly one shard, round-robin over the sorted list', () => {
    const shards = partitionIntoShards(files.toReversed());
    expect(shards).toHaveLength(SHARD_COUNT);
    expectPartition(shards, files);
    for (const [index, file] of files.entries()) {
      expect(shards[index % SHARD_COUNT]).toContain(file);
    }
  });

  it('keeps the partition when there are fewer files than shards, and when there are none', () => {
    expectPartition(partitionIntoShards(files.slice(0, 2)), files.slice(0, 2));
    expect(
      partitionIntoShards(files.slice(0, 2)).filter((shard) => shard.length === 0),
    ).toHaveLength(2);
    expect(partitionIntoShards([])).toEqual([[], [], [], []]);
  });

  it('names a distinct report for every shard', () => {
    const names = Array.from({ length: SHARD_COUNT }, (_, index) => shardReportName(index + 1));
    expect(new Set(names).size).toBe(SHARD_COUNT);
    expect(names).toEqual(['ui-1', 'ui-2', 'ui-3', 'ui-4']);
  });
});

describe('discoverTestFiles', () => {
  it('honors roots and ignore patterns and skips node_modules', () => {
    const directory = join(scratch, 'discover');
    for (const path of [
      'src/a.test.ts',
      'src/b.spec.tsx',
      'src/not-a-test.ts',
      'src/slow.slow.test.ts',
      'src/host/h.test.ts',
      'src/node_modules/dependency/x.test.ts',
      'tests/e2e/e.test.ts',
      'tests/t.test.ts',
      'elsewhere/z.test.ts',
    ]) {
      touch(directory, path);
    }
    expect(
      discoverTestFiles(
        directory,
        ['src', 'tests'],
        ['**/*.slow.test.ts', 'src/host/**', 'tests/e2e/**'],
      ),
    ).toEqual(['src/a.test.ts', 'src/b.spec.tsx', 'tests/t.test.ts']);
  });

  it('finds the real UI suite without the host, slow, end-to-end or MCP app files', async () => {
    const { roots, ignorePatterns } = splitBunTestArguments(await packageUiArguments());
    const files = discoverTestFiles(packageRoot, roots, ignorePatterns);
    expect(files.length).toBeGreaterThan(50);
    expect(files).toContain('scripts/run-ui-shards.test.ts');
    for (const file of files) {
      expect(file).not.toMatch(/^src\/host\/|^tests\/e2e\/|^tests\/mcp-apps\/|\.slow\.test\.ts$/);
    }
    expectPartition(partitionIntoShards(files), files);
  });
});

describe('sharding under a selection', () => {
  const discovered = ['src/a.test.ts', 'src/b.test.ts', 'src/c.test.ts', 'tests/d.test.ts'];

  it('runs every discovered file when nothing is selected or the whole workspace is', () => {
    expect(narrowToSelection(discovered, null)).toEqual(discovered);
    expect(narrowToSelection(discovered, 'all')).toEqual(discovered);
  });

  it('runs only the selected files that this lane discovers, and an empty selection runs nothing', () => {
    const selected = ['tests/d.test.ts', 'src/a.test.ts', 'src/host/host.test.ts'];
    const narrowed = narrowToSelection(discovered, selected);
    expect(narrowed).toEqual(['src/a.test.ts', 'tests/d.test.ts']);
    expectPartition(partitionIntoShards(narrowed), narrowed);
    expect(narrowToSelection(discovered, [])).toEqual([]);
  });

  it('reads the selection a manifest records for this workspace', () => {
    const root = join(scratch, 'selection');
    const directory = 'applications/interborough';
    const digest = writeManifest(
      {
        version: 1,
        workspaces: {
          [directory]: { mode: 'partial', files: ['src/b.test.ts', 'tests/d.test.ts'] },
        },
      },
      root,
    );
    const selected = selectedFilesFor({ [SELECTION_VARIABLE]: digest }, directory, root);
    expect(narrowToSelection(discovered, selected)).toEqual(['src/b.test.ts', 'tests/d.test.ts']);
    // A workspace the manifest omits has nothing selected.
    expect(selectedFilesFor({ [SELECTION_VARIABLE]: digest }, 'packages/other', root)).toEqual([]);
    expect(narrowToSelection(discovered, selectedFilesFor({}, directory, root))).toEqual(
      discovered,
    );
  });
});
