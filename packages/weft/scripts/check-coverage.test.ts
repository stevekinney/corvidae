import { describe, expect, it, mock, spyOn } from 'bun:test';

import { outcomeOf, rethrow } from '../src/testing/module-scope-scenario.test-support.ts';
import {
  assembleAllowanceLayers,
  assertNoAllowanceKeyIsCoverageIgnored,
  buildAllowanceLayer,
  checkCoverage,
  CORVIDAE_COVERAGE_ALLOWANCES,
  COVERAGE_ALLOWANCES,
  formatCoverageFailureReason,
  listCoverageTestFiles,
  memoryFootprintUncoveredOutsideDarwin,
  parseLcov,
  readCoveragePathIgnorePatterns,
  readTestScriptPathIgnorePatterns,
  runCoverageShard,
  workflowEventFeedUncoveredLines,
} from './check-coverage.ts';
import { spawnWithHangGuard } from './lib/hang-guard.ts';

/** An already-closed byte stream, standing in for a spawned child's empty stdout/stderr. */
function closedByteStream(): ReadableStream<Uint8Array> {
  return new ReadableStream<Uint8Array>({
    start(controller) {
      controller.close();
    },
  });
}

// `listCoverageTestFiles()` runs `git ls-files` and the pattern scenario runs `bun test --coverage`,
// so both run here at module scope, off Bun's five-second per-test clock; each test rethrows its
// outcome.

const listedTestFiles = await outcomeOf(async () => {
  const files = await listCoverageTestFiles();

  expect(files).toContain('scripts/check-coverage.test.ts');
  expect(files).toContain('scripts/check-implementation-file-sizes.test.ts');
  expect(files).not.toContain('scripts/check-coverage.ts');
  expect(files.some((file) => file.includes('node_modules/'))).toBe(false);
  expect(files.some((file) => file.startsWith('coverage/'))).toBe(false);
  expect(files).toEqual(files.toSorted());
});

const benchmarkExclusions = await outcomeOf(async () => {
  const excluded = readTestScriptPathIgnorePatterns();
  expect(excluded).toEqual([
    // The slow lane (`test:slow`) runs these alone, serially; coverage leaves them out with the test.
    '**/*.slow.test.ts',
    'scripts/benchmarks/activity-completions.test.ts',
    'scripts/benchmarks/bun-sql.test.ts',
    'scripts/benchmarks/cold-start.test.ts',
    'scripts/benchmarks/load-growth-memory.test.ts',
    'scripts/benchmarks/memory-footprint-growth.test.ts',
    'scripts/benchmarks/memory-per-workflow.test.ts',
    'scripts/benchmarks/recovery.test.ts',
    'scripts/benchmarks/token-stream-latency.test.ts',
    'scripts/benchmarks/worker-spawn.test.ts',
    'scripts/benchmarks/workflow-starts.test.ts',
    'src/ui/**',
    'scripts/ui-browser/**',
    'scripts/ui-coverage/**',
  ]);
  const files = await listCoverageTestFiles();
  for (const path of excluded) expect(files).not.toContain(path);
  expect(files).not.toContain('src/cli/codegen-typecheck.slow.test.ts');
  expect(files).not.toContain('src/client/empty-registry-overloads-typecheck.slow.test.ts');
  // The benchmark directory's unit tests are not measurement runs and stay in the shard.
  expect(files).toContain('scripts/benchmarks/coverage-mode.test.ts');
  expect(files).toContain('scripts/benchmarks/environment-configuration.test.ts');
});

const uiExclusions = await outcomeOf(async () => {
  const files = await listCoverageTestFiles();
  const uiTrees = ['src/ui/', 'scripts/ui-browser/', 'scripts/ui-coverage/'];
  expect(files.filter((file) => uiTrees.some((tree) => file.startsWith(tree)))).toEqual([]);
  // The engine's own tests around the UI's trees stay in the shard.
  expect(files).toContain('tests/ui-boundary.test.ts');
  expect(files).toContain('scripts/check-coverage.test.ts');
});

describe('listCoverageTestFiles', () => {
  it('discovers only repository-owned test files without depending on ripgrep', () =>
    rethrow(listedTestFiles));

  /**
   * The measurement benchmarks that `bun run test` excludes are excluded from the coverage shard
   * too, and from the same list: the shard reads the script rather than keeping its own copy, so
   * the two cannot drift. Pinned against the concrete list so a script edit that drops one is a
   * visible change here rather than a silently widened shard.
   */
  it('excludes exactly the measurement benchmarks and UI trees the test script excludes', () =>
    rethrow(benchmarkExclusions));

  /**
   * The UI's tests run in the `test` script's second invocation and are gated by the UI's ratchet
   * (`scripts/ui-coverage/`), so the engine shard, read from the same exclusions as globs, holds
   * no path under any of the UI's three trees.
   */
  it('lists no test under src/ui, scripts/ui-browser, or scripts/ui-coverage', () =>
    rethrow(uiExclusions));
});

// The pipe scenario below runs the coverage CLI in a real child process, which takes seconds on a
// loaded host, so it runs here at module scope, off Bun's five-second per-test clock; its test
// rethrows the outcome.

