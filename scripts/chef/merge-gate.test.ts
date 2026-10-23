import { afterEach, beforeEach, describe, expect, test } from 'bun:test';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { mergeGate, renderMergeGate, run, type MergeGateOptions } from './merge-gate.ts';
import { UsageError, type Runner } from './process-runner.ts';

const HEAD = 'a'.repeat(40);
const OTHER = 'b'.repeat(40);
const BASE = 'c'.repeat(40);
const MERGE = 'd'.repeat(40);

/** A log as `gate-run.ts run` writes it; each part can be overridden to build a bad one. */
function gateLog(
  parts: { head?: string; start?: string; end?: string; exit?: string } = {},
): string {
  return [
    `HEAD ${parts.head ?? HEAD} LOAD 1.00`,
    parts.start ?? `TREE_START clean=true head=${HEAD}`,
    'gate output',
    parts.end ?? `TREE_END clean=true head=${HEAD}`,
    parts.exit ?? 'GATE_RC=0',
    '',
  ].join('\n');
}

let sandbox: string;
let options: MergeGateOptions;

beforeEach(() => {
  sandbox = mkdtempSync(join(tmpdir(), 'merge-gate-'));
  const configPath = join(sandbox, 'config.json');
  writeFileSync(
    configPath,
    JSON.stringify({
      repository: 'acme/widgets',
      defaultBranch: 'main',
      worktreeRoots: { claude: '/c', codex: '/x' },
      manifestName: 'widgets',
      installCommand: 'true',
      gateCommand: 'true',
      affectedCheckCommand: 'true',
      mergeMethod: 'squash',
    }),
  );
  writeFileSync(join(sandbox, 'gate.log'), gateLog());
  writeFileSync(join(sandbox, 'comment.md'), 'Gate passed at the head.\n');
  options = {
    configPath,
    pr: 12,
    worktree: sandbox,
    gateLog: join(sandbox, 'gate.log'),
    commentFile: join(sandbox, 'comment.md'),
    dryRun: false,
  };
});

afterEach(() => {
  rmSync(sandbox, { recursive: true, force: true });
});

interface World {
  head?: string;
  pullRequestHead?: string;
  state?: string;
  /** One entry per `merge-base --is-ancestor` call; the last repeats. */
  ancestors?: boolean[];
  threadTotal?: number;
  threadNodes?: { id: string; isResolved: boolean }[];
  commentCode?: number;
  mergeCode?: number;
  mergedState?: string;
  mergeCommit?: string | null;
  diffCode?: number;
  fetchCodes?: number[];
}

function fake(world: World = {}) {
  const calls: string[][] = [];
  let ancestorCall = 0;
  let fetchCall = 0;
  const nodes = world.threadNodes ?? [{ id: 'T1', isResolved: true }];
  const runner: Runner = (command) => {
    calls.push(command);
    const [program, ...rest] = command;
    if (program === 'git') {
      if (rest[0] === 'fetch') {
        const code = world.fetchCodes?.[Math.min(fetchCall, world.fetchCodes.length - 1)] ?? 0;
        fetchCall += 1;
        return { code, stdout: '', stderr: code === 0 ? '' : 'fatal: unable to access' };
      }
      if (rest[0] === 'rev-parse')
        return rest[1] === 'HEAD'
          ? { code: 0, stdout: `${world.head ?? HEAD}\n`, stderr: '' }
          : { code: 0, stdout: `${BASE}\n`, stderr: '' };
      if (rest[0] === 'merge-base') {
        const sequence = world.ancestors ?? [true];
        const answer = sequence[Math.min(ancestorCall, sequence.length - 1)];
        ancestorCall += 1;
        return { code: answer ? 0 : 1, stdout: '', stderr: '' };
      }
      if (rest[0] === 'diff') return { code: world.diffCode ?? 0, stdout: '', stderr: '' };
    }
    if (program === 'gh' && rest[0] === 'pr' && rest[1] === 'view') {
      return rest.includes('headRefOid,mergeStateStatus,state')
        ? {
            code: 0,
            stdout: JSON.stringify({
              headRefOid: world.pullRequestHead ?? HEAD,
              mergeStateStatus: 'CLEAN',
              state: world.state ?? 'OPEN',
            }),
            stderr: '',
          }
        : {
            code: 0,
            stdout: JSON.stringify({
              state: world.mergedState ?? 'MERGED',
              mergeCommit: world.mergeCommit === null ? null : { oid: world.mergeCommit ?? MERGE },
            }),
            stderr: '',
          };
    }
    if (program === 'gh' && rest[0] === 'api') {
      return {
        code: 0,
        stdout: JSON.stringify({
          data: {
            repository: {
              pullRequest: {
                reviewThreads: {
                  totalCount: world.threadTotal ?? nodes.length,
                  pageInfo: { hasNextPage: false, endCursor: null },
                  nodes: nodes.map((node) => ({
                    ...node,
                    path: 'a.ts',
                    line: 1,
                    comments: { nodes: [{ databaseId: 1, body: 'x', author: { login: 'r' } }] },
                  })),
                },
              },
            },
          },
        }),
        stderr: '',
      };
    }
    if (program === 'gh' && rest[0] === 'pr' && rest[1] === 'comment')
      return { code: world.commentCode ?? 0, stdout: '', stderr: 'comment failed' };
    if (program === 'gh' && rest[0] === 'pr' && rest[1] === 'merge')
      return { code: world.mergeCode ?? 0, stdout: '', stderr: 'not mergeable' };
    throw new Error(`unexpected command ${command.join(' ')}`);
  };
  const posted = () => calls.some((call) => call[0] === 'gh' && call[2] === 'comment');
  const merged = () => calls.some((call) => call[0] === 'gh' && call[2] === 'merge');
  return { runner, calls, posted, merged };
}

