import { afterEach, beforeEach, describe, expect, test } from 'bun:test';
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { spawnWithHangGuard } from '../hang-guard.ts';
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

/** A fresh worktree directory holding the configuration, gate log and comment the gate reads. */
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
  writeFileSync(join(directory, 'gate.log'), gateLog());
  writeFileSync(join(directory, 'comment.md'), 'Gate passed at the head.\n');
  return {
    directory,
    prepared: {
      configPath,
      pr: 12,
      worktree: directory,
      gateLog: join(directory, 'gate.log'),
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
  /** The stderr of a failed fetch; a generic network error unless a test says otherwise. */
  fetchStderr?: string;
  /** `git merge-tree --write-tree` exit code; 1 (a conflict) unless a test says otherwise. */
  mergeTreeCode?: number;
  /** Files changed from the merge base to HEAD, and from the merge base to origin/main. */
  pullRequestFiles?: string[];
  baseFiles?: string[];
  /** The tree of the squash commit; the clean-merge tree unless a test overrides it. */
  mergedTree?: string;
  /** Files at origin/main by path, as `git show` and `git ls-tree` read them. */
  baseTree?: Record<string, string>;
  /** Files at the gated commit; when unset the sandbox files stand for them. */
  headTree?: Record<string, string>;
  /** `ancestors` is per call; this one makes the refetch's base differ from the first. */
  baseShas?: string[];
}

const MERGE_TREE = '9'.repeat(40);
const MERGE_BASE = '8'.repeat(40);

function fake(world: World = {}) {
  const calls: string[][] = [];
  const comments: string[] = [];
  let ancestorCall = 0;
  let fetchCall = 0;
  let baseCall = 0;
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
      if (rest[0] === 'rev-parse' && rest[1]?.endsWith('^{tree}'))
        return { code: 0, stdout: `${world.mergedTree ?? MERGE_TREE}\n`, stderr: '' };
      if (rest[0] === 'show') {
        const [ref = '', path = ''] = (rest[1] ?? '').split(':');
        const content =
          ref === 'HEAD'
            ? world.headTree === undefined
              ? existsSync(join(sandbox, path))
                ? readFileSync(join(sandbox, path), 'utf8')
                : undefined
              : world.headTree[path]
            : world.baseTree?.[path];
        return content === undefined
          ? { code: 128, stdout: '', stderr: 'fatal: path does not exist' }
          : { code: 0, stdout: content, stderr: '' };
      }
      if (rest[0] === 'ls-tree') {
        const prefix = rest[3] ?? '';
        const onDisk =
          rest[2] === 'HEAD' && world.headTree === undefined
            ? existsSync(join(sandbox, prefix))
              ? readdirSync(join(sandbox, prefix)).map((name) => `${prefix}${name}/x`)
              : []
            : [];
        const names = [
          ...Object.keys((rest[2] === 'HEAD' ? world.headTree : world.baseTree) ?? {}),
          ...onDisk,
        ]
          .filter((path) => path.startsWith(prefix))
          .map((path) => path.slice(0, path.indexOf('/', prefix.length)))
          .filter((path, index, all) => path !== '' && all.indexOf(path) === index);
        return { code: 0, stdout: `${names.join('\n')}\n`, stderr: '' };
      }
      if (rest[0] === 'merge-tree')
        return {
          code: world.mergeTreeCode ?? 1,
          stdout: `${MERGE_TREE}\n`,
          stderr: '',
        };
      if (rest[0] === 'rev-parse')
        return rest[1] === 'HEAD'
          ? { code: 0, stdout: `${world.head ?? HEAD}\n`, stderr: '' }
          : {
              code: 0,
              stdout: `${world.baseShas?.[Math.min(baseCall++, world.baseShas.length - 1)] ?? BASE}\n`,
              stderr: '',
            };
      if (rest[0] === 'merge-base' && rest[1] !== '--is-ancestor')
        return { code: 0, stdout: `${MERGE_BASE}\n`, stderr: '' };
      if (rest[0] === 'diff' && rest[1] === '--name-only') {
        const files = rest[4] === 'HEAD' ? world.pullRequestFiles : world.baseFiles;
        return { code: 0, stdout: `${(files ?? []).join('\n')}\n`, stderr: '' };
      }
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
    if (program === 'gh' && rest[0] === 'pr' && rest[1] === 'comment') {
      comments.push(readFileSync(rest[rest.indexOf('--body-file') + 1] as string, 'utf8'));
    }
    if (program === 'gh' && rest[0] === 'pr' && rest[1] === 'comment')
      return { code: world.commentCode ?? 0, stdout: '', stderr: 'comment failed' };
    if (program === 'gh' && rest[0] === 'pr' && rest[1] === 'merge')
      return { code: world.mergeCode ?? 0, stdout: '', stderr: 'not mergeable' };
    throw new Error(`unexpected command ${command.join(' ')}`);
  };
  const posted = () => calls.some((call) => call[0] === 'gh' && call[2] === 'comment');
  const merged = () => calls.some((call) => call[0] === 'gh' && call[2] === 'merge');
  return { runner, calls, comments, posted, merged };
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
      basePath: 'contains',
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
      'git fetch',
      'git merge-base',
      'git rev-parse',
      'gh pr comment',
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
      expect.stringContaining('comment.md'),
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

  test('the base moving after the first check stops before the comment and the merge', () => {
    const world = fake({ ancestors: [true, false] });
    const report = mergeGate(options, { runner: world.runner });
    expect(report.failedStep).toBe('refetch');
    expect(world.posted()).toBe(false);
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

describe('a head that does not contain the base', () => {
  /** Two packages where `b` depends on `a`, an unrelated `c`, and a lockfile, in the worktree. */
  function writeWorkspaces() {
    const manifests: [string, Record<string, unknown>][] = [
      ['packages/a', { name: '@x/a' }],
      ['packages/b', { name: '@x/b', dependencies: { '@x/a': 'workspace:*' } }],
      ['packages/c', { name: '@x/c' }],
    ];
    for (const [directory, manifest] of manifests) {
      mkdirSync(join(sandbox, directory), { recursive: true });
      writeFileSync(join(sandbox, directory, 'package.json'), JSON.stringify(manifest));
    }
    writeFileSync(
      join(sandbox, 'turbo.json'),
      JSON.stringify({
        globalDependencies: ['tsconfig.json'],
        tasks: {
          lint: {
            inputs: ['$TURBO_DEFAULT$', '$TURBO_ROOT$/scripts/check-documentation-coverage.ts'],
          },
          test: { inputs: ['$TURBO_ROOT$/scripts/test-duration-allowlist.json'] },
        },
      }),
    );
  }
  beforeEach(writeWorkspaces);

  const cleanWorld = (world: World = {}): World => ({
    ancestors: [false],
    mergeTreeCode: 0,
    pullRequestFiles: ['packages/a/source.ts'],
    baseFiles: ['packages/c/other.ts'],
    ...world,
  });

  test('accepts a clean merge whose intervening commits touch no affected workspace', () => {
    const world = fake(cleanWorld());
    const report = mergeGate(options, { runner: world.runner });
    expect(report).toMatchObject({
      failedStep: null,
      merged: true,
      basePath: 'merge-tree',
      mergeTree: MERGE_TREE,
      treesMatch: true,
    });
    const merge = world.calls.find((call) => call[2] === 'merge') ?? [];
    expect(merge.slice(-2)).toEqual(['--match-head-commit', HEAD]);
    expect(world.comments[0]).toContain('Base: merges cleanly with origin/main');
    expect(world.comments[0]).toContain('intervening commits touch no affected workspace');
    expect(renderMergeGate(report, false)).toContain('base path: merge-tree');
  });

  test('compares the squash commit with the merge-tree result, not with the head', () => {
    const world = fake(cleanWorld({ mergedTree: 'f'.repeat(40) }));
    const report = mergeGate(options, { runner: world.runner });
    expect(report).toMatchObject({ failedStep: 'confirm', merged: true, treesMatch: false });
    expect(world.calls.some((call) => call[1] === 'diff' && call[2] === '--quiet')).toBe(false);
  });

  test('refuses a clean merge whose base commits touch a workspace the pull request changes', () => {
    const world = fake(cleanWorld({ baseFiles: ['packages/a/other.ts'] }));
    const report = mergeGate(options, { runner: world.runner });
    expect(report.failedStep).toBe('contains-base');
    expect(report.detail).toContain('packages/a/other.ts');
    expect(world.posted() || world.merged()).toBe(false);
  });

  test('refuses when base commits touch a dependent or a dependency of a changed workspace', () => {
    const dependent = fake(cleanWorld({ baseFiles: ['packages/b/index.ts'] }));
    expect(mergeGate(options, { runner: dependent.runner }).detail).toContain(
      'packages/b/index.ts',
    );
    const dependency = fake(
      cleanWorld({ pullRequestFiles: ['packages/b/index.ts'], baseFiles: ['packages/a/x.ts'] }),
    );
    expect(mergeGate(options, { runner: dependency.runner }).failedStep).toBe('contains-base');
  });

  test('refuses a clean merge whose base commits touch bun.lock or another global file', () => {
    for (const path of [
      'bun.lock',
      'package.json',
      'turbo.json',
      'tsconfig.base.json',
      'tsconfig.json',
    ]) {
      const world = fake(cleanWorld({ baseFiles: ['packages/c/other.ts', path] }));
      const report = mergeGate(options, { runner: world.runner });
      expect(report.failedStep, path).toBe('contains-base');
      expect(report.detail, path).toContain(path);
      expect(world.merged(), path).toBe(false);
    }
  });

  test('a pull request that changes bun.lock is affected by every intervening change', () => {
    const world = fake(cleanWorld({ pullRequestFiles: ['bun.lock'] }));
    expect(mergeGate(options, { runner: world.runner }).failedStep).toBe('contains-base');
  });

  test('root files affect a pull request only when it changes root files too', () => {
    const accepted = fake(cleanWorld({ baseFiles: ['scripts/chef/note.ts'] }));
    expect(mergeGate(options, { runner: accepted.runner }).failedStep).toBeNull();
    const refused = fake(
      cleanWorld({
        pullRequestFiles: ['scripts/chef/gate-run.ts'],
        baseFiles: ['scripts/chef/note.ts'],
      }),
    );
    expect(mergeGate(options, { runner: refused.runner }).failedStep).toBe('contains-base');
  });

  test('root files that turbo.json names as task inputs, and bunfig.toml, touch everything', () => {
    for (const path of [
      'scripts/check-documentation-coverage.ts',
      'scripts/test-duration-allowlist.json',
      'bunfig.toml',
    ]) {
      const onMain = fake(cleanWorld({ baseFiles: ['packages/c/other.ts', path] }));
      const forward = mergeGate(options, { runner: onMain.runner });
      expect(forward.failedStep, path).toBe('contains-base');
      expect(forward.detail, path).toContain(path);
      const onPullRequest = fake(
        cleanWorld({ pullRequestFiles: [path], baseFiles: ['packages/c/other.ts'] }),
      );
      expect(mergeGate(options, { runner: onPullRequest.runner }).failedStep, path).toBe(
        'contains-base',
      );
    }
  });

  test('a dependency edge added on the default branch counts', () => {
    const baseTree = {
      'packages/a/package.json': JSON.stringify({ name: '@x/a' }),
      'packages/c/package.json': JSON.stringify({
        name: '@x/c',
        dependencies: { '@x/a': 'workspace:*' },
      }),
    };
    const world = fake(cleanWorld({ baseTree, baseFiles: ['packages/c/other.ts'] }));
    const report = mergeGate(options, { runner: world.runner });
    expect(report.failedStep).toBe('contains-base');
    expect(report.detail).toContain('packages/c/other.ts');
    expect(world.merged()).toBe(false);
  });

  test('the dependencies of a dependent workspace count as affected', () => {
    mkdirSync(join(sandbox, 'packages/d'), { recursive: true });
    writeFileSync(
      join(sandbox, 'packages/b/package.json'),
      JSON.stringify({
        name: '@x/b',
        dependencies: { '@x/a': 'workspace:*', '@x/c': 'workspace:*' },
      }),
    );
    const world = fake(cleanWorld({ baseFiles: ['packages/c/other.ts'] }));
    const report = mergeGate(options, { runner: world.runner });
    expect(report.failedStep).toBe('contains-base');
    expect(report.detail).toContain('packages/c/other.ts');
  });

  test('the head side of the graph comes from the gated commit, not a dirty worktree', () => {
    const committed = {
      'packages/a/package.json': JSON.stringify({ name: '@x/a' }),
      'packages/b/package.json': JSON.stringify({
        name: '@x/b',
        dependencies: { '@x/a': 'workspace:*' },
      }),
      'packages/c/package.json': JSON.stringify({ name: '@x/c' }),
    };
    // The worktree drops b's dependency on a; the commit still has it, so a change to b refuses.
    writeFileSync(join(sandbox, 'packages/b/package.json'), JSON.stringify({ name: '@x/b' }));
    const world = fake(
      cleanWorld({
        headTree: committed,
        pullRequestFiles: ['packages/a/source.ts'],
        baseFiles: ['packages/b/other.ts'],
      }),
    );
    expect(mergeGate(options, { runner: world.runner }).failedStep).toBe('contains-base');
    // And a dependency the worktree invents does not make an unrelated change refuse.
    writeFileSync(
      join(sandbox, 'packages/c/package.json'),
      JSON.stringify({ name: '@x/c', dependencies: { '@x/a': 'workspace:*' } }),
    );
    const unrelated = fake(cleanWorld({ headTree: committed, baseFiles: ['packages/c/other.ts'] }));
    expect(mergeGate(options, { runner: unrelated.runner }).failedStep).toBeNull();
  });

  test('the posted Base line names the final base check after the refetch', () => {
    const FINAL = 'e'.repeat(40);
    const world = fake(cleanWorld({ ancestors: [true, false], baseShas: [BASE, FINAL] }));
    const report = mergeGate(options, { runner: world.runner });
    expect(report).toMatchObject({ failedStep: null, basePath: 'merge-tree' });
    expect(world.comments[0]).toContain('Base: merges cleanly with origin/main eeeeeeeeeeee');
    expect(world.comments[0]).not.toContain('contains origin/main');
  });

  test('refuses a conflicting merge, naming the failed condition', () => {
    const world = fake(cleanWorld({ mergeTreeCode: 1 }));
    const report = mergeGate(options, { runner: world.runner });
    expect(report.failedStep).toBe('contains-base');
    expect(report.detail).toContain('does not merge cleanly');
    expect(world.posted() || world.merged()).toBe(false);
  });

  test('rechecks the fallback after the comment, so a base that moved onto the pull request stops it', () => {
    const world = cleanWorld();
    const inner = fake(world);
    let diffCalls = 0;
    const runner: Runner = (command, runnerOptions) => {
      if (command[1] === 'diff' && command[2] === '--name-only' && command[5] !== 'HEAD') {
        diffCalls += 1;
        if (diffCalls > 1) return { code: 0, stdout: 'packages/a/new.ts\n', stderr: '' };
      }
      return inner.runner(command, runnerOptions);
    };
    const report = mergeGate(options, { runner });
    expect(report.failedStep).toBe('refetch');
    expect(inner.merged()).toBe(false);
  });

  test('a head that contains the base still passes with the contains path', () => {
    const report = mergeGate(options, { runner: fake({ ancestors: [true] }).runner });
    expect(report).toMatchObject({ failedStep: null, basePath: 'contains' });
    expect(report.mergeTree).toBeUndefined();
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
