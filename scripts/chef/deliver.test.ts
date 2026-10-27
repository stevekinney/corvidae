import { afterEach, beforeEach, describe, expect, test } from 'bun:test';
import { existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { deliver, renderDeliver, run, type DeliverOptions } from './deliver.ts';
import type { ControlOptions, ControlResult, ControlRow } from './gate-run.ts';
import { LinearError, type LinearClient } from './linear.ts';
import type { MergeGateOptions, MergeGateReport } from './merge-gate.ts';
import { UsageError, type Runner } from './process-runner.ts';
import { ReviewThreadsError, type ThreadListing } from './review-threads.ts';
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

/** Rewrite the configuration with extra fields, such as a `fastCheckCommand`. */
function configure(extra: Record<string, unknown>): void {
  writeFileSync(
    options.configPath,
    JSON.stringify({
      repository: 'acme/widgets',
      defaultBranch: 'main',
      worktreeRoots: { claude: '/c', codex: '/x' },
      manifestName: 'widgets',
      installCommand: 'install-command',
      gateCommand: 'true',
      affectedCheckCommand: 'true',
      mergeMethod: 'squash',
      ...extra,
    }),
  );
}

/** Give the sandbox the workspaces a fast check can name. */
function makeWorkspaces(...directories: string[]): void {
  for (const directory of directories) {
    mkdirSync(join(sandbox, directory), { recursive: true });
    writeFileSync(
      join(sandbox, directory, 'package.json'),
      JSON.stringify({ name: `@acme/${directory.split('/')[1]}`, scripts: {} }),
    );
  }
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
  /** Exit code and output of the configured fast check (`fast-check ...`). */
  fastCheckCode?: number;
  fastCheckOutput?: string;
}

function fake(world: World = {}) {
  const calls: string[][] = [];
  let head = HEAD;
  let fetchCall = 0;
  const runner: Runner = (command) => {
    calls.push(command);
    const [program, ...rest] = command;
    if (program === 'sh' && String(command[2]).startsWith('fast-check'))
      return {
        code: world.fastCheckCode ?? 0,
        stdout: '',
        stderr: world.fastCheckOutput ?? '',
      };
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
    threads?: ThreadListing | Error;
    /** What the gate writes into its log, such as a failing test's lines. */
    gateLogText?: string;
    control?: (options: ControlOptions) => ControlResult;
  } = {},
) {
  const record = {
    threadReads: 0,
    controls: [] as ControlOptions[],
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
        writeFileSync(gateOptions.log, overrides.gateLogText ?? '');
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
      threads: () => {
        record.threadReads += 1;
        const listing = overrides.threads ?? { threads: [], seen: 1, total: 1, unresolved: 0 };
        if (listing instanceof Error) throw listing;
        return listing;
      },
      control: (controlOptions: ControlOptions) => {
        record.controls.push(controlOptions);
        if (overrides.control === undefined) throw new Error('no control run was expected');
        return overrides.control(controlOptions);
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

  test('--waive-load-flake and --control-head reach the merge gate as a waiver, not a fix', async () => {
    const { runner } = fake({ contains: true });
    const { partial } = seams();
    const received: MergeGateOptions[] = [];
    const merge = async (mergeOptions: MergeGateOptions) => {
      received.push(mergeOptions);
      return mergedReport();
    };
    const controlHead = 'f'.repeat(40);
    const result = await run(
      args(['--waive-load-flake', 'passes alone on main', '--control-head', controlHead]),
      { ...partial, merge, runner },
    );
    expect(result.code).toBe(0);
    expect(received.map((entry) => [entry.fixesMain, entry.loadFlakeWaiver])).toEqual([
      [false, { reason: 'passes alone on main', controlHead }],
    ]);
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
    const waiver = ['--waive-load-flake', 'passes alone on main', '--control-head', 'f'.repeat(40)];
    expect(await usage('--pr', '1', ...base, '--fixes-main', ...waiver)).toBeInstanceOf(UsageError);
    expect(await usage('--pr', '1', ...base, ...waiver.slice(0, 2))).toBeInstanceOf(UsageError);
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

describe('review threads before the gate', () => {
  const unresolved: ThreadListing = { threads: [], seen: 2, total: 2, unresolved: 1 };

  test('an unresolved thread stops delivery before anything is fetched, merged, pushed or gated', async () => {
    const { runner, calls } = fake({ contains: false, mergeTreeCode: 0 });
    const { partial, record } = seams({ threads: unresolved });
    const report = await deliver(options, { ...partial, runner });
    expect(report).toMatchObject({ merged: false, failedStep: 'threads', attempts: 1 });
    expect(report.detail).toContain('1 review thread(s) are unresolved');
    expect(calls).toEqual([]);
    expect(record.gates).toEqual([]);
    expect(record.merges).toEqual([]);
  });

  test('a listing that is not complete, or cannot be read, also stops at step threads', async () => {
    const { runner } = fake({ contains: true });
    const partial = await deliver(options, {
      ...seams({ threads: { threads: [], seen: 50, total: 61, unresolved: 0 } }).partial,
      runner,
    });
    expect(partial).toMatchObject({ failedStep: 'threads' });
    expect(partial.detail).toContain('read 50 of 61');
    const broken = await deliver(options, {
      ...seams({ threads: new ReviewThreadsError('gh could not list review threads') }).partial,
      runner,
    });
    expect(broken).toMatchObject({ failedStep: 'threads' });
    expect(broken.detail).toContain('gh could not list');
  });

  test('resolved threads let the lifecycle through, and the merge gate still checks them itself', async () => {
    const { runner } = fake({ contains: true });
    const { partial, record } = seams();
    const received: MergeGateOptions[] = [];
    const report = await deliver(options, {
      ...partial,
      runner,
      merge: async (mergeOptions: MergeGateOptions) => {
        received.push(mergeOptions);
        return mergedReport();
      },
    });
    expect(report.failedStep).toBeNull();
    expect(record.threadReads).toBe(1);
    expect(received).toHaveLength(1);
  });

  test('no thread reader is a named failure, never a silent skip', async () => {
    const { runner } = fake({ contains: true });
    const { threads: _omitted, ...rest } = seams().partial;
    const report = await deliver(options, { ...rest, runner });
    expect(report).toMatchObject({ failedStep: 'threads' });
  });
});

describe('integration check after merging the default branch in', () => {
  const moved = {
    contains: false,
    mergeTreeCode: 0,
    pullRequestFiles: ['packages/a/own.ts', 'packages/b/own.ts'],
    baseFiles: ['packages/a/landed.ts', 'packages/c/landed.ts'],
  };

  beforeEach(() => {
    configure({ fastCheckCommand: 'fast-check {filters}' });
    makeWorkspaces('packages/a', 'packages/b', 'packages/c');
  });

  test('typechecks and lints only the workspaces both sides touched, after install and before push', async () => {
    const { runner, calls } = fake(moved);
    const { partial, record } = seams();
    const report = await deliver(options, { ...partial, runner });
    expect(report.failedStep).toBeNull();
    const text = calls.map((command) => command.join(' '));
    const install = text.indexOf('sh -c install-command');
    const check = text.indexOf('sh -c fast-check --filter=./packages/a');
    const push = text.indexOf('git push origin HEAD');
    expect(install).toBeGreaterThan(-1);
    expect(check).toBeGreaterThan(install);
    expect(push).toBeGreaterThan(check);
    expect(text.filter((line) => line.startsWith('sh -c fast-check'))).toHaveLength(1);
    expect(record.gates).toHaveLength(1);
  });

  test('a failure is step integration: it names the failing files, restores the branch, and stops', async () => {
    const { runner, calls } = fake({
      ...moved,
      fastCheckCode: 1,
      fastCheckOutput: [
        '@acme/a:typecheck: src/own.ts(4,2): error TS2339: Property old does not exist.',
        '@acme/a:lint: scripts/x.ts:3:1 Error',
      ].join('\n'),
    });
    const { partial, record } = seams();
    const report = await deliver(
      { ...options, logDirectory: join(sandbox, 'logs') },
      { ...partial, runner },
    );
    expect(report).toMatchObject({ merged: false, failedStep: 'integration' });
    expect(report.detail).toContain('packages/a/src/own.ts');
    expect(report.detail).toContain('scripts/x.ts');
    expect(report.detail).toContain(join(sandbox, 'logs'));
    expect(report.detail).toContain('restored');
    expect(calls).toContainEqual(['git', 'reset', '--hard', HEAD]);
    expect(calls.some((command) => command[1] === 'push')).toBe(false);
    expect(record.gates).toEqual([]);
    expect(record.merges).toEqual([]);
  });

  test('runs nothing when the two sides share no workspace, or when nothing was merged in', async () => {
    const apart = fake({ ...moved, baseFiles: ['packages/c/landed.ts'] });
    const first = await deliver(options, { ...seams().partial, runner: apart.runner });
    expect(first.failedStep).toBeNull();
    expect(apart.calls.some((command) => String(command[2]).startsWith('fast-check'))).toBe(false);
    const fresh = fake({ contains: true });
    const second = await deliver(options, { ...seams().partial, runner: fresh.runner });
    expect(second.failedStep).toBeNull();
    expect(fresh.calls.some((command) => String(command[2]).startsWith('fast-check'))).toBe(false);
  });

  test('--removed-names fails on a file that landed on main still using a removed name', async () => {
    writeFileSync(
      join(sandbox, 'packages', 'a', 'landed.ts'),
      'const f = engine as never;\nf.legacyMode;\n',
    );
    const { runner, calls } = fake(moved);
    const { partial, record } = seams();
    const report = await deliver(
      { ...options, removedNames: ['legacyMode'] },
      { ...partial, runner },
    );
    expect(report).toMatchObject({ merged: false, failedStep: 'integration' });
    expect(report.detail).toContain('packages/a/landed.ts:2 (legacyMode)');
    expect(calls).toContainEqual(['git', 'reset', '--hard', HEAD]);
    expect(record.gates).toEqual([]);
  });

  test('--removed-names passes when the files that landed do not use the name', async () => {
    writeFileSync(join(sandbox, 'packages', 'a', 'landed.ts'), 'f.current;\n');
    const { runner } = fake(moved);
    const report = await deliver(
      { ...options, removedNames: ['legacyMode'] },
      { ...seams().partial, runner },
    );
    expect(report.failedStep).toBeNull();
  });

  test('--removed-names works without a fast check command', async () => {
    configure({});
    writeFileSync(join(sandbox, 'packages', 'c', 'landed.ts'), "const k = 'legacyMode';\n");
    const { runner } = fake(moved);
    const report = await deliver(
      { ...options, removedNames: ['legacyMode'] },
      { ...seams().partial, runner },
    );
    expect(report).toMatchObject({ failedStep: 'integration' });
    expect(report.detail).toContain('packages/c/landed.ts:1');
  });

  test('the --removed-names file is read at the command line, and a missing one is a usage error', async () => {
    const argv = (...extra: string[]) => [
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
    let thrown: unknown;
    try {
      await run(argv('--removed-names', join(sandbox, 'missing.txt')));
    } catch (error) {
      thrown = error;
    }
    expect(thrown).toBeInstanceOf(UsageError);
    writeFileSync(join(sandbox, 'names.txt'), 'legacyMode\nbad name\n');
    try {
      await run(argv('--removed-names', join(sandbox, 'names.txt')));
    } catch (error) {
      thrown = error;
    }
    expect(String(thrown)).toContain('not a single identifier');
  });
});

describe('a failed gate is classified, never retried', () => {
  const failingLog = [
    'HEAD x LOAD 1',
    '@acme/a:test: src/x.test.ts:',
    '@acme/a:test: (fail) x > works [2ms]',
    ' Failed:    @acme/a#test',
    'GATE_RC=1',
    '',
  ].join('\n');
  const expectedTests = ['x > works'];
  const rows = (candidate: number, base: number): ControlResult => {
    const row = (tree: 'candidate' | 'base', exitCode: number): ControlRow => ({
      iteration: 1,
      tree,
      load: 1,
      exitCode,
      failingTests: exitCode === 0 ? [] : expectedTests,
    });
    return {
      rows: [row('candidate', candidate), row('base', base)],
      iterations: 1,
      candidateFailures: candidate === 0 ? 0 : 1,
      baseFailures: base === 0 ? 0 : 1,
      shared: false,
    };
  };
  const args = (...extra: string[]) => [
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

  beforeEach(() => {
    makeWorkspaces('packages/a');
    mkdirSync(join(sandbox, 'packages', 'a', 'src'), { recursive: true });
    writeFileSync(join(sandbox, 'packages', 'a', 'src', 'x.test.ts'), '');
    // A log that does not pass forces the gate to run.
    writeFileSync(options.gateLog as string, 'HEAD x LOAD 1\nGATE_RC=1\n');
  });

  async function failed(candidate: number, base: number) {
    const { runner, calls } = fake({ contains: true });
    const { partial, record } = seams({
      gateCode: 1,
      gateLogText: failingLog,
      control: () => rows(candidate, base),
    });
    const result = await run(args('--json'), { ...partial, runner });
    return { result, record, calls, report: JSON.parse(result.output) };
  }

  test('a file that fails on the head and passes on main is the branch: exit 1', async () => {
    const { result, report, record } = await failed(1, 0);
    expect(result.code).toBe(1);
    expect(report).toMatchObject({ failedStep: 'gate', classification: 'branch' });
    expect(report.controlFiles).toMatchObject([{ file: 'src/x.test.ts', verdict: 'branch' }]);
    expect(record.gates).toHaveLength(1);
    expect(record.merges).toEqual([]);
  });

  test('a file that fails on main too is main: exit 3', async () => {
    const { result, report } = await failed(1, 1);
    expect(result.code).toBe(3);
    expect(report.classification).toBe('main');
  });

  test('a file that passes alone on both is unreproduced: exit 4', async () => {
    const { result, report, record } = await failed(0, 0);
    expect(result.code).toBe(4);
    expect(report.classification).toBe('unreproduced');
    // Never an automatic retry of the gate.
    expect(record.gates).toHaveLength(1);
    expect(record.controls).toHaveLength(1);
    expect(record.controls[0]?.iterations).toBe(2);
  });

  test('the text output names the class, the files and the triage', async () => {
    const { runner } = fake({ contains: true });
    const { partial } = seams({
      gateCode: 1,
      gateLogText: failingLog,
      control: () => rows(0, 0),
    });
    const result = await run(args(), { ...partial, runner });
    expect(result.output).toContain('FAILED at gate');
    expect(result.output).toContain('classification: unreproduced');
    expect(result.output).toContain('src/x.test.ts (@acme/a): unreproduced');
    expect(result.output).toContain('@acme/a#test');
  });

  test('a gate failure with no failing test file keeps exit 1 and runs no control', async () => {
    const { runner } = fake({ contains: true });
    const { partial, record } = seams({ gateCode: 1, gateLogText: ' Failed:    @acme/a#lint\n' });
    const result = await run(args('--json'), { ...partial, runner });
    expect(result.code).toBe(1);
    expect(JSON.parse(result.output).classification).toBe('unclassified');
    expect(record.controls).toEqual([]);
  });

  test('other failed steps keep exit 1 and carry no classification', async () => {
    const { runner } = fake({ contains: false, mergeTreeCode: 1, mergeCode: 1 });
    const { partial } = seams();
    const result = await run(args('--json'), { ...partial, runner });
    expect(result.code).toBe(1);
    expect(JSON.parse(result.output)).toMatchObject({
      failedStep: 'conflict',
      classification: null,
    });
  });
});

describe('waive-main-health', () => {
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

  test('--waive-main-health --reason reaches the merge gate as a waiver, not a fix', async () => {
    const { runner } = fake({ contains: true });
    const { partial } = seams();
    const received: MergeGateOptions[] = [];
    const merge = async (mergeOptions: MergeGateOptions) => {
      received.push(mergeOptions);
      return mergedReport();
    };
    const result = await run(args(['--waive-main-health', '--reason', 'main is red from #99']), {
      ...partial,
      merge,
      runner,
    });
    expect(result.code).toBe(0);
    expect(received.map((entry) => [entry.fixesMain, entry.mainHealthWaiver])).toEqual([
      [false, { reason: 'main is red from #99' }],
    ]);
  });

  test('rejects a missing reason, a bare reason, and a second kind of waiver', async () => {
    const usage = async (...argv: string[]) => {
      try {
        await run(args(argv), { ...seams().partial, runner: fake({ contains: true }).runner });
      } catch (error) {
        return error;
      }
      return undefined;
    };
    expect(await usage('--waive-main-health')).toBeInstanceOf(UsageError);
    expect(await usage('--reason', 'x')).toBeInstanceOf(UsageError);
    expect(await usage('--waive-main-health', '--reason', 'x', '--fixes-main')).toBeInstanceOf(
      UsageError,
    );
  });
});