describe('mergeGate', () => {
  describe('main health', () => {
    const redHead = 'e'.repeat(40);
    function writeHealth(exitCode: number) {
      options.healthFile = join(sandbox, 'tmp', 'main-health.json');
      mkdirSync(join(sandbox, 'tmp'), { recursive: true });
      writeFileSync(
        options.healthFile,
        JSON.stringify({
          runs: [{ head: redHead, exitCode, time: 't', command: 'bun run validate' }],
          fixes: [],
        }),
      );
    }
    /** `fake`, plus a first-parent history that holds the validated head. */
    function withHistory(history: string[] = [BASE, redHead]) {
      const world = fake();
      const inner = world.runner;
      const runner: Runner = (command, runnerOptions) =>
        command[1] === 'rev-list'
          ? { code: 0, stdout: `${history.join('\n')}\n`, stderr: '' }
          : inner(command, runnerOptions);
      return { ...world, runner };
    }

    test('refuses to merge while the last batch validate on main failed', () => {
      writeHealth(1);
      const { runner, merged, posted } = withHistory();
      const report = mergeGate(options, { runner });
      expect(report.failedStep).toBe('main-health');
      expect(report.detail).toContain('--fixes-main');
      expect(merged() || posted()).toBe(false);
    });

    test('lets the declared fix through, and records that it did', () => {
      writeHealth(1);
      options.fixesMain = true;
      const { runner } = withHistory();
      const report = mergeGate(options, { runner, now: () => new Date('2026-10-23T00:00:00Z') });
      expect(report.failedStep).toBeNull();
      expect(report.fixesMain).toBe(true);
      expect(JSON.parse(readFileSync(options.healthFile as string, 'utf8')).fixes).toEqual([
        { pr: 12, time: '2026-10-23T00:00:00.000Z', blockedHead: redHead },
      ]);
    });

    test('does not mark a pull request as the fix when main is green', () => {
      writeHealth(0);
      options.fixesMain = true;
      const report = mergeGate(options, { runner: withHistory().runner });
      expect(report.failedStep).toBeNull();
      expect(report.fixesMain).toBeUndefined();
    });

    test('a failure at a head that is not on main does not block', () => {
      writeHealth(1);
      const report = mergeGate(options, { runner: withHistory([BASE]).runner });
      expect(report.failedStep).toBeNull();
    });
  });

  test('runs the nine steps in order and reports the merged, tree-equal result', () => {
    const { runner, calls } = fake();
    const report = mergeGate(options, { runner });
    expect(report).toEqual({
      pr: 12,
      head: HEAD,
      base: BASE,
      gateRc: 0,
      threads: { seen: 1, total: 1, unresolved: 0 },
      merged: true,
      mergeCommit: MERGE,
      treesMatch: true,
      failedStep: null,
      detail: null,
    });
    const names = calls.map((call) =>
      call[0] === 'gh' ? `gh ${call[1]} ${call[2] ?? ''}`.trim() : `git ${call[1]}`,
    );
    expect(names).toEqual([
      'git fetch',
      'git rev-parse',
      'git rev-parse',
      'gh pr view',
      'git merge-base',
      'gh api graphql',
      'gh pr comment',
      'git fetch',
      'git merge-base',
      'git rev-parse',
      'gh pr merge',
      'gh pr view',
      'git fetch',
      'git diff',
    ]);
    const merge = calls.find((call) => call[2] === 'merge') ?? [];
    expect(merge).toEqual([
      'gh',
      'pr',
      'merge',
      '12',
      '--repo',
      'acme/widgets',
      '--squash',
      '--match-head-commit',
      HEAD,
    ]);
    expect(calls.find((call) => call[1] === 'diff')).toEqual([
      'git',
      'diff',
      '--quiet',
      MERGE,
      HEAD,
    ]);
    expect(calls.find((call) => call[2] === 'comment')).toEqual([
      'gh',
      'pr',
      'comment',
      '12',
      '--repo',
      'acme/widgets',
      '--body-file',
      options.commentFile,
    ]);
  });

  test('--dry-run runs every check and posts and merges nothing', () => {
    const world = fake();
    const report = mergeGate({ ...options, dryRun: true }, { runner: world.runner });
    expect(report.failedStep).toBeNull();
    expect(report.merged).toBe(false);
    expect(report.treesMatch).toBeNull();
    expect(world.posted()).toBe(false);
    expect(world.merged()).toBe(false);
    expect(renderMergeGate(report, true)).toContain('Dry run: every check passed');
  });

  test('stops when the worktree head is not the pull request head, before any write', () => {
    const world = fake({ pullRequestHead: OTHER });
    const report = mergeGate(options, { runner: world.runner });
    expect(report.failedStep).toBe('head');
    expect(report.detail).toContain('pull request head');
    expect(world.posted()).toBe(false);
    expect(world.merged()).toBe(false);
  });

  test('stops when the pull request is not open', () => {
    const report = mergeGate(options, { runner: fake({ state: 'MERGED' }).runner });
    expect(report).toMatchObject({ failedStep: 'head' });
    expect(report.detail).toContain('MERGED');
  });

  test('stops when HEAD does not contain the default branch', () => {
    const world = fake({ ancestors: [false] });
    const report = mergeGate(options, { runner: world.runner });
    expect(report.failedStep).toBe('contains-base');
    expect(world.posted()).toBe(false);
  });

  test('the gate log must hold exit code 0 at the pull request head', () => {
    const cases: [string, string][] = [
      [`HEAD ${HEAD} LOAD 1\nstill running\n`, 'no exit code'],
      [gateLog({ exit: 'GATE_RC=1' }), 'exited 1'],
      [gateLog({ head: OTHER }), 'not at'],
      ['GATE_RC=0\n', 'unknown commit'],
    ];
    for (const [log, message] of cases) {
      writeFileSync(options.gateLog, log);
      const world = fake();
      const report = mergeGate(options, { runner: world.runner });
      expect(report.failedStep, log).toBe('gate');
      expect(report.detail, log).toContain(message);
      expect(world.merged()).toBe(false);
    }
  });

  test('the worktree must be clean at the start and end of the gate run, with HEAD unmoved', () => {
    const cases: [string, string][] = [
      [gateLog({ start: `TREE_START clean=false head=${HEAD}` }), 'dirty at the start'],
      [gateLog({ end: `TREE_END clean=false head=${HEAD}` }), 'dirty at the end'],
      [gateLog({ start: `TREE_START clean=unknown head=${HEAD}` }), 'unknown state at the start'],
      [gateLog({ end: `TREE_END clean=true head=${OTHER}` }), 'at the end of the gate run, not'],
      [gateLog({ start: `TREE_START clean=true head=${OTHER}` }), 'at the start of the gate run'],
      // A log from before the tree lines were written has no basis to call the tree clean.
      [`HEAD ${HEAD} LOAD 1.00\nGATE_RC=0\n`, 'no single TREE_START line'],
      [gateLog({ end: '' }).replace('\n\n', '\n'), 'no single TREE_END line'],
    ];
    for (const [log, message] of cases) {
      writeFileSync(options.gateLog, log);
      const world = fake();
      const report = mergeGate(options, { runner: world.runner });
      expect(report.failedStep, log).toBe('gate');
      expect(report.detail, log).toContain(message);
      expect(world.posted(), log).toBe(false);
      expect(world.merged(), log).toBe(false);
    }
  });

  test('a log of two runs is refused even when the last run passed at the right head', () => {
    // The first run failed at another head; pairing its head with the second run's pass is the bug.
    writeFileSync(options.gateLog, `HEAD ${OTHER} LOAD 1\nGATE_RC=1\n${gateLog()}`);
    const report = mergeGate(options, { runner: fake().runner });
    expect(report.failedStep).toBe('gate');
    expect(report.detail).toContain('2 HEAD lines');
  });

  test('an unresolved thread, and a listing short of the total, both stop the merge', () => {
    const unresolved = fake({
      threadNodes: [
        { id: 'T1', isResolved: true },
        { id: 'T2', isResolved: false },
      ],
    });
    const first = mergeGate(options, { runner: unresolved.runner });
    expect(first.failedStep).toBe('threads');
    expect(first.detail).toContain('1 review thread(s) are unresolved');

    // Every visible thread is resolved, but GitHub reports more than were read.
    const short = fake({ threadTotal: 3 });
    const second = mergeGate(options, { runner: short.runner });
    expect(second.failedStep).toBe('threads');
    expect(second.detail).toContain('read 1 of 3');
    expect(short.posted()).toBe(false);
    expect(short.merged()).toBe(false);
  });

  test('the base moving after the comment stops before the merge', () => {
    const world = fake({ ancestors: [true, false] });
    const report = mergeGate(options, { runner: world.runner });
    expect(report.failedStep).toBe('refetch');
    expect(world.posted()).toBe(true);
    expect(world.merged()).toBe(false);
  });

  test('a failed fetch is named, at either fetch', () => {
    expect(mergeGate(options, { runner: fake({ fetchCodes: [128] }).runner }).failedStep).toBe(
      'fetch',
    );
    expect(mergeGate(options, { runner: fake({ fetchCodes: [0, 128] }).runner }).failedStep).toBe(
      'refetch',
    );
  });

  test('a failed comment or merge is named and nothing later runs', () => {
    const comment = fake({ commentCode: 1 });
    expect(mergeGate(options, { runner: comment.runner }).failedStep).toBe('comment');
    expect(comment.merged()).toBe(false);
    const refused = fake({ mergeCode: 1 });
    const report = mergeGate(options, { runner: refused.runner });
    expect(report.failedStep).toBe('merge');
    expect(report.merged).toBe(false);
  });

  test('a merge whose tree differs from the gated head is exit 1 with merged true', () => {
    const report = mergeGate(options, { runner: fake({ diffCode: 1 }).runner });
    expect(report).toMatchObject({
      failedStep: 'confirm',
      merged: true,
      mergeCommit: MERGE,
      treesMatch: false,
    });
  });

  test('confirms the merged state and the merge commit', () => {
    expect(mergeGate(options, { runner: fake({ mergedState: 'OPEN' }).runner }).failedStep).toBe(
      'confirm',
    );
    const none = mergeGate(options, { runner: fake({ mergeCommit: null }).runner });
    expect(none).toMatchObject({ failedStep: 'confirm', merged: true, mergeCommit: null });
  });
});

