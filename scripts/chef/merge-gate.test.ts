import { afterEach, beforeEach, describe, expect, test } from 'bun:test';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { spawnWithHangGuard } from '../../testing/testing/src/hang-guard.ts';
import { processStartTime } from '../run-exclusively.ts';
import {
  mergeGate,
  mergeGateExclusively,
  renderMergeGate,
  run,
  type MergeGateOptions,
} from './merge-gate.ts';
import { UsageError, type Runner } from './process-runner.ts';

const HEAD = 'a'.repeat(40);
const OTHER = 'b'.repeat(40);
const BASE = 'c'.repeat(40);
const MERGE = 'd'.repeat(40);
const EXPECTED_TREE = '9'.repeat(40);

let sandbox: string;
let options: MergeGateOptions;

/** A fresh worktree directory holding the configuration and comment the gate reads. */
function prepare(): { directory: string; prepared: MergeGateOptions } {
  const directory = mkdtempSync(join(tmpdir(), 'merge-gate-'));
  const configPath = join(directory, 'config.json');
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
  writeFileSync(join(directory, 'comment.md'), 'Accepted at the head.\n');
  return {
    directory,
    prepared: {
      configPath,
      pr: 12,
      worktree: directory,
      commentFile: join(directory, 'comment.md'),
      dryRun: false,
    },
  };
}

beforeEach(() => {
  const made = prepare();
  sandbox = made.directory;
  options = made.prepared;
});

afterEach(() => {
  rmSync(sandbox, { recursive: true, force: true });
});

interface World {
  head?: string;
  pullRequestHead?: string;
  state?: string;
  /** `mergeable` per `gh pr view` read; the last repeats. `MERGEABLE` unless a test says otherwise. */
  mergeable?: string[];
  mergeStateStatus?: string;
  threadTotal?: number;
  threadNodes?: { id: string; isResolved: boolean }[];
  commentCode?: number;
  mergeCode?: number;
  mergedState?: string;
  mergeCommit?: string | null;
  fetchCodes?: number[];
  /** The stderr of a failed fetch; a generic network error unless a test says otherwise. */
  fetchStderr?: string;
  /** `git merge-tree --write-tree <merge commit>^1 <head>` exit code. */
  mergeTreeCode?: number;
  /** The tree that command computes. */
  expectedTree?: string;
  /** The tree of the squash commit; the expected tree unless a test overrides it. */
  mergedTree?: string;
}

