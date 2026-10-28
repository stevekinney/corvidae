import { existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
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
  forwardStopSignals,
  narrowToSelection,
  partitionIntoShards,
  runUiShards,
  SHARD_COUNT,
  shardReportName,
  type ShardProcess,
  type SpawnShard,
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

/** A stand-in for a `bun test` child: it exits with `exitCode` after printing the two streams. */
function fakeChild(exitCode: number, standardOutput: string, standardError: string): ShardProcess {
  return {
    stdout: new Response(standardOutput).body as ReadableStream<Uint8Array>,
    stderr: new Response(standardError).body as ReadableStream<Uint8Array>,
    exited: Promise.resolve(exitCode),
    kill: () => undefined,
  };
}

describe('runUiShards', () => {
  const uiFlags = [
    '--config=./bunfig.ui.toml',
    '--path-ignore-patterns=**/*.slow.test.ts',
    '--path-ignore-patterns=src/host/**',
  ];

  /** A repository root with the package under `applications/interborough` and `count` UI tests. */
  function layout(name: string, count: number) {
    const repositoryRoot = join(scratch, name);
    const directory = 'applications/interborough';
    const packageDirectory = join(repositoryRoot, directory);
    const files = Array.from(
      { length: count },
      (_, index) => `src/lib/unit-${String(index).padStart(2, '0')}.test.ts`,
    );
    for (const file of files) touch(packageDirectory, file);
    touch(packageDirectory, 'src/host/host.test.ts');
    touch(packageDirectory, 'src/lib/skipped.slow.test.ts');
    const junit = join(packageDirectory, 'test-output', 'junit');
    for (const stale of ['ui.xml', 'ui-9.xml', 'fast.xml']) touch(junit, stale);
    return { repositoryRoot, directory, packageDirectory, files, junit };
  }

  /** Run with a fake spawner and report each command it was given, the output, and the exit code. */
  async function run(
    setup: ReturnType<typeof layout>,
    environment: Record<string, string | undefined>,
    exitCodes: readonly number[] = [],
  ) {
    const commands: string[][] = [];
    const environments: Record<string, string | undefined>[] = [];
    const directories: string[] = [];
    const spawn: SpawnShard = (command, options) => {
      commands.push(command);
      environments.push(options.env);
      directories.push(options.cwd);
      const exitCode = exitCodes[commands.length - 1] ?? 0;
      return fakeChild(exitCode, `out ${commands.length}\n`, `err ${commands.length}\n`);
    };
    const out: string[] = [];
    const err: string[] = [];
    const subscribed: string[] = [];
    const exitCode = await runUiShards([...uiFlags, 'src'], {
      packageRoot: setup.packageDirectory,
      repositoryRoot: setup.repositoryRoot,
      environment,
      spawn,
      subscribe: (signal) => {
        subscribed.push(signal);
      },
      writeStandardOutput: (text) => out.push(text),
      writeStandardError: (text) => err.push(text),
    });
    return {
      commands,
      environments,
      directories,
      out: out.join(''),
      err: err.join(''),
      exitCode,
      subscribed,
    };
  }

  const filesOf = (command: string[]) => command.filter((token) => token.startsWith('./'));

  it('runs every discovered file exactly once across shards with their own reports', async () => {
    const setup = layout('run-all', 10);
    const result = await run(setup, { KEEP: 'yes' });
    expect(result.commands).toHaveLength(SHARD_COUNT);
    expect(result.commands.map((command) => command[2])).toEqual([
      '--report-name=ui-1',
      '--report-name=ui-2',
      '--report-name=ui-3',
      '--report-name=ui-4',
    ]);
    for (const command of result.commands) {
      expect(command.slice(0, 2)).toEqual([
        'bun',
        join(setup.repositoryRoot, 'scripts', 'bun-test-junit.ts'),
      ]);
      expect(command).toContain('--config=./bunfig.ui.toml');
    }
    expectPartition(
      result.commands.map((command) => filesOf(command).map((file) => file.slice(2))),
      setup.files,
    );
    expect(result.directories).toEqual(Array(SHARD_COUNT).fill(setup.packageDirectory));
    expect(result.environments.every((environment) => environment['KEEP'] === 'yes')).toBe(true);
    expect(result.subscribed).toEqual(['SIGINT', 'SIGTERM']);
    expect(result.exitCode).toBe(0);
    expect(result.out).toContain('ui shard 1/4: 3 files, exit 0');
    expect(result.out).toContain('out 1');
    expect(result.err).toContain('err 4');
    // The single-process report and earlier shard reports go; the host lane's report stays.
    expect(existsSync(join(setup.junit, 'ui.xml'))).toBe(false);
    expect(existsSync(join(setup.junit, 'ui-9.xml'))).toBe(false);
    expect(existsSync(join(setup.junit, 'fast.xml'))).toBe(true);
  });

  it('starts no more shards than there are files and returns the first failing exit code', async () => {
    const setup = layout('run-few', 2);
    const result = await run(setup, {}, [0, 7]);
    expect(result.commands).toHaveLength(2);
    expect(result.exitCode).toBe(7);
  });

  it('runs only the selected files, hands the shards no selection, and runs nothing when it is empty', async () => {
    const setup = layout('run-selected', 6);
    const chosen = [setup.files[4] as string, setup.files[1] as string];
    const digest = writeManifest(
      { version: 1, workspaces: { [setup.directory]: { mode: 'partial', files: chosen } } },
      setup.repositoryRoot,
    );
    const selected = await run(setup, { [SELECTION_VARIABLE]: digest });
    expectPartition(
      selected.commands.map((command) => filesOf(command).map((file) => file.slice(2))),
      chosen,
    );
    expect(selected.environments.every((environment) => !(SELECTION_VARIABLE in environment))).toBe(
      true,
    );

    const emptyDigest = writeManifest({ version: 1, workspaces: {} }, setup.repositoryRoot);
    const empty = await run(setup, { [SELECTION_VARIABLE]: emptyDigest });
    expect(empty.commands).toHaveLength(0);
    expect(empty.exitCode).toBe(0);
    expect(empty.out).toContain('nothing to run');
    expect(existsSync(join(setup.junit, 'ui-9.xml'))).toBe(false);
  });
});

describe('forwardStopSignals', () => {
  it('passes the signal it received to every shard still running', () => {
    const handlers = new Map<string, () => void>();
    const killed: string[] = [];
    const child = {
      kill: (signal?: string) => killed.push(`${signal}`),
    } as unknown as ShardProcess;
    forwardStopSignals(new Set([child, child]), (signal, handler) => handlers.set(signal, handler));
    expect([...handlers.keys()]).toEqual(['SIGINT', 'SIGTERM']);
    handlers.get('SIGTERM')?.();
    expect(killed).toEqual(['SIGTERM']);
  });
});
