import { afterEach, beforeEach, describe, expect, test } from 'bun:test';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { mergeGate, renderMergeGate, run, type MergeGateOptions } from './merge-gate.ts';
import { UsageError, type Runner } from './process-runner.ts';

const HEAD = 'a'.repeat(40);
const OTHER = 'b'.repeat(40);
const BASE = 'c'.repeat(40);
const MERGE = 'd'.repeat(40);

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
  writeFileSync(join(sandbox, 'gate.log'), `HEAD ${HEAD} LOAD 1.00\nGATE_RC=0\n`);
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
      [`HEAD ${HEAD} LOAD 1\nGATE_RC=1\n`, 'exited 1'],
      [`HEAD ${OTHER} LOAD 1\nGATE_RC=0\n`, 'not at'],
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