describe('spend record', () => {
  const totals = { input: 1200, cachedInput: 34000, output: 560 };
  const fixedNow = () => new Date('2026-10-22T18:30:00.000Z');

  test('appends one tab-separated line after a successful merge, from the injected usage', () => {
    const usageLog = join(sandbox, 'spend', 'usage.tsv');
    const seen: string[][] = [];
    const usage = (paths: string[]) => {
      seen.push(paths);
      return totals;
    };
    const transcript = join(sandbox, 'session.jsonl');
    const second = join(sandbox, 'subagents');
    writeFileSync(transcript, '');
    mkdirSync(second);
    for (const pr of [12, 13]) {
      const report = mergeGate(
        { ...options, pr, usageLog, transcripts: [transcript, second] },
        { runner: fake().runner, usage, now: fixedNow },
      );
      expect(report.failedStep).toBeNull();
      expect(report.usage).toEqual(totals);
    }
    expect(seen).toEqual([
      [transcript, second],
      [transcript, second],
    ]);
    expect(readFileSync(usageLog, 'utf8')).toBe(
      [
        `2026-10-22T18:30:00.000Z\t12\t${MERGE}\t1200\t34000\t560`,
        `2026-10-22T18:30:00.000Z\t13\t${MERGE}\t1200\t34000\t560`,
        '',
      ].join('\n'),
    );
  });

  test('without the flags nothing is read or written, and the report has no usage', () => {
    const report = mergeGate(options, {
      runner: fake().runner,
      usage: () => {
        throw new Error('read the transcripts without being asked');
      },
    });
    expect(report.failedStep).toBeNull();
    expect('usage' in report).toBe(false);
  });

  test('records nothing for a dry run or a failed merge', () => {
    const usageLog = join(sandbox, 'usage.tsv');
    const transcript = join(sandbox, 'session.jsonl');
    writeFileSync(transcript, '');
    const withRecord = { ...options, usageLog, transcripts: [transcript] };
    const dependencies = (runner: Runner) => ({ runner, usage: () => totals, now: fixedNow });
    expect(
      mergeGate({ ...withRecord, dryRun: true }, dependencies(fake().runner)).failedStep,
    ).toBeNull();
    expect(mergeGate(withRecord, dependencies(fake({ mergeCode: 1 }).runner)).failedStep).toBe(
      'merge',
    );
    expect(existsSync(usageLog)).toBe(false);
  });

  test('a record that cannot be produced is a named step after the merge', () => {
    const transcript = join(sandbox, 'session.jsonl');
    writeFileSync(transcript, '');
    const report = mergeGate(
      { ...options, usageLog: join(sandbox, 'usage.tsv'), transcripts: [transcript] },
      {
        runner: fake().runner,
        usage: () => {
          throw new Error('unreadable transcript');
        },
      },
    );
    expect(report.merged).toBe(true);
    expect(report.failedStep).toBe('usage');
    expect(report.detail).toContain('unreadable transcript');
  });

  test('the two flags go together and a missing transcript is refused before any write', () => {
    const { runner, calls } = fake();
    const transcript = join(sandbox, 'session.jsonl');
    writeFileSync(transcript, '');
    expect(() => mergeGate({ ...options, usageLog: join(sandbox, 'u.tsv') }, { runner })).toThrow(
      'go together',
    );
    expect(() => mergeGate({ ...options, transcripts: [transcript] }, { runner })).toThrow(
      'go together',
    );
    expect(() =>
      mergeGate(
        { ...options, usageLog: join(sandbox, 'u.tsv'), transcripts: [join(sandbox, 'nope')] },
        { runner },
      ),
    ).toThrow('No such transcript');
    expect(calls).toEqual([]);
  });

  test('--usage-log and repeated --transcript reach the record through run', () => {
    const usageLog = join(sandbox, 'usage.tsv');
    const first = join(sandbox, 'a.jsonl');
    const second = join(sandbox, 'b.jsonl');
    writeFileSync(first, '');
    writeFileSync(second, '');
    const seen: string[][] = [];
    const result = run(
      [
        '--config',
        options.configPath,
        '--pr',
        '12',
        '--worktree',
        options.worktree,
        '--gate-log',
        options.gateLog,
        '--comment-file',
        options.commentFile,
        '--usage-log',
        usageLog,
        '--transcript',
        first,
        '--transcript',
        second,
      ],
      {
        runner: fake().runner,
        usage: (paths) => {
          seen.push(paths);
          return totals;
        },
        now: fixedNow,
      },
    );
    expect(result.code).toBe(0);
    expect(result.output).toContain('usage recorded: input=1200 cachedInput=34000 output=560');
    expect(seen).toEqual([[first, second]]);
    expect(readFileSync(usageLog, 'utf8').trim().split('\t')).toEqual([
      '2026-10-22T18:30:00.000Z',
      '12',
      MERGE,
      '1200',
      '34000',
      '560',
    ]);
  });
});

