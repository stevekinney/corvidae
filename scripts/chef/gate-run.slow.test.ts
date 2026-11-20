import { expect } from 'bun:test';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { run, runControl, UsageError } from './gate-run.ts';
import { type Runner } from './process-runner.ts';
import { createScenarios } from './scenario.test-support.ts';
/**
 * `runControl` runs real shells, so each case runs at module scope in the slow lane rather than on
 * the five-second per-test clock.
 */

let sandbox = '';

const scenarios = createScenarios({
  setUp() {
    sandbox = mkdtempSync(join(tmpdir(), 'gate-run-'));
  },
  tearDown() {
    rmSync(sandbox, { recursive: true, force: true });
  },
});

scenarios.describe('runControl', () => {
  function trees() {
    const candidate = join(sandbox, 'candidate');
    const base = join(sandbox, 'base');
    mkdirSync(candidate);
    mkdirSync(base);
    return { candidate, base };
  }

  scenarios.scenario("a failure only the candidate has is the candidate's: exit 1", () => {
    const { candidate, base } = trees();
    writeFileSync(join(base, 'marker'), '');
    const log = join(sandbox, 'control.tsv');
    const result = runControl(
      {
        candidate,
        base,
        command: "test -f marker || { echo '(fail) pkg > broken [1ms]'; exit 1; }",
        iterations: 3,
        log,
      },
      { load: () => 1 },
    );
    expect(result.candidateFailures).toBe(3);
    expect(result.baseFailures).toBe(0);
    expect(result.shared).toBe(false);
    const rows = readFileSync(log, 'utf8').trim().split('\n');
    expect(rows[0]).toBe('iteration\ttree\tload\texit\tfailing_tests');
    expect(rows).toHaveLength(7);
    expect(rows[1]).toBe('1\tcandidate\t1.00\t1\tpkg > broken');
    expect(rows[2]).toBe('1\tbase\t1.00\t0\t');
  });

  scenarios.scenario('alternates trees and records load before each run', () => {
    const { candidate, base } = trees();
    const visited: string[] = [];
    let loadReads = 0;
    const runner: Runner = (_command, options) => {
      visited.push(options?.cwd ?? '');
      return { code: 0, stdout: '', stderr: '' };
    };
    const result = runControl(
      { candidate, base, command: 'true', iterations: 2, log: join(sandbox, 'c.tsv') },
      { runner, load: () => ++loadReads },
    );
    expect(visited).toEqual([candidate, base, candidate, base]);
    expect(result.rows.map((row) => row.load)).toEqual([1, 2, 3, 4]);
  });

  scenarios.scenario('a failure both trees share exits 0 through run', () => {
    const { candidate, base } = trees();
    const result = run([
      'control',
      '--candidate',
      candidate,
      '--base',
      base,
      '--command',
      'exit 1',
      '--iterations',
      '2',
      '--log',
      join(sandbox, 'c.tsv'),
    ]);
    expect(result.code).toBe(0);
    expect(result.output).toContain('candidate failed 2 of 2');
    expect(result.output).toContain('base failed 2 of 2');
  });

  scenarios.scenario('a base that fails less than the candidate exits 1', () => {
    const { candidate, base } = trees();
    writeFileSync(join(base, 'marker'), '');
    const result = run([
      'control',
      '--candidate',
      candidate,
      '--base',
      base,
      '--command',
      'test -f marker',
      '--iterations',
      '1',
      '--log',
      join(sandbox, 'c.tsv'),
    ]);
    expect(result.code).toBe(1);
  });
});

scenarios.describe('run', () => {
  scenarios.scenario('read exits 0 only for a log holding exit code 0, and 1 for none', () => {
    const passing = join(sandbox, 'pass.log');
    const failing = join(sandbox, 'fail.log');
    const unfinished = join(sandbox, 'unfinished.log');
    writeFileSync(passing, 'HEAD a LOAD 1\nGATE_RC=0\n');
    writeFileSync(failing, 'HEAD a LOAD 1\nGATE_RC=1\n');
    writeFileSync(unfinished, 'HEAD a LOAD 1\nrunning\n');
    expect(run(['read', passing]).code).toBe(0);
    expect(run(['read', failing]).code).toBe(1);
    const open = run(['read', unfinished, '--json']);
    expect(open.code).toBe(1);
    expect(JSON.parse(open.output).exitCode).toBeUndefined();
  });

  scenarios.scenario(
    'a missing log, an unknown command and bad iterations are usage errors',
    () => {
      expect(() => run(['read', join(sandbox, 'missing.log')])).toThrow(UsageError);
      expect(() => run(['bogus'])).toThrow(UsageError);
      expect(() => run(['run', '--worktree', sandbox, '--log', 'x'])).toThrow(UsageError);
      expect(() => run([])).toThrow(UsageError);
      expect(() =>
        run([
          'control',
          '--candidate',
          sandbox,
          '--base',
          sandbox,
          '--command',
          'true',
          '--iterations',
          '0',
          '--log',
          'x',
        ]),
      ).toThrow('--iterations');
      expect(existsSync(join(sandbox, 'x'))).toBe(false);
    },
  );
});

await scenarios.settled();