function fake(world: World = {}) {
  const calls: string[][] = [];
  const comments: string[] = [];
  let fetchCall = 0;
  let viewCall = 0;
  const nodes = world.threadNodes ?? [{ id: 'T1', isResolved: true }];
  const runner: Runner = (command) => {
    calls.push(command);
    const [program, ...rest] = command;
    if (program === 'git') {
      if (rest[0] === 'fetch') {
        const code = world.fetchCodes?.[Math.min(fetchCall, world.fetchCodes.length - 1)] ?? 0;
        fetchCall += 1;
        return {
          code,
          stdout: '',
          stderr: code === 0 ? '' : (world.fetchStderr ?? 'fatal: unable to access'),
        };
      }
      if (rest[0] === 'merge-tree')
        return {
          code: world.mergeTreeCode ?? 0,
          stdout: `${world.expectedTree ?? EXPECTED_TREE}\n`,
          stderr: world.mergeTreeCode === undefined ? '' : 'CONFLICT',
        };
      if (rest[0] === 'rev-parse' && rest[1]?.endsWith('^{tree}'))
        return {
          code: 0,
          stdout: `${world.mergedTree ?? world.expectedTree ?? EXPECTED_TREE}\n`,
          stderr: '',
        };
      if (rest[0] === 'rev-parse')
        return {
          code: 0,
          stdout: `${rest[1] === 'HEAD' ? (world.head ?? HEAD) : BASE}\n`,
          stderr: '',
        };
    }
    if (program === 'gh' && rest[0] === 'pr' && rest[1] === 'view') {
      if (!rest.includes('headRefOid,mergeable,mergeStateStatus,state'))
        return {
          code: 0,
          stdout: JSON.stringify({
            state: world.mergedState ?? 'MERGED',
            mergeCommit: world.mergeCommit === null ? null : { oid: world.mergeCommit ?? MERGE },
          }),
          stderr: '',
        };
      const sequence = world.mergeable ?? ['MERGEABLE'];
      const mergeable = sequence[Math.min(viewCall, sequence.length - 1)];
      viewCall += 1;
      return {
        code: 0,
        stdout: JSON.stringify({
          headRefOid: world.pullRequestHead ?? HEAD,
          mergeable,
          mergeStateStatus: world.mergeStateStatus ?? 'CLEAN',
          state: world.state ?? 'OPEN',
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
    if (program === 'gh' && rest[0] === 'pr' && rest[1] === 'comment') {
      comments.push(readFileSync(rest[rest.indexOf('--body-file') + 1] as string, 'utf8'));
      return { code: world.commentCode ?? 0, stdout: '', stderr: 'comment failed' };
    }
    if (program === 'gh' && rest[0] === 'pr' && rest[1] === 'merge')
      return { code: world.mergeCode ?? 0, stdout: '', stderr: 'not mergeable' };
    throw new Error(`unexpected command ${command.join(' ')}`);
  };
  const posted = () => calls.some((call) => call[0] === 'gh' && call[2] === 'comment');
  const merged = () => calls.some((call) => call[0] === 'gh' && call[2] === 'merge');
  /** Anything that is not git or gh would be a test gate, an install or a build. */
  const ranGate = () => calls.some((call) => call[0] !== 'git' && call[0] !== 'gh');
  return { runner, calls, comments, posted, merged, ranGate };
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

    test('a red main is a warning in the report, never a refusal', () => {
      writeHealth(1);
      const { runner, merged, posted } = withHistory();
      const report = mergeGate(options, { runner });
      expect(report.failedStep).toBeNull();
      expect(report.merged).toBe(true);
      expect(report.mainHealthWarning).toContain('RED');
      expect(report.fixesMain).toBeUndefined();
      expect(merged() && posted()).toBe(true);
      expect(renderMergeGate(report, false)).toContain('WARNING main health:');
    });

    test('records the pull request as a repair when it is declared the fix', () => {
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

    test('a dry run warns without recording the fix', () => {
      writeHealth(1);
      options.fixesMain = true;
      const report = mergeGate({ ...options, dryRun: true }, { runner: withHistory().runner });
      expect(report.mainHealthWarning).toContain('RED');
      expect(JSON.parse(readFileSync(options.healthFile as string, 'utf8')).fixes).toEqual([]);
    });

    test('a green main carries no warning and marks no fix', () => {
      writeHealth(0);
      options.fixesMain = true;
      const report = mergeGate(options, { runner: withHistory().runner });
      expect(report.failedStep).toBeNull();
      expect(report.mainHealthWarning).toBeUndefined();
      expect(report.fixesMain).toBeUndefined();
    });

    test('a failure at a head that is not on main is not a warning either', () => {
      writeHealth(1);
      const report = mergeGate(options, { runner: withHistory([BASE]).runner });
      expect(report.failedStep).toBeNull();
      expect(report.mainHealthWarning).toBeUndefined();
    });
  });

  test('runs the steps in order and reports the merged, tree-equal result', () => {
    const { runner, calls, ranGate } = fake();
    const report = mergeGate(options, { runner });
    expect(report).toEqual({
      pr: 12,
      head: HEAD,
      base: BASE,
      mergeable: 'MERGEABLE',
      threads: { seen: 1, total: 1, unresolved: 0 },
      merged: true,
      mergeCommit: MERGE,
      treesMatch: true,
      failedStep: null,
      detail: null,
    });
    expect(ranGate()).toBe(false);
    const names = calls.map((call) =>
      call[0] === 'gh' ? `gh ${call[1]} ${call[2] ?? ''}`.trim() : `git ${call[1]}`,
    );
    expect(names).toEqual([
      'git fetch',
      'git rev-parse',
      'git rev-parse',
      'gh pr view',
      'gh api graphql',
      'gh pr comment',
      'gh pr merge',
      'gh pr view',
      'git fetch',
      'git merge-tree',
      'git rev-parse',
    ]);
    expect(calls.find((call) => call[2] === 'merge')).toEqual([
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
    expect(calls.find((call) => call[1] === 'merge-tree')).toEqual([
      'git',
      'merge-tree',
      '--write-tree',
      `${MERGE}^1`,
      HEAD,
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

  describe('a head mismatch refuses', () => {
    test('when the worktree head is not the pull request head, before any write', () => {
      const world = fake({ pullRequestHead: OTHER });
      const report = mergeGate(options, { runner: world.runner });
      expect(report.failedStep).toBe('head');
      expect(report.detail).toContain('pull request head');
      expect(world.posted()).toBe(false);
      expect(world.merged()).toBe(false);
    });

    test('when the pull request head is not the head pinned at acceptance', () => {
      const world = fake();
      const report = mergeGate({ ...options, expectedHead: OTHER }, { runner: world.runner });
      expect(report.failedStep).toBe('head');
      expect(report.detail).toContain('pinned at acceptance');
      expect(world.posted()).toBe(false);
      expect(world.merged()).toBe(false);
    });

    test('and a pinned head that matches merges', () => {
      const report = mergeGate({ ...options, expectedHead: HEAD }, { runner: fake().runner });
      expect(report.failedStep).toBeNull();
    });

    test('when the pull request is not open', () => {
      const report = mergeGate(options, { runner: fake({ state: 'MERGED' }).runner });
      expect(report).toMatchObject({ failedStep: 'head' });
      expect(report.detail).toContain('MERGED');
    });
  });

  describe('a conflict with the base refuses', () => {
    test('when GitHub reports the pull request CONFLICTING', () => {
      const world = fake({ mergeable: ['CONFLICTING'] });
      const report = mergeGate(options, { runner: world.runner });
      expect(report.failedStep).toBe('conflict');
      expect(report.detail).toContain('conflicts with origin/main');
      expect(world.posted()).toBe(false);
      expect(world.merged()).toBe(false);
      expect(world.ranGate()).toBe(false);
    });

    test('when the merge state is DIRTY', () => {
      const world = fake({ mergeStateStatus: 'DIRTY' });
      expect(mergeGate(options, { runner: world.runner }).failedStep).toBe('conflict');
      expect(world.merged()).toBe(false);
    });

    test('after waiting while GitHub still computes the answer', () => {
      const world = fake({ mergeable: ['UNKNOWN', 'UNKNOWN', 'CONFLICTING'] });
      const sleeps: number[] = [];
      const report = mergeGate(options, {
        runner: world.runner,
        sleep: (milliseconds) => sleeps.push(milliseconds),
      });
      expect(report.failedStep).toBe('conflict');
      expect(sleeps).toHaveLength(2);
    });
  });

  describe('a base that moved without a conflict', () => {
    test('merges with no gate, install or build run, and no main merged in', () => {
      const world = fake({ mergeStateStatus: 'BEHIND' });
      const report = mergeGate(options, { runner: world.runner });
      expect(report).toMatchObject({ failedStep: null, merged: true, treesMatch: true });
      expect(world.ranGate()).toBe(false);
      expect(
        world.calls.some(
          (call) => call[0] === 'git' && ['merge', 'push', 'reset'].includes(call[1] ?? ''),
        ),
      ).toBe(false);
    });

    test('waits out an UNKNOWN mergeability and then merges', () => {
      const world = fake({ mergeable: ['UNKNOWN', 'MERGEABLE'] });
      const sleeps: number[] = [];
      const report = mergeGate(options, {
        runner: world.runner,
        sleep: (milliseconds) => sleeps.push(milliseconds),
      });
      expect(report).toMatchObject({ failedStep: null, merged: true, mergeable: 'MERGEABLE' });
      expect(sleeps).toEqual([2000]);
    });

    test('a mergeability that stays UNKNOWN stops after five reads, before any write', () => {
      const world = fake({ mergeable: ['UNKNOWN'] });
      const sleeps: number[] = [];
      const report = mergeGate(options, {
        runner: world.runner,
        sleep: (milliseconds) => sleeps.push(milliseconds),
      });
      expect(report.failedStep).toBe('mergeable');
      expect(sleeps).toHaveLength(4);
      expect(world.calls.filter((call) => call[2] === 'view')).toHaveLength(5);
      expect(world.posted() || world.merged()).toBe(false);
    });

    test('confirms the squash commit against the head merged into the commit it landed on', () => {
      const wrong = fake({ expectedTree: EXPECTED_TREE, mergedTree: OTHER });
      const report = mergeGate(options, { runner: wrong.runner });
      expect(report).toMatchObject({
        failedStep: 'confirm',
        merged: true,
        mergeCommit: MERGE,
        treesMatch: false,
      });
      const failed = fake({ mergeTreeCode: 1 });
      expect(mergeGate(options, { runner: failed.runner })).toMatchObject({
        failedStep: 'confirm',
        merged: true,
      });
    });
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
    expect(unresolved.posted() || unresolved.merged()).toBe(false);

    // Every visible thread is resolved, but GitHub reports more than were read.
    const short = fake({ threadTotal: 3 });
    const second = mergeGate(options, { runner: short.runner });
    expect(second.failedStep).toBe('threads');
    expect(second.detail).toContain('read 1 of 3');
    expect(short.posted()).toBe(false);
    expect(short.merged()).toBe(false);
  });

  test('a failed fetch is named', () => {
    expect(mergeGate(options, { runner: fake({ fetchCodes: [128] }).runner }).failedStep).toBe(
      'fetch',
    );
  });

  test('a fetch that loses a ref-lock race is retried, and any other failure is not', () => {
    const lockStderr = "fatal: cannot lock ref 'refs/remotes/origin/main': is at a but expected b";
    const fetches = (calls: string[][]) => calls.filter((call) => call[1] === 'fetch').length;
    const sleeps: number[] = [];
    const retried = fake({ fetchCodes: [128, 128, 0], fetchStderr: lockStderr });
    const recovered = mergeGate(options, {
      runner: retried.runner,
      sleep: (milliseconds) => sleeps.push(milliseconds),
    });
    expect(recovered.failedStep).not.toBe('fetch');
    expect(sleeps).toHaveLength(2);
    for (const milliseconds of sleeps) {
      expect(milliseconds).toBeGreaterThanOrEqual(1_000);
      expect(milliseconds).toBeLessThan(2_000);
    }
    const stuck = fake({ fetchCodes: [128], fetchStderr: lockStderr });
    expect(mergeGate(options, { runner: stuck.runner, sleep: () => undefined }).failedStep).toBe(
      'fetch',
    );
    expect(fetches(stuck.calls)).toBe(3);
    const refused = fake({ fetchCodes: [128] });
    const noSleep: number[] = [];
    expect(
      mergeGate(options, { runner: refused.runner, sleep: (ms) => noSleep.push(ms) }).failedStep,
    ).toBe('fetch');
    expect(fetches(refused.calls)).toBe(1);
    expect(noSleep).toEqual([]);
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

  test('the posted comment is the comment file, with no base line', () => {
    const world = fake();
    mergeGate(options, { runner: world.runner });
    expect(world.comments).toEqual(['Accepted at the head.\n']);
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
    const conflicting = run(argv(), { runner: fake({ mergeable: ['CONFLICTING'] }).runner });
    expect(conflicting.code).toBe(1);
    expect(conflicting.output).toContain('FAILED at conflict');
  });

  test('--head pins the head the pull request must have', () => {
    expect(run([...argv(), '--head', HEAD], { runner: fake().runner }).code).toBe(0);
    const pinned = run([...argv(), '--head', OTHER], { runner: fake().runner });
    expect(pinned.code).toBe(1);
    expect(pinned.output).toContain('FAILED at head');
  });

  test('rejects bad usage before touching anything', () => {
    const { runner, calls } = fake();
    expect(() => run([], { runner })).toThrow(UsageError);
    expect(() => run([...argv(), 'extra'], { runner })).toThrow(UsageError);
    expect(() => run([...argv(), '--pr', 'x'], { runner })).toThrow(UsageError);
    expect(() => run([...argv(), '--bogus'], { runner })).toThrow(UsageError);
    expect(() => run([...argv(), '--head', 'abc123'], { runner })).toThrow(
      'is not a full commit SHA',
    );
    // The gate and the waivers are gone: their flags are unknown options now.
    for (const removed of ['--gate-log', '--waive-load-flake', '--control-head', '--reason'])
      expect(() => run([...argv(), removed, 'x'], { runner })).toThrow(UsageError);
    for (const removed of ['--waive-main-health'])
      expect(() => run([...argv(), removed], { runner })).toThrow(UsageError);
    writeFileSync(options.commentFile, '  \n');
    expect(() => run(argv(), { runner })).toThrow('is empty');
    expect(calls).toEqual([]);
  });
});

/**
 * The lock scenarios run at module scope, because acquiring the lock reads a process's start time
 * through `ps`, which a test body may not do on the per-test clock.
 */
async function lockScenarios() {
  const { directory, prepared } = prepare();
  const lockDirectory = join(directory, 'git', 'corvidae-merge-lock');
  mkdirSync(join(directory, 'git'), { recursive: true });
  const lockOptions: MergeGateOptions = { ...prepared, lockDirectory, lockPollIntervalMs: 10 };
  const plantHolder = (pid: number, pidStartedAt?: string) => {
    mkdirSync(lockDirectory);
    writeFileSync(
      join(lockDirectory, 'owner.json'),
      JSON.stringify({
        pid,
        ...(pidStartedAt === undefined ? {} : { pidStartedAt }),
        command: 'merge-gate pr #1',
        cwd: directory,
        acquiredAt: new Date().toISOString(),
        token: 'planted',
      }),
    );
  };
  const settled = (promise: Promise<unknown>, milliseconds: number) =>
    Promise.race([
      promise.then(() => 'done'),
      new Promise((resolve) => setTimeout(() => resolve('waiting'), milliseconds)),
    ]);

  // A live holder: the second session waits, touches nothing, and proceeds once it is released.
  plantHolder(process.pid, processStartTime(process.pid));
  const waiting = fake();
  const waits: unknown[] = [];
  const pending = mergeGateExclusively(lockOptions, { runner: waiting.runner }, (holder) =>
    waits.push(holder),
  );
  const whileHeld = await settled(pending, 150);
  const callsWhileHeld = waiting.calls.length;
  rmSync(lockDirectory, { recursive: true });
  const afterRelease = await pending;
  const waited = {
    whileHeld,
    callsWhileHeld,
    waits: waits.length,
    afterRelease,
    merged: waiting.merged(),
    lockGone: !existsSync(lockDirectory),
  };

  // A holder that died: its lock is reclaimed.
  const child = spawnWithHangGuard(['true']);
  await child.exited;
  plantHolder(child.pid);
  const reclaimWorld = fake();
  const reclaimed = {
    report: await mergeGateExclusively(lockOptions, { runner: reclaimWorld.runner }),
    merged: reclaimWorld.merged(),
    lockGone: !existsSync(lockDirectory),
  };

  // A failing step still releases the lock.
  const failed = {
    report: await mergeGateExclusively(lockOptions, { runner: fake({ mergeCode: 1 }).runner }),
    lockGone: !existsSync(lockDirectory),
  };

  // A dry run takes no lock, even while another session holds it.
  plantHolder(process.pid, processStartTime(process.pid));
  const dryRun = {
    report: await mergeGateExclusively({ ...lockOptions, dryRun: true }, { runner: fake().runner }),
    holderIntact: existsSync(join(lockDirectory, 'owner.json')),
  };
  rmSync(directory, { recursive: true, force: true });
  return { waited, reclaimed, failed, dryRun };
}

const locks = await lockScenarios();

describe('the cross-session merge lock', () => {
  test('a second holder waits while the first holds the lock, then proceeds when it releases', () => {
    expect(locks.waited.whileHeld).toBe('waiting');
    expect(locks.waited.callsWhileHeld).toBe(0);
    expect(locks.waited.waits).toBeGreaterThan(0);
    expect(locks.waited.afterRelease.failedStep).toBeNull();
    expect(locks.waited.merged).toBe(true);
    expect(locks.waited.lockGone).toBe(true);
  });

  test('reclaims the lock of a holder that died', () => {
    expect(locks.reclaimed.report.failedStep).toBeNull();
    expect(locks.reclaimed.merged).toBe(true);
    expect(locks.reclaimed.lockGone).toBe(true);
  });

  test('releases the lock when a step fails', () => {
    expect(locks.failed.report.failedStep).toBe('merge');
    expect(locks.failed.lockGone).toBe(true);
  });

  test('a dry run takes no lock, even while another session holds it', () => {
    expect(locks.dryRun.report.failedStep).toBeNull();
    expect(locks.dryRun.holderIntact).toBe(true);
  });
});