describe('run', () => {
  const argv = () => [
    '--config',
    options.configPath,
    '--pr',
    '12',
    '--worktree',
    options.worktree,
    '--gate-log',
    options.gateLog,
    '--comment-file',
    options.commentFile,
  ];

  test('exits 0 with one JSON object under --json, and 1 naming the failed step otherwise', () => {
    const passing = run([...argv(), '--json'], { runner: fake().runner });
    expect(passing.code).toBe(0);
    expect(JSON.parse(passing.output).treesMatch).toBe(true);
    const failing = run(argv(), { runner: fake({ pullRequestHead: OTHER }).runner });
    expect(failing.code).toBe(1);
    expect(failing.output).toContain('FAILED at head');
  });

  test('rejects bad usage before touching anything', () => {
    const { runner, calls } = fake();
    expect(() => run([], { runner })).toThrow(UsageError);
    expect(() => run([...argv(), 'extra'], { runner })).toThrow(UsageError);
    expect(() => run([...argv(), '--pr', 'x'], { runner })).toThrow(UsageError);
    expect(() => run([...argv(), '--bogus'], { runner })).toThrow(UsageError);
    writeFileSync(options.commentFile, '  \n');
    expect(() => run(argv(), { runner })).toThrow('is empty');
    expect(() =>
      run(
        argv().map((part) => (part === options.gateLog ? '/missing.log' : part)),
        { runner },
      ),
    ).toThrow('No such gate log');
    expect(calls).toEqual([]);
  });
});
