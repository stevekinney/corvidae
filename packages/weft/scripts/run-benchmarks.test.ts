import { describe, expect, it, spyOn } from 'bun:test';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { outcomeOf, rethrow } from '@lostgradient/testing/module-scope-scenario';
import packageJson from '../package.json' with { type: 'json' };
import { listBenchmarkFiles, runBenchmarks, spawnBunTest } from './run-benchmarks.ts';

// A real child is the behavior here, so it runs at module scope, off Bun's per-test clock.
const childExitCode = await outcomeOf(async () => {
  expect(await spawnBunTest(['bun', '-e', 'process.exit(3)'])).toBe(3);
  expect(await spawnBunTest(['bun', '-e', 'void 0'])).toBe(0);
});

describe('listBenchmarkFiles', () => {
  it('lists only the *.bench.ts files directly in the directory, sorted', () => {
    const directory = mkdtempSync(join(tmpdir(), 'run-benchmarks-'));
    try {
      for (const name of [
        'b.bench.ts',
        'a.bench.ts',
        'helper.test.ts',
        'helper.ts',
        'c.bench.js',
      ]) {
        writeFileSync(join(directory, name), '');
      }
      mkdirSync(join(directory, 'nested'));
      writeFileSync(join(directory, 'nested', 'deep.bench.ts'), '');
      expect(
        listBenchmarkFiles(directory).map((path) => path.slice(path.lastIndexOf('/') + 1)),
      ).toEqual(['a.bench.ts', 'b.bench.ts']);
    } finally {
      rmSync(directory, { recursive: true, force: true });
    }
  });

  it('finds the repository benchmarks as ./scripts/benchmarks paths and no test file', () => {
    const files = listBenchmarkFiles();
    expect(files.length).toBeGreaterThan(0);
    for (const file of files) expect(file).toMatch(/^\.\/scripts\/benchmarks\/[^/]+\.bench\.ts$/);
    expect(files).toContain('./scripts/benchmarks/cold-start.bench.ts');
    expect(files).toContain('./scripts/benchmarks/speculation.bench.ts');
  });
});

describe('spawnBunTest', () => {
  it('returns the exit code of the child it runs', () => rethrow(childExitCode));
});

describe('runBenchmarks', () => {
  it('runs every benchmark file in one bun test child and returns its exit code', async () => {
    const commands: string[][] = [];
    const exitCode = await runBenchmarks(async (command) => {
      commands.push(command);
      return 3;
    });
    expect(exitCode).toBe(3);
    expect(commands).toHaveLength(1);
    expect(commands[0]?.slice(0, 1)).toEqual(['bun']);
    expect(commands[0]?.[1]).toMatch(/scripts\/bun-test\.ts$/);
    expect(commands[0]?.slice(2)).toEqual(listBenchmarkFiles());
  });

  it('fails without spawning when no benchmark file matches', async () => {
    const directory = mkdtempSync(join(tmpdir(), 'run-benchmarks-empty-'));
    try {
      writeFileSync(join(directory, 'only.test.ts'), '');
      let spawned = false;
      const messages: string[] = [];
      const stderr = spyOn(process.stderr, 'write').mockImplementation((message) => {
        messages.push(String(message));
        return true;
      });
      let exitCode: number;
      try {
        exitCode = await runBenchmarks(async () => {
          spawned = true;
          return 0;
        }, directory);
      } finally {
        stderr.mockRestore();
      }
      expect(exitCode).toBe(1);
      expect(messages.join('')).toContain('no *.bench.ts files found');
      expect(spawned).toBe(false);
    } finally {
      rmSync(directory, { recursive: true, force: true });
    }
  });
});

describe('the package scripts separate benchmarks by file name', () => {
  it('has a test script that names no benchmark', () => {
    expect(packageJson.scripts.test).not.toContain('benchmarks');
    expect(packageJson.scripts.test).not.toContain('.bench.ts');
  });

  it('runs every benchmark through the glob runner, not a list', () => {
    expect(packageJson.scripts['test:benchmarks']).toBe('bun scripts/run-benchmarks.ts');
  });
});