const scenario1 = await outcomeOf(async () => {
  // A real child process with piped stderr, because the defect only exists there:
  // `process.exit()` discarded whatever the pipe had not yet accepted, and a
  // `console.error` issued behind a large queued `process.stderr.write` was dropped,
  // so a failing run's tail was cut mid-line and its stage reason never arrived.
  const { mkdtemp, rm, writeFile } = await import('node:fs/promises');
  const { join } = await import('node:path');
  const { tmpdir } = await import('node:os');

  const payloadBytes = 2 * 1024 * 1024;
  // `checkCoverage` removes `coverage/` under its working directory, so the child runs
  // in a scratch directory rather than this package.
  const root = await mkdtemp(join(tmpdir(), 'weft-cov-pipe-'));
  try {
    const entry = join(root, 'failing-coverage-cli.ts');
    await writeFile(
      entry,
      [
        `import { runCheckCoverageCli, runCoverageShard } from ${JSON.stringify(new URL('./check-coverage.ts', import.meta.url).pathname)};`,
        `const payload = new TextEncoder().encode('x'.repeat(${String(payloadBytes)}));`,
        `const stream = (bytes) => new ReadableStream({ start(controller) { if (bytes) controller.enqueue(bytes); controller.close(); } });`,
        `await runCheckCoverageCli({`,
        `  listCoverageTestFiles: async () => ['src/example.test.ts'],`,
        `  runCoverageShard: (shard) => runCoverageShard(shard, {`,
        `    spawnCoverageProcess: () => ({ exited: Promise.resolve(1), signalCode: null, stdout: stream(payload), stderr: stream() }),`,
        `  }),`,
        `});`,
        '',
      ].join('\n'),
    );

    const child = spawnWithHangGuard(['bun', entry], {
      cwd: root,
      stdout: 'pipe',
      stderr: 'pipe',
    });
    const [stderr, exitCode] = await Promise.all([new Response(child.stderr).text(), child.exited]);

    expect(exitCode).toBe(1);
    // `toBe(true)` rather than `toContain`, so a failure does not print 2 MiB of payload.
    expect(stderr.includes('x'.repeat(payloadBytes))).toBe(true);
    expect(stderr).toContain('exiting non-zero at stage "child exit"');
    expect(stderr.endsWith('Coverage execution failed.\n')).toBe(true);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

describe('parseLcov', () => {
  it('accepts DA lines with the optional checksum field', () => {
    const coverage = parseLcov(
      [
        'SF:src/example.ts',
        'FNF:0',
        'FNH:0',
        'DA:10,1,abc123',
        'DA:11,0,def456',
        'end_of_record',
      ].join('\n'),
    );

    expect(coverage.lines.total).toBe(2);
    expect(coverage.lines.hit).toBe(1);
    expect(coverage.lines.missed).toBe(1);
    expect(coverage.covered).toBe(false);
    expect(coverage.uncoveredFiles).toEqual(['src/example.ts']);
  });

  it('rejects a line allowance that points at covered code', () => {
    expect(() =>
      parseLcov(
        [
          'SF:src/core/context/parallel-operations.ts',
          'FNF:0',
          'FNH:0',
          'DA:19,1',
          'end_of_record',
        ].join('\n'),
      ),
    ).toThrow(
      'Coverage allowance for src/core/context/parallel-operations.ts:19 points at a covered line',
    );
  });

  it('applies the strict parallel-operation allowance only to its current uncovered lines', () => {
    const coverage = parseLcov(
      [
        'SF:src/core/context/parallel-operations.ts',
        'FNF:0',
        'FNH:0',
        'DA:19,0',
        'DA:20,0',
        'DA:21,0',
        'DA:22,1',
        'DA:31,0',
        'DA:37,0',
        'DA:38,0',
        'DA:39,0',
        'end_of_record',
      ].join('\n'),
    );

    expect(coverage.covered).toBe(true);
    expect(coverage.lines).toEqual({ total: 1, hit: 1, missed: 0 });
  });

  it('ignores generated temporary workflow artifacts', () => {
    const generatedFiles = [
      'weft-schedule-workflows-example.ts',
      'weft-schedule-input-example.ts',
      'weft-schedule-lmdb-workflows-example.ts',
      'weft-schedule-lmdb-input-example.ts',
      'weft-cli-edge-workflows-example.ts',
      'weft-validate-TA9zHl/conflict.ts',
      'weft-schedule-workflows-2KvtDp/module.ts',
      'weft-schedule-input-onrb4t/module.ts',
      'weft-schedule-lmdb-workflows-gyHZF8/module.ts',
    ];
    const generatedPrefixes = [
      '../../../../../../var/folders/x_/tmp',
      '../../../../../private/var/folders/x_/T',
      '../../../../../var/folders/x_/T',
      // Deep git-worktree forms (#503): a worktree nested under .claude/worktrees/<name>
      // records temp-fixture paths with more `../` segments and a `private/tmp/` or
      // bare `tmp/` root instead of `var/folders/`. These must be filtered too.
      '../../../../../../../private/tmp/claude-501',
      '../../../../../../../tmp/claude-501',
    ];

    for (const generatedPrefix of generatedPrefixes) {
      for (const generatedFile of generatedFiles) {
        const coverage = parseLcov(
          [
            `SF:${generatedPrefix}/${generatedFile}`,
            'FNF:1',
            'FNH:0',
            'DA:1,0',
            'end_of_record',
            'SF:src/example.ts',
            'FNF:1',
            'FNH:1',
            'DA:1,1',
            'end_of_record',
          ].join('\n'),
        );

        expect(coverage.covered).toBe(true);
        expect(coverage.lines).toEqual({ total: 1, hit: 1, missed: 0 });
        expect(coverage.functions).toEqual({ total: 1, hit: 1, missed: 0 });
        expect(coverage.uncoveredFiles).toEqual([]);
      }
    }
  });

  it('does not ignore nearby non-generated temporary files', () => {
    const coverage = parseLcov(
      [
        'SF:../../../../../../private/var/folders/x_/tmp/weft-schedule-output-example.ts',
        'FNF:1',
        'FNH:0',
        'DA:1,0',
        'end_of_record',
      ].join('\n'),
    );

    expect(coverage.covered).toBe(false);
    expect(coverage.lines).toEqual({ total: 1, hit: 0, missed: 1 });
    expect(coverage.functions).toEqual({ total: 1, hit: 0, missed: 1 });
    expect(coverage.uncoveredFiles).toEqual([
      '../../../../../../private/var/folders/x_/tmp/weft-schedule-output-example.ts',
    ]);
  });

  // The widened temp-root prefix now also matches `private/tmp/` and bare `tmp/` at
  // any `../` depth (#503). Prove that widening alone does NOT suppress coverage: a
  // non-fixture-named source file under those newly-accepted roots and deep worktree
  // depth must still count as uncovered, because the fixture-NAME matcher gates it.
  it('does not ignore non-generated temporary files under the widened tmp roots', () => {
    const nonFixturePaths = [
      '../../../../../../../private/tmp/claude-501/weft-schedule-output-example.ts',
      '../../../../../../../tmp/claude-501/weft-schedule-output-example.ts',
    ];

    for (const nonFixturePath of nonFixturePaths) {
      const coverage = parseLcov(
        [`SF:${nonFixturePath}`, 'FNF:1', 'FNH:0', 'DA:1,0', 'end_of_record'].join('\n'),
      );

      expect(coverage.covered).toBe(false);
      expect(coverage.lines).toEqual({ total: 1, hit: 0, missed: 1 });
      expect(coverage.functions).toEqual({ total: 1, hit: 0, missed: 1 });
      expect(coverage.uncoveredFiles).toEqual([nonFixturePath]);
    }
  });

  it('applies the audited workflow-runner allowance from the top-off layer', () => {
    const coverage = parseLcov(
      [
        'SF:src/workers/workflow-runner.ts',
        'FNF:1',
        'FNH:0',
        'DA:523,0',
        'DA:999,1',
        'end_of_record',
      ].join('\n'),
    );

    expect(coverage.covered).toBe(true);
    expect(coverage.lines).toEqual({ total: 1, hit: 1, missed: 0 });
    expect(coverage.functions).toEqual({ total: 0, hit: 0, missed: 0 });
    expect(coverage.uncoveredFiles).toEqual([]);
  });

  it('preserves strict uncovered-line checks when a top-off is assembled', () => {
    expect(() =>
      parseLcov(
        [
          'SF:scripts/benchmarks/benchmark-subprocess.ts',
          'FNF:0',
          'FNH:0',
          'DA:28,1',
          'end_of_record',
        ].join('\n'),
      ),
    ).toThrow(
      'Coverage allowance for scripts/benchmarks/benchmark-subprocess.ts:28 points at a covered line',
    );
  });

  // spawn-free: stubbed listCoverageTestFiles and runCoverageShard replace the git listing and the coverage child.
  it('returns false immediately when a coverage shard exits non-zero', async () => {
    const listCoverageTestFilesStub = mock(async () => ['src/example.test.ts']);
    const runCoverageShardStub = mock(async () => ({
      exitCode: 1,
      lcovPath: 'coverage/lcov.info',
    }));
    using stderrWriteSpy = spyOn(process.stderr, 'write').mockImplementation(() => true);

    expect(
      await checkCoverage({
        listCoverageTestFiles: listCoverageTestFilesStub,
        runCoverageShard: runCoverageShardStub,
      }),
    ).toBe(false);
    expect(listCoverageTestFilesStub).toHaveBeenCalledTimes(1);
    expect(runCoverageShardStub).toHaveBeenCalledTimes(1);
    expect(runCoverageShardStub).toHaveBeenCalledWith({
      name: 'coverage',
      coverageDirectory: 'coverage',
      testFiles: ['src/example.test.ts'],
    });
    expect(stderrWriteSpy).toHaveBeenCalledWith('Coverage execution failed.\n');
  });

  // spawn-free: a mocked spawnCoverageProcess stands in for the coverage child process.
  it('propagates a non-zero child exit through the real coverage shard runner', async () => {
    const spawnCoverageProcess = mock(() => ({
      exited: Promise.resolve(7),
      stderr: new ReadableStream<Uint8Array>({
        start(controller) {
          controller.close();
        },
      }),
      stdout: new ReadableStream<Uint8Array>({
        start(controller) {
          controller.close();
        },
      }),
    }));
    using stderrWriteSpy = spyOn(process.stderr, 'write').mockImplementation(() => true);

    expect(
      await runCoverageShard(
        {
          name: 'synthetic',
          coverageDirectory: 'coverage/synthetic',
          testFiles: ['src/example.test.ts'],
        },
        { spawnCoverageProcess },
      ),
    ).toEqual({
      exitCode: 7,
      lcovPath: 'coverage/synthetic/lcov.info',
    });
    expect(spawnCoverageProcess).toHaveBeenCalledTimes(1);
    expect(stderrWriteSpy).toHaveBeenCalledWith('synthetic coverage shard exited with code 7.\n');
  });

  it('delivers a large failure tail and every diagnostic after it through a piped stderr (COR-1329)', () =>
    rethrow(scenario1));
});

describe('formatCoverageFailureReason', () => {
  it('names the stage and detail with no child suffix when no child was involved', () => {
    expect(
      formatCoverageFailureReason(
        'missing report',
        'expected an lcov report at coverage/lcov.info.',
      ),
    ).toBe(
      'check-coverage: exiting non-zero at stage "missing report": expected an lcov report at coverage/lcov.info.',
    );
  });

  it('reports the child exit code and "none" for signal when the child exited without one', () => {
    expect(
      formatCoverageFailureReason('child exit', 'coverage coverage shard exited with code 7.', {
        exitCode: 7,
        signal: null,
      }),
    ).toBe(
      'check-coverage: exiting non-zero at stage "child exit": coverage coverage shard exited with code 7. (child exit code 7, signal none)',
    );
  });

  it('reports the signal name and "none" for exit code when the child was signaled', () => {
    expect(
      formatCoverageFailureReason(
        'child signal',
        'coverage coverage shard was terminated by signal SIGKILL.',
        { exitCode: null, signal: 'SIGKILL' },
      ),
    ).toBe(
      'check-coverage: exiting non-zero at stage "child signal": coverage coverage shard was terminated by signal SIGKILL. (child exit code none, signal SIGKILL)',
    );
  });
});

describe('runCoverageShard failure diagnostics', () => {
  // spawn-free: a mocked spawnCoverageProcess stands in for the coverage child process.
  it('reports the spawn stage, without crashing, when starting the child throws', async () => {
    const spawnCoverageProcess = mock(() => {
      throw new Error('spawn ENOENT');
    });
    using consoleErrorSpy = spyOn(console, 'error').mockImplementation(() => {});

    expect(
      await runCoverageShard(
        {
          name: 'synthetic',
          coverageDirectory: 'coverage/synthetic',
          testFiles: ['src/example.test.ts'],
        },
        { spawnCoverageProcess },
      ),
    ).toEqual({
      exitCode: 1,
      lcovPath: 'coverage/synthetic/lcov.info',
    });
    expect(consoleErrorSpy).toHaveBeenCalledWith(
      expect.stringContaining('exiting non-zero at stage "spawn"'),
    );
    expect(consoleErrorSpy).toHaveBeenCalledWith(expect.stringContaining('spawn ENOENT'));
  });

  // spawn-free: a mocked spawnCoverageProcess stands in for the coverage child process.
  it('reports the child-signal stage and signal name when the child was terminated by a signal', async () => {
    const spawnCoverageProcess = mock(() => ({
      exited: Promise.resolve(143),
      signalCode: 'SIGTERM' as NodeJS.Signals,
      stderr: closedByteStream(),
      stdout: closedByteStream(),
    }));
    using stderrWriteSpy = spyOn(process.stderr, 'write').mockImplementation(() => true);

    expect(
      await runCoverageShard(
        {
          name: 'synthetic',
          coverageDirectory: 'coverage/synthetic',
          testFiles: ['src/example.test.ts'],
        },
        { spawnCoverageProcess },
      ),
    ).toEqual({
      exitCode: 143,
      lcovPath: 'coverage/synthetic/lcov.info',
    });
    expect(stderrWriteSpy).toHaveBeenCalledWith(
      expect.stringContaining('exiting non-zero at stage "child signal"'),
    );
    expect(stderrWriteSpy).toHaveBeenCalledWith(expect.stringContaining('SIGTERM'));
  });

  // spawn-free: a mocked spawnCoverageProcess stands in for the coverage child process.
  it('reports the child-exit stage, not child-signal, when the child exits with no signal', async () => {
    const spawnCoverageProcess = mock(() => ({
      exited: Promise.resolve(7),
      signalCode: null,
      stderr: closedByteStream(),
      stdout: closedByteStream(),
    }));
    using stderrWriteSpy = spyOn(process.stderr, 'write').mockImplementation(() => true);

    await runCoverageShard(
      {
        name: 'synthetic',
        coverageDirectory: 'coverage/synthetic',
        testFiles: ['src/example.test.ts'],
      },
      { spawnCoverageProcess },
    );

    expect(stderrWriteSpy).toHaveBeenCalledWith(
      expect.stringContaining('exiting non-zero at stage "child exit"'),
    );
    expect(stderrWriteSpy).not.toHaveBeenCalledWith(
      expect.stringContaining('stage "child signal"'),
    );
  });

  /**
   * Registers the shared handler for both signals, so proving one wiring proves both;
   * this asserts each is independently exercised without duplicating the whole scenario.
   */
  for (const signal of ['SIGTERM', 'SIGINT'] as const) {
    // spawn-free: a mocked spawnCoverageProcess stands in for the coverage child process.
    it(`forwards ${signal} to the running child, exits non-zero via the injected hook, and names the stage and pid`, async () => {
      let resolveExited: (code: number) => void = () => {};
      const exited = new Promise<number>((resolve) => {
        resolveExited = resolve;
      });
      const kill = mock((_signal?: number | NodeJS.Signals) => {
        resolveExited(143);
      });
      const exitProcess = mock((_code: number) => {});
      const spawnCoverageProcess = mock(() => ({
        pid: 4242,
        kill,
        exited,
        stderr: closedByteStream(),
        stdout: closedByteStream(),
      }));
      using consoleErrorSpy = spyOn(console, 'error').mockImplementation(() => {});

      // Barrier: wait for the handler to actually be registered via `process.on`
      // (an observed event) rather than a timing margin, before emitting the signal.
      let notifyRegistered: () => void = () => {};
      const registered = new Promise<void>((resolve) => {
        notifyRegistered = resolve;
      });
      const originalProcessOn = process.on.bind(process);
      using processOnSpy = spyOn(process, 'on').mockImplementation(((
        event: string,
        listener: (...args: unknown[]) => void,
      ) => {
        const result = originalProcessOn(event, listener);
        if (event === signal) notifyRegistered();
        return result;
      }) as typeof process.on);

      const runPromise = runCoverageShard(
        {
          name: 'synthetic',
          coverageDirectory: 'coverage/synthetic',
          testFiles: ['src/example.test.ts'],
        },
        { spawnCoverageProcess, exitProcess },
      );

      await registered;
      // Node/Bun fire a real signal as `process.emit(signal, signal)` — the signal
      // name is both the event and its argument — so mirror that exactly here.
      process.emit(signal, signal);
      await runPromise;

      expect(kill).toHaveBeenCalledWith(signal);
      expect(exitProcess).toHaveBeenCalledWith(1);
      expect(consoleErrorSpy).toHaveBeenCalledWith(
        expect.stringContaining(
          `received ${signal} while running the "synthetic" coverage shard (child pid 4242)`,
        ),
      );
      void processOnSpy;
    });
  }
});

/**
 * Write `content` to a fresh temp lcov file outside `coverage/` — `checkCoverage`
 * itself `rm -rf coverage`s at the top of every run, which would delete a fixture
 * planted there before the stubbed shard ever got to "read" it — run `use` against
 * its path, then remove the temp directory.
 */
async function withTempLcovFixture<T>(
  content: string,
  use: (lcovPath: string) => Promise<T>,
): Promise<T> {
  const { mkdtemp, rm } = await import('node:fs/promises');
  const { join } = await import('node:path');
  const { tmpdir } = await import('node:os');
  const root = await mkdtemp(join(tmpdir(), 'weft-coverage-fixture-'));
  try {
    const lcovPath = join(root, 'lcov.info');
    await Bun.write(lcovPath, content);
    return await use(lcovPath);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
}

describe('checkCoverage failure diagnostics', () => {
  const listOneTestFile = async () => ['src/example.test.ts'];

  // spawn-free: stubbed listCoverageTestFiles and runCoverageShard replace the git listing and the coverage child.
  it('reports the missing-report stage when the lcov report does not exist', async () => {
    const runCoverageShardStub = mock(async () => ({
      exitCode: 0,
      lcovPath: 'coverage/synthetic-missing/lcov.info',
    }));
    using consoleErrorSpy = spyOn(console, 'error').mockImplementation(() => {});

    expect(
      await checkCoverage({
        listCoverageTestFiles: listOneTestFile,
        runCoverageShard: runCoverageShardStub,
      }),
    ).toBe(false);

    expect(consoleErrorSpy).toHaveBeenCalledWith(
      expect.stringContaining('exiting non-zero at stage "missing report"'),
    );
  });

  // spawn-free: stubbed listCoverageTestFiles and runCoverageShard replace the git listing and the coverage child.
  it('reports the empty-report stage when the lcov report instruments zero lines', async () => {
    await withTempLcovFixture(
      'SF:src/synthetic-empty-fixture.ts\nFNF:0\nFNH:0\nend_of_record\n',
      async (lcovPath) => {
        const runCoverageShardStub = mock(async () => ({ exitCode: 0, lcovPath }));
        using consoleErrorSpy = spyOn(console, 'error').mockImplementation(() => {});

        expect(
          await checkCoverage({
            listCoverageTestFiles: listOneTestFile,
            runCoverageShard: runCoverageShardStub,
          }),
        ).toBe(false);

        expect(consoleErrorSpy).toHaveBeenCalledWith(
          expect.stringContaining('exiting non-zero at stage "empty report"'),
        );
      },
    );
  });

  // spawn-free: stubbed listCoverageTestFiles and runCoverageShard replace the git listing and the coverage child.
  it('reports the parse-failure stage when the lcov report fails to parse', async () => {
    // The same allowance-violation fixture `parseLcov` is proven to throw on above:
    // a hit on a line `COVERAGE_ALLOWANCES` only excuses while uncovered.
    await withTempLcovFixture(
      [
        'SF:src/core/context/parallel-operations.ts',
        'FNF:0',
        'FNH:0',
        'DA:19,1',
        'end_of_record',
      ].join('\n'),
      async (lcovPath) => {
        const runCoverageShardStub = mock(async () => ({ exitCode: 0, lcovPath }));
        using consoleErrorSpy = spyOn(console, 'error').mockImplementation(() => {});

        expect(
          await checkCoverage({
            listCoverageTestFiles: listOneTestFile,
            runCoverageShard: runCoverageShardStub,
          }),
        ).toBe(false);

        expect(consoleErrorSpy).toHaveBeenCalledWith(
          expect.stringContaining('exiting non-zero at stage "parse failure"'),
        );
        expect(consoleErrorSpy).toHaveBeenCalledWith(
          expect.stringContaining('points at a covered line'),
        );
      },
    );
  });

  // spawn-free: stubbed listCoverageTestFiles and runCoverageShard replace the git listing and the coverage child.
  it('reports the coverage-gap stage alongside the existing gaps list when lines are uncovered', async () => {
    await withTempLcovFixture(
      [
        'SF:src/synthetic-coverage-gap-fixture.ts',
        'FNF:0',
        'FNH:0',
        'DA:1,0',
        'end_of_record',
      ].join('\n'),
      async (lcovPath) => {
        const runCoverageShardStub = mock(async () => ({ exitCode: 0, lcovPath }));
        using consoleErrorSpy = spyOn(console, 'error').mockImplementation(() => {});
        using consoleLogSpy = spyOn(console, 'log').mockImplementation(() => {});

        expect(
          await checkCoverage({
            listCoverageTestFiles: listOneTestFile,
            runCoverageShard: runCoverageShardStub,
          }),
        ).toBe(false);

        expect(consoleErrorSpy).toHaveBeenCalledWith(
          expect.stringContaining('exiting non-zero at stage "coverage gap"'),
        );
        expect(consoleLogSpy).toHaveBeenCalledWith(expect.stringContaining('Files with gaps'));
      },
    );
  });

  // spawn-free: stubbed listCoverageTestFiles and runCoverageShard replace the git listing and the coverage child.
  it('prints only the existing summary lines on a fully covered run — no new diagnostic noise', async () => {
    await withTempLcovFixture(
      ['SF:src/synthetic-passing-fixture.ts', 'FNF:1', 'FNH:1', 'DA:1,1', 'end_of_record'].join(
        '\n',
      ),
      async (lcovPath) => {
        const runCoverageShardStub = mock(async () => ({ exitCode: 0, lcovPath }));
        using consoleErrorSpy = spyOn(console, 'error').mockImplementation(() => {});
        using consoleLogSpy = spyOn(console, 'log').mockImplementation(() => {});

        expect(
          await checkCoverage({
            listCoverageTestFiles: listOneTestFile,
            runCoverageShard: runCoverageShardStub,
          }),
        ).toBe(true);

        expect(consoleErrorSpy).not.toHaveBeenCalled();
        expect(consoleLogSpy).toHaveBeenCalledWith(expect.stringContaining('Lines:'));
        expect(consoleLogSpy).toHaveBeenCalledWith(expect.stringContaining('Functions:'));
      },
    );
  });
});

const documentedAllowance = <T extends object>(allowance: T) => ({
  reason: 'Synthetic allowance used to verify layer assembly behavior.',
  ...allowance,
});

describe('buildAllowanceLayer', () => {
  it('builds a map from unique entries, preserving each allowance value', () => {
    const layer = buildAllowanceLayer('SYNTHETIC_LAYER', [
      ['src/alpha.ts', documentedAllowance({ lines: new Set([1, 2, 3]) })],
      ['src/beta.ts', documentedAllowance({ functions: 2 })],
    ]);

    expect(layer.size).toBe(2);
    expect(layer.get('src/alpha.ts')).toEqual(documentedAllowance({ lines: new Set([1, 2, 3]) }));
    expect(layer.get('src/beta.ts')).toEqual(documentedAllowance({ functions: 2 }));
  });

  it('throws on a duplicate key within a single layer, naming the layer and key', () => {
    // A `new Map([...])` would silently keep only the last entry for a repeated
    // key, dropping the first allowance with no signal. The builder must turn
    // that copy-paste mistake into a build-time error.
    expect(() =>
      buildAllowanceLayer('DUPLICATED_LAYER', [
        ['src/repeated.ts', documentedAllowance({ lines: new Set([10]) })],
        ['src/other.ts', documentedAllowance({ lines: new Set([20]) })],
        ['src/repeated.ts', documentedAllowance({ lines: new Set([30]) })],
      ]),
    ).toThrow(/^Duplicate coverage-allowance key "src\/repeated\.ts" within DUPLICATED_LAYER\./);
  });

  it('accepts an empty layer', () => {
    expect(buildAllowanceLayer('EMPTY_LAYER', []).size).toBe(0);
  });
});

describe('assembleAllowanceLayers', () => {
  // An empty pair of refresh layers, used when a test exercises only the
  // ordered-merge behavior and not the refresh-layer exclusivity check.
  const noRefreshCollision = [
    ['MAIN_REFRESH', buildAllowanceLayer('MAIN_REFRESH', [])],
    ['BRANCH_REFRESH', buildAllowanceLayer('BRANCH_REFRESH', [])],
  ] as const;

  it('lets a later layer override an earlier layer for a shadowed key', () => {
    // Base/override layering is the legitimate mechanic: the override layer wins
    // for a shared key. Only refresh-layer-vs-refresh-layer collisions are barred.
    const base = buildAllowanceLayer('BASE', [
      ['src/shared.ts', documentedAllowance({ lines: new Set([1]) })],
      ['src/base-only.ts', documentedAllowance({ lines: new Set([2]) })],
    ]);
    const override = buildAllowanceLayer('OVERRIDE', [
      ['src/shared.ts', documentedAllowance({ lines: new Set([99]) })],
      ['src/override-only.ts', documentedAllowance({ lines: new Set([3]) })],
    ]);

    const assembled = assembleAllowanceLayers(
      [
        ['BASE', base],
        ['OVERRIDE', override],
      ],
      noRefreshCollision,
    );

    expect(assembled.size).toBe(3);
    expect(assembled.get('src/shared.ts')).toEqual(documentedAllowance({ lines: new Set([99]) }));
    expect(assembled.get('src/base-only.ts')).toEqual(documentedAllowance({ lines: new Set([2]) }));
    expect(assembled.get('src/override-only.ts')).toEqual(
      documentedAllowance({ lines: new Set([3]) }),
    );
  });

  it('applies last-layer-wins across three or more layers, identical to a Map spread', () => {
    // Pin the behavior-preservation contract: the helper must collapse N ordered
    // layers exactly as `new Map([...layerA, ...layerB, ...layerC])` would, so the
    // refactor away from the old spread assembly cannot silently change ordering.
    const layerA = buildAllowanceLayer('A', [
      ['src/shared.ts', documentedAllowance({ lines: new Set([1]) })],
      ['src/a-only.ts', documentedAllowance({ lines: new Set([10]) })],
    ]);
    const layerB = buildAllowanceLayer('B', [
      ['src/shared.ts', documentedAllowance({ lines: new Set([2]) })],
      ['src/b-only.ts', documentedAllowance({ lines: new Set([20]) })],
    ]);
    const layerC = buildAllowanceLayer('C', [
      ['src/shared.ts', documentedAllowance({ lines: new Set([3]) })],
    ]);

    const assembled = assembleAllowanceLayers(
      [
        ['A', layerA],
        ['B', layerB],
        ['C', layerC],
      ],
      noRefreshCollision,
    );
    const spread = new Map([...layerA, ...layerB, ...layerC]);

    // The last layer (C) wins for the thrice-shared key.
    expect(assembled.get('src/shared.ts')).toEqual(documentedAllowance({ lines: new Set([3]) }));
    expect(assembled).toEqual(spread);
  });

  it('throws when a key appears in both mutually-exclusive refresh layers', () => {
    // The two refresh layers must partition their keys: a twin in both means
    // removing one row silently reactivates the other (often stale) allowance.
    const mainRefresh = buildAllowanceLayer('MAIN_REFRESH', [
      ['src/twin.ts', documentedAllowance({ lines: new Set([1]) })],
    ]);
    const branchRefresh = buildAllowanceLayer('BRANCH_REFRESH', [
      ['src/twin.ts', documentedAllowance({ lines: new Set([2]) })],
    ]);

    expect(() =>
      assembleAllowanceLayers(
        [
          ['MAIN_REFRESH', mainRefresh],
          ['BRANCH_REFRESH', branchRefresh],
        ],
        [
          ['MAIN_REFRESH', mainRefresh],
          ['BRANCH_REFRESH', branchRefresh],
        ],
      ),
    ).toThrow(
      /^Coverage-allowance key "src\/twin\.ts" appears in both MAIN_REFRESH and BRANCH_REFRESH\./,
    );
  });

  it('allows a key shared between a non-exclusive layer and a refresh layer', () => {
    // Only the two refresh layers are mutually exclusive. A base/override layer
    // may still legitimately shadow a refresh layer's key.
    const base = buildAllowanceLayer('BASE', [
      ['src/shared.ts', documentedAllowance({ lines: new Set([1]) })],
    ]);
    const branchRefresh = buildAllowanceLayer('BRANCH_REFRESH', [
      ['src/shared.ts', documentedAllowance({ lines: new Set([2]) })],
    ]);
    const mainRefresh = buildAllowanceLayer('MAIN_REFRESH', []);

    const assembled = assembleAllowanceLayers(
      [
        ['BASE', base],
        ['MAIN_REFRESH', mainRefresh],
        ['BRANCH_REFRESH', branchRefresh],
      ],
      [
        ['MAIN_REFRESH', mainRefresh],
        ['BRANCH_REFRESH', branchRefresh],
      ],
    );

    // BRANCH_REFRESH is the terminal layer, so its value wins over BASE.
    expect(assembled.get('src/shared.ts')).toEqual(documentedAllowance({ lines: new Set([2]) }));
  });
});

describe('readCoveragePathIgnorePatterns', () => {
  it('returns exactly the coveragePathIgnorePatterns array parsed from bunfig.toml', async () => {
    // Single source of truth: the patterns come from bunfig.toml, not a hardcoded list.
    // Assert against the file's actual contents (parsed independently here) rather than a
    // pinned member, so the test does not break when the ignore list legitimately changes
    // — it only fails if the function stops reflecting bunfig.toml.
    const bunfigText = await Bun.file(new URL('../bunfig.toml', import.meta.url)).text();
    const parsed = Bun.TOML.parse(bunfigText) as {
      test?: { coveragePathIgnorePatterns?: unknown };
    };
    // The function normalizes an absent `[test].coveragePathIgnorePatterns` to `[]`, so
    // mirror that here: a bunfig that drops the field entirely must still match (the
    // function is still correct), not fail because raw parse yields `undefined`.
    //
    // `noUncheckedIndexedAccess`/strict `unknown` narrowing (corvidae's stricter tsconfig;
    // upstream does not enable it) widens a bare `?? []` fallback over the `unknown`-typed
    // field to `{}`, so this checks the shape explicitly instead of trusting the parse.
    const rawPatterns = parsed.test?.coveragePathIgnorePatterns;
    const expected: string[] = Array.isArray(rawPatterns) ? (rawPatterns as string[]) : [];

    expect(readCoveragePathIgnorePatterns()).toEqual(expected);
  });
});

describe('assertNoAllowanceKeyIsCoverageIgnored', () => {
  it('throws when an allowance key matches a coveragePathIgnorePatterns entry, naming both', () => {
    // A file in coveragePathIgnorePatterns is never instrumented, so an allowance for
    // it is dead — it ignores nothing and its line numbers drift silently (#539). This
    // is exactly the dead self-allowance that lingered on scripts/check-coverage.ts.
    expect(() =>
      assertNoAllowanceKeyIsCoverageIgnored(
        new Map([['scripts/check-coverage.ts', { functions: 1 }]]),
        ['scripts/check-coverage.ts'],
      ),
    ).toThrow(
      /^Coverage-allowance key "scripts\/check-coverage\.ts" matches coveragePathIgnorePatterns entry "scripts\/check-coverage\.ts"/,
    );
  });

  it('matches a glob pattern against an allowance key', () => {
    // coveragePathIgnorePatterns supports globs; a `**`/`*` pattern must be matched
    // structurally, not just by substring, so a glob-ignored path is also caught.
    expect(() =>
      assertNoAllowanceKeyIsCoverageIgnored(new Map([['src/generated/client.ts', {}]]), [
        'src/generated/**',
      ]),
    ).toThrow(/matches coveragePathIgnorePatterns entry "src\/generated\/\*\*"/);
  });

  it('matches `?` and `[…]` glob metacharacters, not just `*`', () => {
    // Bun matches coveragePathIgnorePatterns as globs, so `?` and character classes are
    // metacharacters too — a `*`-only matcher would miss these (a false negative).
    expect(() =>
      assertNoAllowanceKeyIsCoverageIgnored(new Map([['src/question.ts', {}]]), [
        'src/qu?stion.ts',
      ]),
    ).toThrow(/matches coveragePathIgnorePatterns entry/);
    expect(() =>
      assertNoAllowanceKeyIsCoverageIgnored(new Map([['src/bracket-x.ts', {}]]), [
        'src/bracket-[xy].ts',
      ]),
    ).toThrow(/matches coveragePathIgnorePatterns entry/);
  });

  it('does NOT treat a bare pattern as a substring (Bun uses glob, not substring, matching)', () => {
    // The crux: Bun does NOT substring-match. A bare `nested` does not exclude
    // `sub/nested-file.ts` (verified empirically — see the characterization test below),
    // so a substring matcher would WRONGLY reject a live allowance here.
    expect(() =>
      assertNoAllowanceKeyIsCoverageIgnored(new Map([['src/sub/nested-file.ts', {}]]), ['nested']),
    ).not.toThrow();
    expect(() =>
      assertNoAllowanceKeyIsCoverageIgnored(new Map([['src/exact-match.ts', {}]]), ['match']),
    ).not.toThrow();
  });

  it('does not throw when no allowance key matches an ignore pattern', () => {
    expect(() =>
      assertNoAllowanceKeyIsCoverageIgnored(
        new Map([
          ['src/core/engine/index.ts', { functions: 2 }],
          ['src/workers/workflow-runner.ts', { lines: new Set([500]) }],
        ]),
        ['scripts/check-coverage.ts', 'src/generated/**'],
      ),
    ).not.toThrow();
  });

  it('is a no-op when there are no ignore patterns', () => {
    expect(() =>
      assertNoAllowanceKeyIsCoverageIgnored(new Map([['scripts/check-coverage.ts', {}]]), []),
    ).not.toThrow();
  });

  it('the live module loads — its load-time guard accepts the real allowance set', async () => {
    // The guard runs at module load against the REAL assembled COVERAGE_ALLOWANCES. A
    // fresh dynamic import re-executes that top-level guard; a future dead allowance
    // (a real allowance key matching a real ignore pattern) makes this import throw, so
    // the regression is caught here, not only when `check-coverage.ts` is run directly.
    //
    // The `?live-guard` query suffix is a Bun-only cache-busting convention (a real module
    // specifier at runtime, forcing Bun to re-execute the module instead of returning the
    // cached instance) with no TypeScript-typed resolution — `noUncheckedIndexedAccess`
    // aside, no tsconfig option makes a query-string specifier resolvable, upstream's
    // laxer settings just never surface the check.
    // @ts-expect-error -- Bun-only `?query` cache-busting import; not a resolvable TS specifier.
    expect(await import('./check-coverage.ts?live-guard')).toBeDefined();
  });
});

const ignorePatternParity = await outcomeOf(async () => {
  const { mkdtemp, writeFile, mkdir, rm } = await import('node:fs/promises');
  const { join } = await import('node:path');
  const { tmpdir } = await import('node:os');

  const root = await mkdtemp(join(tmpdir(), 'weft-cov-char-'));
  try {
    await mkdir(join(root, 'sub'), { recursive: true });
    const files = [
      'exact-match.ts',
      'sub/nested-file.ts',
      'question.ts',
      'bracket-x.ts',
      'plain-substr.ts',
    ];
    for (const [index, file] of files.entries()) {
      await writeFile(
        join(root, file),
        `export const v${String(index)} = () => ${String(index)};\n`,
      );
    }
    const imports = files
      .map((file, index) => `import { v${String(index)} } from './${file}';`)
      .join('\n');
    await writeFile(
      join(root, 'all.test.ts'),
      `import { test, expect } from 'bun:test';\n${imports}\n` +
        `test('t', () => { expect([${files.map((_f, i) => `v${String(i)}`).join(',')}].length).toBe(${String(files.length)}); });\n`,
    );

    // Representative patterns spanning every matcher class Bun supports.
    const patterns = [
      'exact-match.ts',
      '*.ts',
      'qu?stion.ts',
      'bracket-[xy].ts',
      'sub/**',
      'nested', // bare substring — Bun does NOT exclude on this
    ];

    for (const pattern of patterns) {
      await writeFile(
        join(root, 'bunfig.toml'),
        `[test]\ncoveragePathIgnorePatterns = ["${pattern}"]\n`,
      );
      await rm(join(root, 'coverage'), { recursive: true, force: true });
      // A spawned child, not `Bun.$`, so the scenario hang guard can kill a deadlocked run.
      const coverageChild = spawnWithHangGuard(
        ['bun', 'test', '--coverage', '--coverage-reporter=lcov', '--coverage-dir=coverage'],
        { cwd: root, stdout: 'ignore', stderr: 'pipe' },
      );
      const [exitCode, stderr] = await Promise.all([
        coverageChild.exited,
        new Response(coverageChild.stderr).text(),
      ]);
      const coverageRun = { exitCode, stderr };
      // Assert the coverage run itself succeeded. A non-zero exit can still leave a
      // partial or empty lcov, which would silently skew the exclusion set below — so
      // fail here, at the real cause, rather than later on an opaque file read.
      expect(
        coverageRun.exitCode,
        `bun test --coverage failed for pattern "${pattern}": ${coverageRun.stderr}`,
      ).toBe(0);
      const lcov = await Bun.file(join(root, 'coverage', 'lcov.info')).text();
      const bunExcluded = new Set(
        files.filter((file) => !lcov.split('\n').some((line) => line === `SF:${file}`)),
      );

      // The guard must throw for exactly the files Bun excluded, and not for the kept.
      for (const file of files) {
        const run = () => assertNoAllowanceKeyIsCoverageIgnored(new Map([[file, {}]]), [pattern]);
        if (bunExcluded.has(file)) {
          expect(run, `guard should flag "${file}" excluded by Bun for "${pattern}"`).toThrow();
        } else {
          expect(run, `guard should NOT flag "${file}" kept by Bun for "${pattern}"`).not.toThrow();
        }
      }
    }
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

describe('allowanceKeyMatchesIgnorePattern agrees with Bun coverage-ignore semantics', () => {
  // Characterization test: the guard's correctness depends ENTIRELY on matching how Bun
  // actually applies coveragePathIgnorePatterns. Rather than trust a hand-modeled matcher,
  // run real `bun test --coverage` against temp fixtures with representative patterns,
  // observe which files Bun excludes from LCOV, and assert assertNoAllowanceKeyIsCoverageIgnored
  // throws for exactly the excluded files (and not the kept ones).
  it('matches Bun for exact, *, ?, [], **, and bare-substring patterns', () =>
    rethrow(ignorePatternParity));
});

describe('requireUncoveredLines on corvidae-authored allowances', () => {
  // Every corvidae-authored entry — every key in CORVIDAE_COVERAGE_ALLOWANCES, plus every
  // upstream entry this adoption realigned in place (line numbers no longer matched corvidae's
  // file, so they were re-derived from a fresh coverage/lcov.info) — must carry
  // `requireUncoveredLines: true` explicitly. An omitted key weakens the check the same way
  // `false` does: it stops the gate from noticing when an allowed-uncovered line becomes
  // covered. This list is maintained by hand rather than inferred (there is no marker in
  // `check-coverage.ts` distinguishing "realigned" from "upstream, untouched") — a path added
  // here without actually being realigned is caught by `COVERAGE_ALLOWANCES.get()` returning
  // `undefined` below, and a realigned path never added here is a real gap this test cannot
  // see, which is why the coverage-gate-adoption PR record is the source of truth for the list,
  // not this test alone. Layers untouched by this adoption (most of `BASE_COVERAGE_ALLOWANCES`,
  // `COVERAGE_ALLOWANCE_OVERRIDES`, the two `CURRENT_MAIN_*`/`CURRENT_BRANCH_*` layers, and all
  // of `TARGET_ONLY_COVERAGE_ALLOWANCES`, which ruling 4 of the adoption charter required to be
  // kept byte-for-byte verbatim from upstream) are deliberately excluded: upstream entries that
  // lack the key there stay exactly as upstream wrote them.
  const realignedPaths = [
    'scripts/benchmarks/benchmark-subprocess.ts',
    'scripts/benchmarks/workflow-starts-runner.ts',
    'scripts/check-implementation-file-sizes.ts',
    'scripts/generate-operation-client.ts',
    'src/cli/api-arguments.ts',
    'src/cli/codegen.ts',
    'src/cli/noun-verb-arguments.ts',
    'src/cli/server-client.ts',
    'src/cli/server-commands.ts',
    'src/conformance/run-conformance.ts',
    'src/connection.ts',
    'src/server/dashboard-assets.ts',
    'src/server/json-rpc-websocket.ts',
    'src/server/operation-catalog/workflow-adapter.ts',
    'src/server/operations/bulk-retry-failed-workflows.ts',
    'src/server/runtime/websocket-worker.ts',
    'src/storage/auto.ts',
    'src/storage/durability/adapter-spec.test-support.ts',
    'src/storage/resolve.ts',
    'src/storage/turso.ts',
    'src/testing/subprocess-engine.ts',
    'src/testing/worker-fault-injection.test-support.ts',
    // `src/server/operations/get-task-detail.ts` and
    // `src/server/runtime/task-ledger-recovery.ts` were also realigned (new line coordinates
    // for the same upstream-documented closed-union exhaustiveness guard) but are deliberately
    // NOT listed here: both entries omit `requireUncoveredLines` on purpose, matching upstream's
    // own reasoning that the guard's case-label/brace lines are a coverage-attribution artifact
    // that flips between runs, not a real reachability signal — the identical omission ruling 4
    // required verbatim for the six TARGET_ONLY entries. Adding either path here would assert
    // against that documented, intentional omission. Flagged in the delivery report as a
    // narrower reading of ruling 5 than its literal text for the coordinator to confirm.
  ];

  it('every realigned entry carries requireUncoveredLines: true when it allows lines', () => {
    const missing: string[] = [];
    for (const path of realignedPaths) {
      const allowance = COVERAGE_ALLOWANCES.get(path);
      if (allowance === undefined) {
        missing.push(`${path} (not found in COVERAGE_ALLOWANCES — realignment list is stale)`);
        continue;
      }
      if (allowance.lines !== undefined && allowance.requireUncoveredLines !== true) {
        missing.push(path);
      }
    }
    expect(missing).toEqual([]);
  });

  it('every CORVIDAE_COVERAGE_ALLOWANCES entry carries requireUncoveredLines: true when it allows lines', () => {
    const missing: string[] = [];
    for (const [path, allowance] of CORVIDAE_COVERAGE_ALLOWANCES) {
      if (allowance.lines !== undefined && allowance.requireUncoveredLines !== true) {
        missing.push(path);
      }
    }
    expect(missing).toEqual([]);
  });
});

describe('workflowEventFeedUncoveredLines', () => {
  // COR-1379: in the linux/arm64 Dev Container Bun covers line 398, and the allowance that
  // required it to stay uncovered failed the coverage gate.
  it('excuses line 398 only where Bun leaves it uncovered', () => {
    expect(workflowEventFeedUncoveredLines('linux', 'x64')).toEqual([398]);
    expect(workflowEventFeedUncoveredLines('linux', 'arm64')).toEqual([]);
    expect(workflowEventFeedUncoveredLines('darwin', 'arm64')).toEqual([]);
  });
});

describe('memoryFootprintUncoveredOutsideDarwin', () => {
  // COR-1379: on Linux the macOS-only `proc_pid_rusage` path cannot run, and the coverage gate
  // failed the file in the linux/arm64 Dev Container.
  it('excuses the macOS-only FFI path everywhere but macOS', () => {
    expect(memoryFootprintUncoveredOutsideDarwin('darwin')).toEqual({ lines: new Set() });
    expect(memoryFootprintUncoveredOutsideDarwin('linux')).toEqual({
      functions: 3,
      lines: new Set([36, 37, 38, 39, 40, 41, 45, 46, 47, 54, 79]),
    });
  });
});
