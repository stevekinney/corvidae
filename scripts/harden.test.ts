import { describe, expect, test } from 'bun:test';
import { UsageError } from './chef/process-runner.ts';
import { parseHardenOptions, planSteps, summarize } from './harden.ts';

describe('harden options', () => {
  test('defaults to three rounds and half the processors as load', () => {
    expect(parseHardenOptions([], 10)).toEqual({
      rounds: 3,
      load: 5,
      isolatedOnly: false,
      json: false,
    });
    expect(parseHardenOptions([], 1).load).toBe(1);
  });

  test('reads --rounds, --load, --isolated-only and --json', () => {
    expect(
      parseHardenOptions(['--rounds', '5', '--load', '0', '--isolated-only', '--json'], 8),
    ).toEqual({ rounds: 5, load: 0, isolatedOnly: true, json: true });
  });

  test('rejects a bad count or a stray argument', () => {
    for (const argv of [['--rounds', '0'], ['--rounds', 'two'], ['--load', '-1'], ['extra']])
      expect(() => parseHardenOptions(argv, 8)).toThrow(UsageError);
  });
});

describe('harden plan', () => {
  const options = { rounds: 2, load: 4, isolatedOnly: false, json: false };

  test('runs every isolated round, serially and uncached, then the fast lanes once', () => {
    const steps = planSteps(options);
    expect(steps.map((step) => step.label)).toEqual(['isolated-1', 'isolated-2', 'fast']);
    for (const step of steps) expect(step.command).toContain('--force');
    expect(steps[0]!.command).toEqual(
      expect.arrayContaining(['test:slow', 'test:self:slow', '--concurrency=1']),
    );
    expect(steps[2]!.command).toEqual(expect.arrayContaining(['test', 'test:self']));
  });

  test('--isolated-only leaves the fast lanes out', () => {
    expect(planSteps({ ...options, isolatedOnly: true }).map((step) => step.label)).toEqual([
      'isolated-1',
      'isolated-2',
    ]);
  });
});

describe('harden verdict', () => {
  const options = { rounds: 2, load: 4, isolatedOnly: true, json: false };

  test('passes only when every step passed', () => {
    const passed = summarize(
      [
        { label: 'isolated-1', command: 'x', exitCode: 0 },
        { label: 'isolated-2', command: 'x', exitCode: 0 },
      ],
      options,
    );
    expect(passed.code).toBe(0);
    expect(passed.lines[0]).toBe('harden: 2 step(s) under 4 load generator(s); 0 failed.');
  });

  test('one failed round fails the run and points at the control, never a rerun', () => {
    const failed = summarize(
      [
        { label: 'isolated-1', command: 'x', exitCode: 0 },
        { label: 'isolated-2', command: 'x', exitCode: 1 },
      ],
      options,
    );
    expect(failed.code).toBe(1);
    expect(failed.lines).toContain('  isolated-2: exit 1');
    expect(failed.lines.join('\n')).toContain('gate-run.ts control');
  });
});
