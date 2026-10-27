import { afterEach, beforeEach, describe, expect, test } from 'bun:test';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { classifyGateFailure, type GateFailureInputs } from './gate-failure.ts';
import type { ControlOptions, ControlResult, ControlRow } from './gate-run.ts';
import type { Runner } from './process-runner.ts';

const row = (
  tree: 'candidate' | 'base',
  exitCode: number,
  failingTests: string[] = [],
): ControlRow => ({ iteration: 1, tree, load: 1, exitCode, failingTests });

function control(rows: ControlRow[]): ControlResult {
  const failures = (tree: string) =>
    rows.filter((entry) => entry.tree === tree && entry.exitCode !== 0).length;
  return {
    rows,
    iterations: rows.length / 2,
    candidateFailures: failures('candidate'),
    baseFailures: failures('base'),
    shared: false,
  };
}

let sandbox: string;
let worktree: string;
let controlRoot: string;
let gateLog: string;

beforeEach(() => {
  sandbox = mkdtempSync(join(tmpdir(), 'gate-failure-'));
  worktree = join(sandbox, 'wt');
  controlRoot = join(sandbox, 'roots');
  mkdirSync(join(worktree, 'packages', 'weft', 'src'), { recursive: true });
  writeFileSync(join(worktree, 'package.json'), JSON.stringify({ name: 'corvidae', scripts: {} }));
  writeFileSync(
    join(worktree, 'packages', 'weft', 'package.json'),
    JSON.stringify({
      name: '@lostgradient/weft',
      scripts: {
        test: 'TZ=UTC bun ../../scripts/bun-test-junit.ts --parallel=4 src',
      },
    }),
  );
  writeFileSync(join(worktree, 'packages', 'weft', 'src', 'engine.test.ts'), '');
  mkdirSync(join(worktree, 'applications'), { recursive: true });
  gateLog = join(sandbox, 'gate.log');
  writeFileSync(
    gateLog,
    [
      'HEAD aaa LOAD 1',
      '@lostgradient/weft:test: src/engine.test.ts:',
      '@lostgradient/weft:test: (fail) engine > resumes [3ms]',
      ' Failed:    @lostgradient/weft#test',
      'GATE_RC=1',
      '',
    ].join('\n'),
  );
});
afterEach(() => rmSync(sandbox, { recursive: true, force: true }));

function inputs(runner: Runner, controlRun: (options: ControlOptions) => ControlResult) {
  const value: GateFailureInputs = {
    runner,
    worktree,
    defaultBranch: 'main',
    installCommand: 'install-it',
    controlRoot,
    pr: 7,
    gateLog,
    logDirectory: join(sandbox, 'logs'),
    control: controlRun,
  };
  return value;
}

function fakeGit() {
  const calls: { command: string[]; cwd: string | undefined }[] = [];
  const runner: Runner = (command, options) => {
    calls.push({ command, cwd: options?.cwd });
    if (command[1] === 'rev-parse') return { code: 0, stdout: `${'b'.repeat(40)}\n`, stderr: '' };
    if (command[1] === 'merge-base') return { code: 0, stdout: `${'c'.repeat(40)}\n`, stderr: '' };
    return { code: 0, stdout: '', stderr: '' };
  };
  return { runner, calls };
}

