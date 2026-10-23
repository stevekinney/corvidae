import { afterEach, beforeEach, describe, expect, test } from 'bun:test';
import { existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { batchValidate, decideDue, run, type BatchValidateOptions } from './batch-validate.ts';
import type { GateRunOptions, GateRunResult } from './gate-run.ts';
import { healthFilePath } from './main-health.ts';
import { UsageError, type Runner } from './process-runner.ts';

const sha = (character: string) => character.repeat(40);
const now = new Date('2026-10-23T12:00:00.000Z');
const hoursAgo = (hours: number) => new Date(now.getTime() - hours * 3_600_000).toISOString();

const base = {
  tip: sha('f'),
  last: { head: sha('a'), exitCode: 0, time: hoursAgo(0.5), command: 'bun run validate' },
  mergesSince: 2,
  now,
  minimumMerges: 5,
  maximumAgeHours: 2,
  load: 1,
  maximumLoad: 8,
};

describe('decideDue', () => {
  test('waits for five merges or two hours', () => {
    expect(decideDue(base).due).toBe(false);
    expect(decideDue({ ...base, mergesSince: 5 })).toMatchObject({ due: true });
    expect(decideDue({ ...base, mergesSince: 5 }).reason).toContain('5 merges');
    const old = { ...base.last, time: hoursAgo(2) };
    expect(decideDue({ ...base, last: old }).reason).toContain('2.0 hours');
    expect(decideDue({ ...base, last: { ...old, time: hoursAgo(1.99) } }).due).toBe(false);
  });

  test('is due with no usable record, and never when main has not moved', () => {
    expect(decideDue({ ...base, last: undefined, mergesSince: undefined }).due).toBe(true);
    expect(decideDue({ ...base, tip: base.last.head, mergesSince: 99 }).due).toBe(false);
  });

  test('waits while the load is at or above the limit', () => {
    const busy = decideDue({ ...base, mergesSince: 9, load: 8 });
    expect(busy.due).toBe(false);
    expect(busy.reason).toContain('load');
    expect(decideDue({ ...base, mergesSince: 9, load: 7.9 }).due).toBe(true);
  });

  test('an unreadable last time counts as due rather than never', () => {
    const last = { ...base.last, time: 'garbage' };
    expect(decideDue({ ...base, last }).due).toBe(true);
  });
});

describe('batchValidate', () => {
  let sandbox: string;
  let main: string;
  let options: BatchValidateOptions;

  beforeEach(() => {
    sandbox = mkdtempSync(join(tmpdir(), 'batch-validate-'));
    main = join(sandbox, 'main');
    mkdirSync(main);
    const configPath = join(sandbox, 'config.json');
    writeFileSync(
      configPath,
      JSON.stringify({
        repository: 'o/n',
        defaultBranch: 'main',
        worktreeRoots: { claude: join(sandbox, 'wt'), codex: '/x' },
        manifestName: 'n',
        installCommand: 'install-it',
        gateCommand: 'bun run check',
        affectedCheckCommand: 'bun run check',
        batchCommand: 'bun run validate',
        mergeMethod: 'squash',
      }),
    );
    options = {
      configPath,
      minimumMerges: 5,
      maximumAgeHours: 2,
      maximumLoad: 8,
      worktree: undefined,
      dryRun: false,
    };
  });
  afterEach(() => rmSync(sandbox, { recursive: true, force: true }));

  /** Main's first-parent history is `history` (newest first); `git worktree add` creates the directory. */
  function world(history: string[]) {
    const commands: string[][] = [];
    const runner: Runner = (command) => {
      commands.push(command);
      const [program, ...rest] = command;
      if (rest[0] === 'rev-parse' && rest.includes('--git-common-dir'))
        return { code: 0, stdout: `${join(main, '.git')}\n`, stderr: '' };
      if (rest[0] === 'rev-parse') return { code: 0, stdout: `${history[0]}\n`, stderr: '' };
      if (rest[0] === 'rev-list') return { code: 0, stdout: `${history.join('\n')}\n`, stderr: '' };
      if (program === 'git' && rest[0] === 'worktree') {
        mkdirSync(rest[3] as string, { recursive: true });
      }
      return { code: 0, stdout: '', stderr: '' };
    };
    return { runner, commands };
  }

  function gateReturning(code: number) {
    const calls: GateRunOptions[] = [];
    const gate = (gateOptions: GateRunOptions): GateRunResult => {
      calls.push(gateOptions);
      return {
        code,
        head: sha('f'),
        waits: 0,
        startClean: true,
        endClean: true,
        endHead: sha('f'),
      };
    };
    return { gate, calls };
  }

  function record(head: string, exitCode: number, time: string) {
    const path = healthFilePath(main);
    mkdirSync(join(main, 'tmp', 'chef'), { recursive: true });
    writeFileSync(
      path,
      JSON.stringify({ runs: [{ head, exitCode, time, command: 'bun run validate' }], fixes: [] }),
    );
  }

  const history = (count: number) =>
    Array.from({ length: count }, (_, index) => String(count - index).padStart(40, '0'));

  test('runs the batch command in a new dedicated worktree once five merges landed', () => {
    const commits = history(8);
    record(commits[5] as string, 0, hoursAgo(0.2));
    const { runner, commands } = world(commits);
    const { gate, calls } = gateReturning(0);
    const result = batchValidate(options, { runner, now: () => now, load: () => 1, gate });
    expect(result).toMatchObject({ ran: true, code: 0 });
    expect(result.reason).toContain('5 merges');
    expect(calls).toHaveLength(1);
    expect(calls[0]?.command).toBe('bun run validate');
    expect(calls[0]?.worktree).toBe(join(sandbox, 'wt', 'batch-validate'));
    expect(calls[0]?.log).toStartWith(join(main, 'tmp', 'chef', 'batch-validate'));
    expect(commands.some((c) => c.join(' ').startsWith('git worktree add --detach'))).toBe(true);
    expect(commands.some((c) => c[0] === 'sh' && c[2] === 'install-it')).toBe(true);
    expect(existsSync(join(main, 'tmp', 'chef', 'batch-validate.lock'))).toBe(false);
  });

  test('reuses the worktree by moving it to the tip, and reports a failing validate as exit 1', () => {
    const commits = history(8);
    record(commits[5] as string, 0, hoursAgo(0.2));
    mkdirSync(join(sandbox, 'wt', 'batch-validate'), { recursive: true });
    const { runner, commands } = world(commits);
    const result = batchValidate(options, {
      runner,
      now: () => now,
      load: () => 1,
      gate: gateReturning(3).gate,
    });
    expect(result).toMatchObject({ ran: true, code: 1 });
    expect(commands.some((c) => c.join(' ').includes('checkout --detach'))).toBe(true);
    expect(commands.some((c) => c.join(' ').includes('worktree add'))).toBe(false);
  });

  test('skips when too few merges, high load, a live lock, or a dry run', () => {
    const commits = history(8);
    const { gate, calls } = gateReturning(0);
    record(commits[2] as string, 0, hoursAgo(0.2));
    const quiet = batchValidate(options, {
      runner: world(commits).runner,
      now: () => now,
      load: () => 1,
      gate,
    });
    expect(quiet).toMatchObject({ ran: false, code: 0 });
    record(commits[5] as string, 0, hoursAgo(0.2));
    const busy = batchValidate(options, {
      runner: world(commits).runner,
      now: () => now,
      load: () => 12,
      gate,
    });
    expect(busy.reason).toContain('load');
    writeFileSync(join(main, 'tmp', 'chef', 'batch-validate.lock'), '4242\n');
    const locked = batchValidate(options, {
      runner: world(commits).runner,
      now: () => now,
      load: () => 1,
      alive: (pid) => pid === 4242,
      gate,
    });
    expect(locked.reason).toContain('already running');
    const stale = batchValidate(
      { ...options, dryRun: true },
      {
        runner: world(commits).runner,
        now: () => now,
        load: () => 1,
        alive: () => false,
        gate,
      },
    );
    expect(stale.reason).toStartWith('would run');
    expect(calls).toHaveLength(0);
  });

  test('a failing install is exit 1 and still releases the lock', () => {
    const commits = history(8);
    record(commits[5] as string, 0, hoursAgo(0.2));
    const { runner } = world(commits);
    const failing: Runner = (command, runnerOptions) =>
      command[0] === 'sh'
        ? { code: 1, stdout: '', stderr: 'boom' }
        : runner(command, runnerOptions);
    const result = batchValidate(options, {
      runner: failing,
      now: () => now,
      load: () => 1,
      gate: gateReturning(0).gate,
    });
    expect(result.code).toBe(1);
    expect(result.reason).toContain('install-it failed');
    expect(existsSync(join(main, 'tmp', 'chef', 'batch-validate.lock'))).toBe(false);
  });
});

describe('run', () => {
  test('rejects bad options', () => {
    expect(() => run(['--min-merges', 'many'])).toThrow(UsageError);
    expect(() => run(['extra'])).toThrow(UsageError);
  });
});
