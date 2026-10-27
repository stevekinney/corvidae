import { describe, expect, test } from 'bun:test';
import {
  classificationExitCode,
  classifyFailure,
  failingTestFiles,
  fileVerdict,
  testFileCommand,
} from './gate-classification.ts';
import type { ControlResult, ControlRow } from './gate-run.ts';

const row = (
  tree: 'candidate' | 'base',
  exitCode: number,
  failingTests: string[] = [],
): ControlRow => ({
  iteration: 1,
  tree,
  load: 1,
  exitCode,
  failingTests,
});

const result = (rows: ControlRow[]): ControlResult => ({
  rows,
  iterations: rows.length / 2,
  candidateFailures: rows.filter((entry) => entry.tree === 'candidate' && entry.exitCode !== 0)
    .length,
  baseFailures: rows.filter((entry) => entry.tree === 'base' && entry.exitCode !== 0).length,
  shared: false,
});

describe('failingTestFiles', () => {
  const log = [
    'HEAD abc LOAD 1.00',
    '@lostgradient/weft:test: src/engine.test.ts:',
    '@lostgradient/weft:test: (fail) engine > resumes [3.20ms]',
    '@lostgradient/weft:test: (fail) engine > replays [1.00ms]',
    '@lostgradient/cinder:test: src/button.test.ts:',
    '@lostgradient/weft:test: src/store.test.ts:',
    '@lostgradient/cinder:test: (fail) button > clicks [0.50ms]',
    '@lostgradient/weft:test: (fail) store > writes [2ms]',
    'scripts/chef/note.test.ts:',
    '(fail) note > appends [4ms]',
    'corvidae:test:self: scripts/chef/other.test.ts:',
    'corvidae:test:self: (pass) other > fine [1ms]',
    '\u001b[31m(fail) note > appends [4ms]\u001b[0m',
    '',
  ].join('\n');

  test('attributes each (fail) line to the test file header above it in the same package', () => {
    expect(failingTestFiles(log)).toEqual([
      {
        package: '@lostgradient/weft',
        task: 'test',
        file: 'src/engine.test.ts',
        tests: ['engine > resumes', 'engine > replays'],
      },
      {
        package: '@lostgradient/cinder',
        task: 'test',
        file: 'src/button.test.ts',
        tests: ['button > clicks'],
      },
      {
        package: '@lostgradient/weft',
        task: 'test',
        file: 'src/store.test.ts',
        tests: ['store > writes'],
      },
      {
        package: undefined,
        task: undefined,
        file: 'scripts/chef/note.test.ts',
        tests: ['note > appends'],
      },
    ]);
  });

  test('a failure with no file header above it names no file', () => {
    expect(failingTestFiles('(fail) orphan [1ms]\n')).toEqual([]);
  });
});

describe('testFileCommand', () => {
  const file = 'src/button.test.ts';

  test('keeps the package runner and its conditions, and swaps the paths for the one file', () => {
    expect(
      testFileCommand(
        'TZ=UTC LANG=en_US.UTF-8 bun ../../scripts/bun-test-junit.ts --conditions browser --conditions svelte --parallel=4 src scripts',
        file,
      ),
    ).toBe(
      "TZ=UTC LANG=en_US.UTF-8 bun ../../scripts/bun-test-junit.ts --conditions browser --conditions svelte 'src/button.test.ts'",
    );
  });

  test('drops the parallel and ignore flags that would hide or fan out the one file', () => {
    expect(
      testFileCommand(
        "bun ../../scripts/bun-test-junit.ts --parallel=4 --path-ignore-patterns='**/*.slow.test.ts'",
        file,
      ),
    ).toBe("bun ../../scripts/bun-test-junit.ts 'src/button.test.ts'");
  });

  test('falls back to bun test for a script it cannot reduce', () => {
    const fallback = "bun test 'src/button.test.ts'";
    expect(testFileCommand(undefined, file)).toBe(fallback);
    expect(testFileCommand('vitest run', file)).toBe(fallback);
    expect(testFileCommand('bun a.ts && bun ../../scripts/bun-test-junit.ts src', file)).toBe(
      fallback,
    );
  });
});

describe('fileVerdict', () => {
  const expected = ['button > clicks'];

  test('branch: it fails on the head and passes on main', () => {
    const control = result([
      row('candidate', 1, expected),
      row('base', 0),
      row('candidate', 1, expected),
      row('base', 0),
    ]);
    expect(fileVerdict(control, expected)).toBe('branch');
  });

  test('main: it fails on main too, even when the head passes this time', () => {
    expect(
      fileVerdict(result([row('candidate', 1, expected), row('base', 1, expected)]), expected),
    ).toBe('main');
    expect(fileVerdict(result([row('candidate', 0), row('base', 1, expected)]), expected)).toBe(
      'main',
    );
  });

  test('branch: a regression beside an existing main failure in the same file is not hidden', () => {
    const both = ['existing', 'regression'];
    expect(
      fileVerdict(result([row('candidate', 1, both), row('base', 1, ['existing'])]), both),
    ).toBe('branch');
  });

  test('main: every failing test the head shows also fails on main', () => {
    const both = ['existing', 'other'];
    expect(
      fileVerdict(result([row('candidate', 1, ['existing']), row('base', 1, both)]), both),
    ).toBe('main');
  });

  test('unreproduced: it passes alone on both trees', () => {
    expect(
      fileVerdict(
        result([row('candidate', 0), row('base', 0), row('candidate', 0), row('base', 0)]),
        expected,
      ),
    ).toBe('unreproduced');
  });

  test('a file the base cannot run (a new test) and the head fails is the branch', () => {
    expect(fileVerdict(result([row('candidate', 1, expected), row('base', 1, [])]), expected)).toBe(
      'branch',
    );
  });

  test('indeterminate: it fails alone, but never the way the gate saw', () => {
    expect(fileVerdict(result([row('candidate', 1, []), row('base', 1, [])]), expected)).toBe(
      'indeterminate',
    );
  });
});

describe('classifyFailure', () => {
  test('a branch failure wins over everything else', () => {
    expect(classifyFailure(['main', 'branch', 'unreproduced'])).toBe('branch');
    expect(classifyFailure(['indeterminate', 'main'])).toBe('unclassified');
  });

  test('main wins over unreproduced, and unreproduced needs every file to pass alone', () => {
    expect(classifyFailure(['unreproduced', 'main'])).toBe('main');
    expect(classifyFailure(['unreproduced', 'unreproduced'])).toBe('unreproduced');
  });

  test('no failing test file means the gate failed somewhere this cannot rerun', () => {
    expect(classifyFailure([])).toBe('unclassified');
  });
});

describe('classificationExitCode', () => {
  test('1 for a branch or unclassified failure, 3 for main, 4 for unreproduced', () => {
    expect(classificationExitCode('branch')).toBe(1);
    expect(classificationExitCode('unclassified')).toBe(1);
    expect(classificationExitCode('main')).toBe(3);
    expect(classificationExitCode('unreproduced')).toBe(4);
  });
});