describe('classifyGateFailure', () => {
  test('classifies a file that fails on the head and passes on main as the branch', () => {
    const { runner, calls } = fakeGit();
    const runs: ControlOptions[] = [];
    const report = classifyGateFailure(
      inputs(runner, (options) => {
        runs.push(options);
        return control([
          row('candidate', 1, ['engine > resumes']),
          row('base', 0),
          row('candidate', 1, ['engine > resumes']),
          row('base', 0),
        ]);
      }),
    );
    expect(report.classification).toBe('branch');
    expect(report.files).toMatchObject([
      { file: 'src/engine.test.ts', directory: 'packages/weft', verdict: 'branch' },
    ]);
    expect(runs).toHaveLength(1);
    expect(runs[0]).toMatchObject({
      candidate: join(worktree, 'packages', 'weft'),
      base: join(controlRoot, 'delivery-control-pr7', 'packages', 'weft'),
      iterations: 2,
      command: "TZ=UTC bun ../../scripts/bun-test-junit.ts 'src/engine.test.ts'",
    });
    // The main tree is a detached worktree at origin/main, installed, and removed again.
    const text = calls.map((call) => call.command.join(' '));
    expect(text).toContain(
      `git worktree add --detach ${join(controlRoot, 'delivery-control-pr7')} ${'b'.repeat(40)}`,
    );
    expect(text).toContain('sh -c install-it');
    expect(text).toContain(`git worktree remove ${join(controlRoot, 'delivery-control-pr7')}`);
  });

  test('classifies the same failure on main as main, and a pass on both as unreproduced', () => {
    const { runner } = fakeGit();
    const main = classifyGateFailure(
      inputs(runner, () =>
        control([row('candidate', 1, ['engine > resumes']), row('base', 1, ['engine > resumes'])]),
      ),
    );
    expect(main.classification).toBe('main');
    const flake = classifyGateFailure(
      inputs(runner, () => control([row('candidate', 0), row('base', 0)])),
    );
    expect(flake.classification).toBe('unreproduced');
  });

  test('names the pull requests that touched each failed task since the merge base', () => {
    const { runner } = fakeGit();
    const report = classifyGateFailure(
      inputs(runner, () => control([row('candidate', 0), row('base', 0)])),
    );
    expect(report.triage).toContain('@lostgradient/weft#test');
  });

  test('a log with no failing test file (a lint or type-check failure) is unclassified, with no main tree', () => {
    writeFileSync(gateLog, 'HEAD aaa LOAD 1\n Failed:    @lostgradient/weft#lint\nGATE_RC=1\n');
    const { runner, calls } = fakeGit();
    const report = classifyGateFailure(
      inputs(runner, () => {
        throw new Error('the control must not run');
      }),
    );
    expect(report.classification).toBe('unclassified');
    expect(calls.some((call) => call.command.includes('worktree'))).toBe(false);
  });

  test('a test file the head does not have is indeterminate, never concluded', () => {
    rmSync(join(worktree, 'packages', 'weft', 'src', 'engine.test.ts'));
    const { runner } = fakeGit();
    const report = classifyGateFailure(
      inputs(runner, () => {
        throw new Error('the control must not run');
      }),
    );
    expect(report.classification).toBe('unclassified');
    expect(report.files[0]).toMatchObject({ verdict: 'indeterminate' });
  });

  test('a main tree that cannot be made leaves the failure unclassified and says why', () => {
    const failing: Runner = (command) =>
      command[1] === 'worktree' && command[2] === 'add'
        ? { code: 128, stdout: '', stderr: 'fatal: already exists' }
        : { code: 0, stdout: `${'b'.repeat(40)}\n`, stderr: '' };
    const report = classifyGateFailure(
      inputs(failing, () => {
        throw new Error('the control must not run');
      }),
    );
    expect(report.classification).toBe('unclassified');
    expect(report.notes.join(' ')).toContain('git worktree add');
  });

  test('a failed install in the main tree removes the tree it made and leaves it unclassified', () => {
    const { calls } = fakeGit();
    const failing: Runner = (command, options) => {
      calls.push({ command, cwd: options?.cwd });
      if (command[0] === 'sh') return { code: 1, stdout: '', stderr: 'no network' };
      return { code: 0, stdout: `${'b'.repeat(40)}\n`, stderr: '' };
    };
    const report = classifyGateFailure(
      inputs(failing, () => {
        throw new Error('the control must not run');
      }),
    );
    expect(report.classification).toBe('unclassified');
    expect(report.notes.join(' ')).toContain('install-it failed');
    expect(calls.some((call) => call.command.join(' ').includes('worktree remove'))).toBe(true);
  });
});
