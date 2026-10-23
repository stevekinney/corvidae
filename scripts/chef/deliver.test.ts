import { afterEach, beforeEach, describe, expect, test } from 'bun:test';
import { existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { deliver, renderDeliver, run, type DeliverOptions } from './deliver.ts';
import { LinearError, type LinearClient } from './linear.ts';
import type { MergeGateOptions, MergeGateReport } from './merge-gate.ts';
import { UsageError, type Runner } from './process-runner.ts';
import { Refusal } from './worktree.ts';

const HEAD = 'a'.repeat(40);
const MERGED_HEAD = 'e'.repeat(40);
const BASE = 'c'.repeat(40);
const MERGE_COMMIT = 'd'.repeat(40);
const MERGE_TREE = '9'.repeat(40);

let sandbox: string;
let options: DeliverOptions;

function passingLog(head: string): string {
  return [
    `HEAD ${head} LOAD 1.00`,
    `TREE_START clean=true head=${head}`,
    'output',
    `TREE_END clean=true head=${head}`,
    'GATE_RC=0',
    '',
  ].join('\n');
}

beforeEach(() => {
  sandbox = mkdtempSync(join(tmpdir(), 'deliver-'));
  const configPath = join(sandbox, 'config.json');
  writeFileSync(
    configPath,
    JSON.stringify({
      repository: 'acme/widgets',
      defaultBranch: 'main',
      worktreeRoots: { claude: '/c', codex: '/x' },
      manifestName: 'widgets',
      installCommand: 'install-command',
      gateCommand: 'true',
      affectedCheckCommand: 'true',
      mergeMethod: 'squash',
    }),
  );
  writeFileSync(join(sandbox, 'comment.md'), 'Gate passed.\n');
  writeFileSync(join(sandbox, 'done.md'), 'Delivered.\n');
  writeFileSync(join(sandbox, 'gate.log'), passingLog(HEAD));
  options = {
    configPath,
    pr: 12,
    worktree: sandbox,
    commentFile: join(sandbox, 'comment.md'),
    gateLog: join(sandbox, 'gate.log'),
  };
});

afterEach(() => {
  rmSync(sandbox, { recursive: true, force: true });
});

interface World {
  /** `merge-base --is-ancestor origin/main HEAD`: whether the head already contains the base. */
  contains?: boolean;
  /** `git merge-tree` exit code; 1 (a conflict) unless a test says otherwise. */
  mergeTreeCode?: number;
  pullRequestFiles?: string[];
  baseFiles?: string[];
  /** `git merge --no-edit origin/main` exit code. */
  mergeCode?: number;
  installCode?: number;
  pushCode?: number;
  dirty?: boolean;
  /** HEAD before and after the merge into the branch. */
  headAfterMerge?: string;
  /** The results of successive fetches; the last repeats, and an unset one succeeds. */
  fetchResults?: { code: number; stderr: string }[];
}

function fake(world: World = {}) {
  const calls: string[][] = [];
  let head = HEAD;
  let fetchCall = 0;
  const runner: Runner = (command) => {
    calls.push(command);
    const [program, ...rest] = command;
    if (program === 'sh')
      return { code: world.installCode ?? 0, stdout: '', stderr: 'install failed' };
    if (program !== 'git') return { code: 0, stdout: '', stderr: '' };
    switch (rest[0]) {
      case 'fetch': {
        const results = world.fetchResults ?? [];
        const result = results[Math.min(fetchCall, results.length - 1)] ?? { code: 0, stderr: '' };
        fetchCall += 1;
        return { ...result, stdout: '' };
      }
      case 'status':
        return { code: 0, stdout: world.dirty ? ' M file.ts\n' : '', stderr: '' };
      case 'rev-parse':
        return { code: 0, stdout: `${head}\n`, stderr: '' };
      case 'merge':
        if (rest[1] === '--abort') return { code: 0, stdout: '', stderr: '' };
        if ((world.mergeCode ?? 0) === 0) head = world.headAfterMerge ?? MERGED_HEAD;
        return { code: world.mergeCode ?? 0, stdout: '', stderr: 'CONFLICT (content)' };
      case 'push':
        return { code: world.pushCode ?? 0, stdout: '', stderr: 'rejected' };
      case 'merge-tree':
        return { code: world.mergeTreeCode ?? 1, stdout: `${MERGE_TREE}\n`, stderr: '' };
      case 'diff':
        return {
          code: 0,
          stdout: `${((rest[4] === 'HEAD' ? world.pullRequestFiles : world.baseFiles) ?? []).join('\n')}\n`,
          stderr: '',
        };
      case 'show':
        return { code: 128, stdout: '', stderr: 'fatal: path does not exist' };
      case 'ls-tree':
        return { code: 0, stdout: '', stderr: '' };
      case 'merge-base':
        return rest[1] === '--is-ancestor'
          ? { code: world.contains === false ? 1 : 0, stdout: '', stderr: '' }
          : { code: 0, stdout: `${'8'.repeat(40)}\n`, stderr: '' };
      default:
        return { code: 0, stdout: '', stderr: '' };
    }
  };
  return { runner, calls };
}

const mergedReport = (overrides: Partial<MergeGateReport> = {}): MergeGateReport => ({
  pr: 12,
  head: HEAD,
  base: BASE,
  gateRc: 0,
  threads: { seen: 1, total: 1, unresolved: 0 },
  merged: true,
  mergeCommit: MERGE_COMMIT,
  treesMatch: true,
  basePath: 'contains',
  failedStep: null,
  detail: null,
  ...overrides,
});

/** The merge gate, the gate run and the closeout steps, recording what each was asked. */
function seams(
  overrides: {
    merge?: MergeGateReport;
    gateCode?: number;
    refusal?: string;
    usageError?: string;
  } = {},
) {
  const record = {
    gates: [] as string[],
    merges: [] as string[],
    removals: [] as string[],
    requests: [] as string[],
  };
  let state = 'In Progress';
  let comment = '';
  const client: LinearClient = {
    async request<T>(document: string, variables: Record<string, unknown> = {}): Promise<T> {
      record.requests.push(document.split(/[ (]/)[1] ?? document);
      const issue = {
        id: 'uuid-9',
        identifier: 'COR-9',
        title: 'T',
        description: null,
        updatedAt: 'x',
        state: { id: state === 'Done' ? 's-done' : 's-doing', name: state },
        team: { id: 'team', key: 'COR', parent: null },
      };
      if (document.includes('IssueRead')) return { issue } as T;
      if (document.includes('CommentPost')) {
        comment = String(variables['body']);
        return { commentCreate: { success: true, comment: { id: 'c1' } } } as T;
      }
      if (document.includes('CommentRead'))
        return { comment: { id: 'c1', body: comment, issue: { identifier: 'COR-9' } } } as T;
      if (document.includes('TeamStates'))
        return {
          workflowStates: { nodes: [{ id: 's-done', name: 'Done', team: { id: 'team' } }] },
        } as T;
      if (document.includes('IssueSetState')) {
        state = 'Done';
        return { issueUpdate: { success: true } } as T;
      }
      throw new LinearError(`unexpected request ${document}`);
    },
  };
  return {
    record,
    partial: {
      gate: async (gateOptions: { log: string }) => {
        record.gates.push(gateOptions.log);
        mkdirSync(dirname(gateOptions.log), { recursive: true });
        writeFileSync(gateOptions.log, '');
        return {
          code: overrides.gateCode ?? 0,
          head: HEAD,
          waits: 0,
          startClean: true,
          endClean: true,
          endHead: HEAD,
        };
      },
      merge: async (mergeOptions: { gateLog: string }) => {
        record.merges.push(mergeOptions.gateLog);
        return overrides.merge ?? mergedReport();
      },
      remove: (removeOptions: { name: string }) => {
        record.removals.push(removeOptions.name);
        if (overrides.refusal !== undefined) throw new Refusal(overrides.refusal);
        if (overrides.usageError !== undefined) throw new UsageError(overrides.usageError);
        return { path: '/c/alpha', branch: 'b', remoteDeleted: true };
      },
      client,
    },
  };
}

describe('deliver', () => {
  test('a head that is already mergeable with a passing log merges without a new gate', async () => {
    const { runner, calls } = fake({ contains: true });
    const { partial, record } = seams();
    const report = await deliver(options, { ...partial, runner });
    expect(report).toMatchObject({
      merged: true,
      mergeCommit: MERGE_COMMIT,
      basePath: 'contains',
      gateLog: options.gateLog,
      failedStep: null,
      issue: null,
    });
    expect(record.gates).toEqual([]);
    expect(record.merges).toEqual([options.gateLog as string]);
    expect(calls.some((command) => command[1] === 'merge' || command[1] === 'push')).toBe(false);
  });

  test('a moved base merges main in, installs, pushes, discards the old log and regates', async () => {
    const { runner, calls } = fake({
      contains: false,
      mergeTreeCode: 0,
      pullRequestFiles: ['packages/a/x.ts'],
      baseFiles: ['bun.lock'],
    });
    const { partial, record } = seams();
    const report = await deliver(options, { ...partial, runner });
    expect(report.failedStep).toBeNull();
    expect(report.merged).toBe(true);
    const names = calls.map((command) => command.slice(0, 3).join(' '));
    const merge = names.indexOf('git merge --no-edit');
    const install = calls.findIndex((command) => command[0] === 'sh');
    const push = names.indexOf('git push origin');
    expect(merge).toBeGreaterThan(-1);
    expect(install).toBeGreaterThan(merge);
    expect(calls[install]?.[2]).toBe('install-command');
    expect(push).toBeGreaterThan(install);
    expect(calls).toContainEqual(['git', 'push', 'origin', 'HEAD']);
    expect(existsSync(options.gateLog as string)).toBe(false);
    const expectedLog = join(sandbox, `gate-${MERGED_HEAD.slice(0, 12)}.log`);
    expect(record.gates).toEqual([expectedLog]);
    expect(record.merges).toEqual([expectedLog]);
    expect(report.gateLog).toBe(expectedLog);
  });

  test('a log for another head is not reused, even when the base is fine', async () => {
    writeFileSync(options.gateLog as string, passingLog('f'.repeat(40)));
    const { runner } = fake({ contains: true });
    const { partial, record } = seams();
    const report = await deliver(
      { ...options, logDirectory: join(sandbox, 'logs') },
      { ...partial, runner },
    );
    expect(record.gates).toEqual([join(sandbox, 'logs', `gate-${HEAD.slice(0, 12)}.log`)]);
    expect(report.merged).toBe(true);
  });

  test('a conflict aborts the merge, changes nothing and does not push, gate or merge', async () => {
    const { runner, calls } = fake({ contains: false, mergeTreeCode: 1, mergeCode: 1 });
    const { partial, record } = seams();
    const report = await deliver(options, { ...partial, runner });
    expect(report.failedStep).toBe('conflict');
    expect(report.merged).toBe(false);
    expect(calls).toContainEqual(['git', 'merge', '--abort']);
    expect(calls.some((command) => command[1] === 'push')).toBe(false);
    expect(calls.some((command) => command[0] === 'sh')).toBe(false);
    expect(existsSync(options.gateLog as string)).toBe(true);
    expect(record.gates).toEqual([]);
    expect(record.merges).toEqual([]);
  });

  test('a dirty worktree is refused before main is merged into it', async () => {
    const { runner, calls } = fake({ contains: false, mergeTreeCode: 1, dirty: true });
    const { partial } = seams();
    const report = await deliver(options, { ...partial, runner });
    expect(report.failedStep).toBe('base');
    expect(calls.some((command) => command[1] === 'merge')).toBe(false);
  });

  test('a fetch that loses a ref-lock race is retried, with a backoff, and then succeeds', async () => {
    const lock = {
      code: 1,
      stderr: "fatal: cannot lock ref 'refs/remotes/origin/main': is at a but expected b",
    };
    const { runner, calls } = fake({
      contains: true,
      fetchResults: [lock, lock, { code: 0, stderr: '' }],
    });
    const { partial } = seams();
    const sleeps: number[] = [];
    const report = await deliver(options, {
      ...partial,
      runner,
      sleep: (milliseconds) => sleeps.push(milliseconds),
    });
    expect(report.failedStep).toBeNull();
    expect(calls.filter((call) => call[1] === 'fetch')).toHaveLength(3);
    expect(sleeps).toHaveLength(2);
    for (const milliseconds of sleeps) {
      expect(milliseconds).toBeGreaterThanOrEqual(1_000);
      expect(milliseconds).toBeLessThan(2_000);
    }
  });

  test('a fetch that keeps losing the race stops after three tries, and any other error at once', async () => {
    const lock = { code: 1, stderr: "fatal: cannot lock ref 'refs/remotes/origin/main'" };
    const stuck = fake({ contains: true, fetchResults: [lock] });
    const first = await deliver(options, {
      ...seams().partial,
      runner: stuck.runner,
      sleep: () => undefined,
    });
    expect(first.failedStep).toBe('fetch');
    expect(stuck.calls.filter((call) => call[1] === 'fetch')).toHaveLength(3);
    const refused = fake({
      contains: true,
      fetchResults: [{ code: 128, stderr: 'fatal: unable to access the remote' }],
    });
    const sleeps: number[] = [];
    const second = await deliver(options, {
      ...seams().partial,
      runner: refused.runner,
      sleep: (milliseconds) => sleeps.push(milliseconds),
    });
    expect(second.failedStep).toBe('fetch');
    expect(refused.calls.filter((call) => call[1] === 'fetch')).toHaveLength(1);
    expect(sleeps).toEqual([]);
  });

  test('a failed gate stops before the merge', async () => {
    writeFileSync(options.gateLog as string, 'HEAD x LOAD 1\nGATE_RC=1\n');
    const { runner } = fake({ contains: true });
    const { partial, record } = seams({ gateCode: 1 });
    const report = await deliver(options, { ...partial, runner });
    expect(report.failedStep).toBe('gate');
    expect(report.merged).toBe(false);
    expect(record.gates).toHaveLength(1);
    expect(record.merges).toEqual([]);
  });

  test("the merge gate's own refusal is reported under its step", async () => {
    const { runner } = fake({ contains: true });
    const { partial } = seams({
      merge: mergedReport({
        merged: false,
        mergeCommit: null,
        failedStep: 'threads',
        detail: '1 review thread(s) are unresolved.',
      }),
    });
    const report = await deliver(options, { ...partial, runner });
    expect(report).toMatchObject({ merged: false, failedStep: 'threads' });
    expect(renderDeliver(report)).toContain('FAILED at threads');
  });

  test('closes the issue with the completion comment and the Done state, read back', async () => {
    const { runner } = fake({ contains: true });
    const { partial, record } = seams();
    const report = await deliver(
      { ...options, issue: 'COR-9', completionFile: join(sandbox, 'done.md') },
      { ...partial, runner },
    );
    expect(report).toMatchObject({ merged: true, failedStep: null, issue: 'Done' });
    expect(record.requests).toContain('CommentPost');
    expect(record.requests).toContain('IssueSetState');
  });

  test('a Linear failure after the merge is step issue with merged true, and removal is skipped', async () => {
    const { runner } = fake({ contains: true });
    const { partial, record } = seams();
    const broken: LinearClient = {
      async request() {
        throw new LinearError('Linear rejected the request: nope');
      },
    };
    const report = await deliver(
      {
        ...options,
        issue: 'COR-9',
        completionFile: join(sandbox, 'done.md'),
        removeWorktree: { provider: 'claude', name: 'alpha' },
      },
      { ...partial, client: broken, runner },
    );
    expect(report).toMatchObject({ merged: true, failedStep: 'issue', mergeCommit: MERGE_COMMIT });
    expect(report.detail).toContain('nope');
    expect(record.removals).toEqual([]);
  });

  const mergedInWorld = {
    contains: false,
    mergeTreeCode: 0,
    pullRequestFiles: ['packages/a/x.ts'],
    baseFiles: ['bun.lock'],
  };

  test('an install failure after a clean merge-in stops before the push, gate and merge', async () => {
    const { runner, calls } = fake({ ...mergedInWorld, installCode: 1 });
    const { partial, record } = seams();
    const report = await deliver(options, { ...partial, runner });
    expect(report).toMatchObject({ merged: false, failedStep: 'install' });
    expect(calls).toContainEqual(['git', 'reset', '--hard', HEAD]);
    expect(calls.some((command) => command[1] === 'push')).toBe(false);
    expect(record.gates).toEqual([]);
    expect(record.merges).toEqual([]);
  });

  test('a push failure after a clean merge-in stops before the gate and merge', async () => {
    const { runner, calls } = fake({ ...mergedInWorld, pushCode: 1 });
    const { partial, record } = seams();
    const report = await deliver(options, { ...partial, runner });
    expect(report).toMatchObject({ merged: false, failedStep: 'push' });
    expect(calls).toContainEqual(['git', 'reset', '--hard', HEAD]);
    expect(report.detail).toContain('restored');
    expect(record.gates).toEqual([]);
    expect(record.merges).toEqual([]);
  });

  test('a usage error at the worktree step is step worktree with merged true', async () => {
    const { runner } = fake({ contains: true });
    const { partial } = seams({ usageError: '--name "x" is not a safe name.' });
    const report = await deliver(
      { ...options, removeWorktree: { provider: 'claude', name: 'x' } },
      { ...partial, runner },
    );
    expect(report).toMatchObject({ merged: true, failedStep: 'worktree' });
  });

  test('a worktree-removal refusal is reported with merged true', async () => {
    const { runner } = fake({ contains: true });
    const { partial, record } = seams({ refusal: 'Refusing to remove /c/alpha: it has 2 paths' });
    const report = await deliver(
      { ...options, removeWorktree: { provider: 'claude', name: 'alpha' } },
      { ...partial, runner },
    );
    expect(report).toMatchObject({ merged: true, failedStep: 'worktree' });
    expect(report.detail).toContain('Refusing to remove');
    expect(record.removals).toEqual(['alpha']);
  });
});

describe('a base that moves during the gate', () => {
  const refusal = mergedReport({
    merged: false,
    mergeCommit: null,
    failedStep: 'contains-base',
    detail: 'origin/main moved. Merge it in and re-gate.',
  });

  /** Seams whose merge gate refuses `moves` times, each time moving the base in the fake world. */
  function movingBase(world: World, moves: number, after?: MergeGateReport) {
    const { partial, record } = seams();
    const lines: string[] = [];
    let calls = 0;
    return {
      record,
      lines,
      partial: {
        ...partial,
        log: (line: string) => lines.push(line),
        merge: async (mergeOptions: MergeGateOptions) => {
          record.merges.push(mergeOptions.gateLog);
          calls += 1;
          if (calls <= moves) {
            world.contains = false;
            world.mergeTreeCode = 0;
            return refusal;
          }
          return after ?? mergedReport();
        },
      },
    };
  }

  const movedWorld = (): World => ({
    contains: true,
    pullRequestFiles: ['packages/a/x.ts'],
    baseFiles: ['bun.lock'],
  });

  test('merges the new base in, re-gates and merges on the second attempt', async () => {
    // The head stays put across the merge-in, so the first attempt's passing log would still look
    // valid: only the reset after the merge-in makes the retry gate again into its own log.
    const world = { ...movedWorld(), headAfterMerge: HEAD };
    const { runner, calls } = fake(world);
    const { partial, record, lines } = movingBase(world, 1);
    const report = await deliver(options, { ...partial, runner });
    expect(report).toMatchObject({ merged: true, failedStep: null, attempts: 2 });
    expect(record.merges).toHaveLength(2);
    expect(record.merges[1]).not.toBe(record.merges[0]);
    expect(record.gates).toEqual([join(sandbox, `gate-${HEAD.slice(0, 12)}.log`)]);
    expect(calls).toContainEqual(['git', 'push', 'origin', 'HEAD']);
    expect(lines).toHaveLength(2);
    expect(lines[0]).toStartWith('attempt 1:');
    expect(lines[1]).toContain('attempt 2:');
    expect(lines[1]).toContain('gate exit 0');
    expect(renderDeliver(report)).toContain('attempts: 2');
  });

  test('stops after the maximum with contains-base when the base keeps moving', async () => {
    const world = movedWorld();
    const { runner } = fake(world);
    const { partial, record } = movingBase(world, 99);
    const report = await deliver(options, { ...partial, runner });
    expect(report).toMatchObject({ merged: false, failedStep: 'contains-base', attempts: 3 });
    expect(record.merges).toHaveLength(3);
  });

  test('--max-attempts caps the attempts, and 1 never retries', async () => {
    const world = movedWorld();
    const { runner } = fake(world);
    const { partial, record } = movingBase(world, 99);
    const report = await deliver({ ...options, maxAttempts: 1 }, { ...partial, runner });
    expect(report).toMatchObject({ failedStep: 'contains-base', attempts: 1 });
    expect(record.merges).toHaveLength(1);
  });

  test('a conflict while merging the new base in aborts cleanly as step conflict', async () => {
    const world = movedWorld();
    const { runner, calls } = fake(world);
    const { partial, record } = movingBase(world, 1);
    const conflicting = {
      ...partial,
      merge: async (mergeOptions: MergeGateOptions) => {
        world.mergeCode = 1;
        return partial.merge(mergeOptions);
      },
    };
    const report = await deliver(options, { ...conflicting, runner });
    expect(report).toMatchObject({ merged: false, failedStep: 'conflict', attempts: 2 });
    expect(calls).toContainEqual(['git', 'merge', '--abort']);
    expect(record.gates).toEqual([]);
    expect(record.merges).toHaveLength(1);
  });

  test('a gate failure on the retry stops without merging again', async () => {
    const world = movedWorld();
    const { runner } = fake(world);
    const { partial, record } = movingBase(world, 1);
    const failing = {
      ...partial,
      gate: async (gateOptions: { log: string }) => ({
        ...(await seams().partial.gate(gateOptions)),
        code: 1,
      }),
    };
    const report = await deliver(options, { ...failing, runner });
    expect(report).toMatchObject({ merged: false, failedStep: 'gate', attempts: 2 });
    expect(record.merges).toHaveLength(1);
  });

  test('a refusal other than contains-base does not retry', async () => {
    const world = movedWorld();
    const { runner } = fake(world);
    const { partial, record } = movingBase(
      world,
      0,
      mergedReport({ merged: false, mergeCommit: null, failedStep: 'threads', detail: 'open' }),
    );
    const report = await deliver(options, { ...partial, runner });
    expect(report).toMatchObject({ failedStep: 'threads', attempts: 1 });
    expect(record.merges).toHaveLength(1);
  });

  test('--max-attempts must be a positive integer', async () => {
    for (const bad of ['0', '-1', 'x', '1.5']) {
      let thrown: unknown;
      try {
        await run([
          '--pr',
          '12',
          '--worktree',
          sandbox,
          '--comment-file',
          'c.md',
          '--max-attempts',
          bad,
        ]);
      } catch (error) {
        thrown = error;
      }
      expect(thrown).toBeInstanceOf(UsageError);
    }
  });
});

describe('spend record', () => {
  test('--usage-log and --transcript reach the merge gate', async () => {
    const { runner } = fake({ contains: true });
    const { partial } = seams();
    const received: MergeGateOptions[] = [];
    const merge = async (mergeOptions: MergeGateOptions) => {
      received.push(mergeOptions);
      return mergedReport();
    };
    const result = await run(
      [
        '--config',
        options.configPath,
        '--pr',
        '12',
        '--worktree',
        sandbox,
        '--comment-file',
        options.commentFile,
        '--gate-log',
        options.gateLog as string,
        '--usage-log',
        '/tmp/usage.tsv',
        '--transcript',
        '/a.jsonl',
        '--transcript',
        '/b',
      ],
      { ...partial, merge, runner },
    );
    expect(result.code).toBe(0);
    expect(received).toHaveLength(1);
    expect(received[0]?.usageLog).toBe('/tmp/usage.tsv');
    expect(received[0]?.transcripts).toEqual(['/a.jsonl', '/b']);
  });

  test('without the flags the merge gate gets no spend record', async () => {
    const { runner } = fake({ contains: true });
    const { partial } = seams();
    const received: MergeGateOptions[] = [];
    const merge = async (mergeOptions: MergeGateOptions) => {
      received.push(mergeOptions);
      return mergedReport();
    };
    await deliver(options, { ...partial, merge, runner });
    expect(received[0]).not.toHaveProperty('usageLog');
  });
});

describe('fixes-main', () => {
  const args = (extra: string[]) => [
    '--config',
    options.configPath,
    '--pr',
    '12',
    '--worktree',
    sandbox,
    '--comment-file',
    options.commentFile,
    '--gate-log',
    options.gateLog as string,
    ...extra,
  ];

  test('--fixes-main reaches the merge gate on every attempt', async () => {
    const { runner } = fake({ contains: true });
    const { partial } = seams();
    const received: MergeGateOptions[] = [];
    const merge = async (mergeOptions: MergeGateOptions) => {
      received.push(mergeOptions);
      return mergedReport();
    };
    const result = await run(args(['--fixes-main']), { ...partial, merge, runner });
    expect(result.code).toBe(0);
    expect(received.map((entry) => entry.fixesMain)).toEqual([true]);
  });

  test('without the flag the merge gate is not told this is the fix, so a red main refuses it', async () => {
    const { runner } = fake({ contains: true });
    const { partial } = seams();
    const received: MergeGateOptions[] = [];
    const merge = async (mergeOptions: MergeGateOptions) => {
      received.push(mergeOptions);
      return mergeOptions.fixesMain === true
        ? mergedReport()
        : mergedReport({
            merged: false,
            mergeCommit: null,
            failedStep: 'main-health',
            detail: 'main is red.',
          });
    };
    const result = await run(args([]), { ...partial, merge, runner });
    expect(result.code).toBe(1);
    expect(received[0]?.fixesMain).toBe(false);
    expect(result.output).toContain('main-health');
  });
});

describe('run', () => {
  test('rejects bad usage before touching anything', async () => {
    const base = ['--worktree', sandbox, '--comment-file', join(sandbox, 'comment.md')];
    const usage = async (...argv: string[]) => {
      try {
        await run(argv);
      } catch (error) {
        return error;
      }
      return undefined;
    };
    expect(await usage('--pr', 'x', ...base)).toBeInstanceOf(UsageError);
    expect(await usage('--pr', '1', '--worktree', sandbox)).toBeInstanceOf(UsageError);
    expect(await usage('--pr', '1', ...base, '--issue', 'COR-1')).toBeInstanceOf(UsageError);
    expect(await usage('--pr', '1', ...base, '--remove-worktree')).toBeInstanceOf(UsageError);
    expect(await usage('--pr', '1', ...base, '--name', 'x')).toBeInstanceOf(UsageError);
    expect(await usage('--pr', '1', ...base, '--bogus')).toBeInstanceOf(UsageError);
    expect(await usage('--pr', '1', ...base, '--usage-log', 'u.tsv')).toBeInstanceOf(UsageError);
    expect(await usage('--pr', '1', ...base, '--transcript', 't.jsonl')).toBeInstanceOf(UsageError);
    const removal = ['--remove-worktree'];
    expect(
      await usage('--pr', '1', ...base, ...removal, '--provider', 'nobody', '--name', 'a'),
    ).toBeInstanceOf(UsageError);
    expect(
      await usage('--pr', '1', ...base, ...removal, '--provider', 'claude', '--name', '../x'),
    ).toBeInstanceOf(UsageError);
  });

  test('exits 0 with one JSON object for a merge and 1 naming the failed step otherwise', async () => {
    const argv = [
      '--config',
      options.configPath,
      '--pr',
      '12',
      '--worktree',
      sandbox,
      '--comment-file',
      options.commentFile,
      '--gate-log',
      options.gateLog as string,
      '--json',
    ];
    const { runner } = fake({ contains: true });
    const passing = seams();
    const ok = await run(argv, { ...passing.partial, runner });
    expect(ok.code).toBe(0);
    expect(JSON.parse(ok.output)).toMatchObject({ pr: 12, merged: true, failedStep: null });
    const failing = seams({
      merge: mergedReport({ merged: false, mergeCommit: null, failedStep: 'merge', detail: 'no' }),
    });
    const bad = await run(argv, { ...failing.partial, runner });
    expect(bad.code).toBe(1);
    expect(JSON.parse(bad.output).failedStep).toBe('merge');
  });
});
