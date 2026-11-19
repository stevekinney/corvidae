import { describe as bunDescribe, test as bunTest, expect } from 'bun:test';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { spawnWithHangGuard } from '../../testing/testing/src/hang-guard.ts';
import { throwingRejectionOf } from '../../testing/testing/src/helpers/promise-outcome.ts';
import { waitUntil } from '../../testing/testing/src/wait-until.ts';
import { processStartTime } from '../run-exclusively.ts';
import { createDeliveryVerificationFixture } from './delivery-verification.test-support.ts';
import {
  loadDeliveryVerification,
  type DeliveryVerificationDependencies,
} from './delivery-verification.ts';
import {
  acquireDispatch,
  cancelDispatch,
  readExecutionSnapshot,
  requireAuthority,
} from './execution-state.ts';
import {
  mergeGate as mergeGateImplementation,
  renderMergeGate,
  run as runImplementation,
  withMergeLock,
  type MergeGateDependencies,
  type MergeGateOptions,
} from './merge-gate.ts';
import { UsageError, type Runner } from './process-runner.ts';
import { greenLanding } from './landing-evidence.test-support.ts';
import { createScenarios } from './scenario.test-support.ts';

let HEAD = 'a'.repeat(40);
const OTHER = 'b'.repeat(40);
let BASE = 'c'.repeat(40);
const MERGE = 'd'.repeat(40);
let EXPECTED_TREE = '9'.repeat(40);

let sandbox: string;
let options: MergeGateOptions;
let verification: DeliveryVerificationDependencies;

async function mergeGate(input: MergeGateOptions, partial: Partial<MergeGateDependencies> = {}) {
  const activeVerification = partial.verification ?? verification;
  const loaded = loadDeliveryVerification(input.verification, activeVerification);
  const operation = readExecutionSnapshot(loaded.state).operations[loaded.request.operationId];
  // Most historical scenarios make an independent delivery after asserting a prior failure. Give
  // those calls a new durable operation; dedicated recovery scenarios invoke the implementation.
  if (operation?.outcome !== 'intent') {
    const fresh = await createDeliveryVerificationFixture(
      {
        directory: input.worktree,
        revision: loaded.request.revision,
        base: loaded.request.base,
        integrationTree: loaded.request.integrationTree,
        relevantInputs: loaded.request.members.flatMap((member) =>
          member.plan.obligations.flatMap((item) => item.relevantInputs),
        ),
        outputDirectory: mkdtempSync(join(tmpdir(), 'independent-merge-control-')),
      },
      { route: 'pull-request', landing: true },
    );
    return mergeGateImplementation(
      { ...input, worktree: fresh.directory, verification: fresh.verification },
      { ...partial, verification: fresh.dependencies },
    );
  }
  return mergeGateImplementation(input, {
    ...partial,
    verification: partial.verification ?? verification,
  });
}

async function run(argv: string[], partial: Partial<MergeGateDependencies> = {}) {
  const loaded = loadDeliveryVerification(
    options.verification,
    partial.verification ?? verification,
  );
  if (
    readExecutionSnapshot(loaded.state).operations[loaded.request.operationId]?.outcome !== 'intent'
  ) {
    const fresh = await createDeliveryVerificationFixture(
      {
        directory: options.worktree,
        revision: loaded.request.revision,
        base: loaded.request.base,
        integrationTree: loaded.request.integrationTree,
        relevantInputs: loaded.request.members.flatMap((member) =>
          member.plan.obligations.flatMap((item) => item.relevantInputs),
        ),
        outputDirectory: mkdtempSync(join(tmpdir(), 'independent-merge-control-')),
      },
      { route: 'pull-request', landing: true },
    );
    const replaced = [...argv];
    replaced[replaced.indexOf('--worktree') + 1] = fresh.directory;
    replaced[replaced.indexOf('--verification-file') + 1] = fresh.verification.file;
    replaced[replaced.indexOf('--verification-digest') + 1] = fresh.verification.digest;
    return runImplementation(replaced, { ...partial, verification: fresh.dependencies });
  }
  return runImplementation(argv, {
    ...partial,
    verification: partial.verification ?? verification,
  });
}

/** A fresh worktree directory holding the configuration and comment the gate reads. */
function prepare(): { directory: string; prepared: Omit<MergeGateOptions, 'verification'> } {
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

async function setUp(): Promise<void> {
  const made = prepare();
  sandbox = made.directory;
  const fixture = await createDeliveryVerificationFixture(undefined, { route: 'pull-request', landing: true });
  HEAD = fixture.request.revision;
  BASE = fixture.request.base;
  EXPECTED_TREE = fixture.request.integrationTree;
  verification = fixture.dependencies;
  options = { ...made.prepared, worktree: fixture.directory, verification: fixture.verification };
}

function tearDown(): void {
  rmSync(sandbox, { recursive: true, force: true });
}

const scenarios = createScenarios({ setUp, tearDown }, { test: bunTest, describe: bunDescribe });

interface World {
  head?: string;
  base?: string;
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
  confirmedExpectedTree?: string;
  /** The tree of the squash commit; the expected tree unless a test overrides it. */
  mergedTree?: string;
}

function fake(world: World = {}) {
  const identity = {
    head: HEAD,
    base: world.base ?? BASE,
    tree: world.expectedTree ?? EXPECTED_TREE,
    directory: sandbox,
  };
  const calls: string[][] = [];
  const comments: string[] = [];
  let fetchCall = 0;
  let viewCall = 0;
  let mergeTreeCall = 0;
  const nodes = world.threadNodes ?? [{ id: 'T1', isResolved: true }];
  const runner: Runner = greenLanding((command) => {
    calls.push(command);
    const [program, ...rest] = command;
    if (program === 'git') {
      if (rest[0] === 'rev-parse' && rest.includes('--git-common-dir'))
        return { code: 0, stdout: join(identity.directory, '.git'), stderr: '' };
      if (rest[0] === 'fetch') {
        const code = world.fetchCodes?.[Math.min(fetchCall, world.fetchCodes.length - 1)] ?? 0;
        fetchCall += 1;
        return {
          code,
          stdout: '',
          stderr: code === 0 ? '' : (world.fetchStderr ?? 'fatal: unable to access'),
        };
      }
      if (rest[0] === 'merge-tree') {
        const confirm = mergeTreeCall++ > 0;
        return {
          code: confirm ? (world.mergeTreeCode ?? 0) : 0,
          stdout: `${confirm ? (world.confirmedExpectedTree ?? identity.tree) : identity.tree}\n`,
          stderr: !confirm || world.mergeTreeCode === undefined ? '' : 'CONFLICT',
        };
      }
      if (rest[0] === 'rev-parse' && rest[1]?.endsWith('^{tree}'))
        return {
          code: 0,
          stdout: `${world.mergedTree ?? identity.tree}\n`,
          stderr: '',
        };
      if (rest[0] === 'rev-parse')
        return {
          code: 0,
          stdout: `${rest[1] === 'HEAD' ? (world.head ?? identity.head) : identity.base}\n`,
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
          headRefOid: world.pullRequestHead ?? identity.head,
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
    // main's health: green unless a test overrides it
    if (program === 'gh' && rest[0] === 'run' && rest[1] === 'list')
      return { code: 0, stdout: '[{"conclusion":"success"}]', stderr: '' };
    throw new Error(`unexpected command ${command.join(' ')}`);
  });
  const posted = () => calls.some((call) => call[0] === 'gh' && call[2] === 'comment');
  const merged = () => calls.some((call) => call[0] === 'gh' && call[2] === 'merge');
  /** Anything that is not git or gh would be a test gate, an install or a build. */
  const ranGate = () => calls.some((call) => call[0] !== 'git' && call[0] !== 'gh');
  return { runner, calls, comments, posted, merged, ranGate };
}

scenarios.describe('mergeGate', () => {
  scenarios.describe('main health', () => {
    const redHead = 'e'.repeat(40);
    /** `fake`, plus a fake `gh run list` source answering with `answer`. */
    function withRuns(answer: { code?: number; stdout?: string; stderr?: string }) {
      const world = fake();
      const inner = world.runner;
      const asked: string[][] = [];
      const runner: Runner = (command, runnerOptions) => {
        if (command[1]?.endsWith('ci-compare.ts'))
          return {
            code: 1,
            stdout: JSON.stringify({ run: '1', hasNew: true, recurrence: 'COR-2504' }),
            stderr: '',
          };
        if (command[0] === 'gh' && command[1] === 'run') {
          asked.push(command);
          return {
            code: answer.code ?? 0,
            stdout: answer.stdout ?? '',
            stderr: answer.stderr ?? '',
          };
        }
        return inner(command, runnerOptions);
      };
      return { ...world, runner, asked };
    }
    const latest = (conclusion: string) =>
      JSON.stringify([
        {
          databaseId: 1,
          conclusion,
          headSha: redHead,
          url: 'https://github.example/run/1',
          createdAt: 't',
        },
      ]);

    scenarios.scenario(
      'reads the latest completed main.yml run on the default branch',
      async () => {
        const { runner, asked } = withRuns({ stdout: latest('success') });
        await mergeGate({ ...options, checkMainHealth: true }, { runner });
        expect(asked).toEqual([
          [
            'gh',
            'run',
            'list',
            '--repo',
            'acme/widgets',
            '--workflow',
            'main.yml',
            '--branch',
            'main',
            '--status',
            'completed',
            '--limit',
            '10',
            '--json',
            'databaseId,conclusion,headSha,url,createdAt',
          ],
        ]);
      },
    );

    scenarios.scenario('a red main is a warning in the report, never a refusal', async () => {
      const { runner, merged, posted } = withRuns({ stdout: latest('failure') });
      const report = await mergeGate({ ...options, checkMainHealth: true }, { runner });
      expect(report.failedStep).toBeNull();
      expect(report.merged).toBe(true);
      expect(report.mainHealthWarning).toContain('RED');
      expect(report.mainHealthWarning).toContain('https://github.example/run/1');
      expect(report.fixesMain).toBeUndefined();
      expect(merged() && posted()).toBe(true);
      expect(renderMergeGate(report, false)).toContain('WARNING main health:');
    });

    scenarios.scenario('marks the pull request as the declared fix', async () => {
      const { runner } = withRuns({ stdout: latest('failure') });
      const report = await mergeGate(
        { ...options, checkMainHealth: true, fixesMain: true },
        { runner },
      );
      expect(report.failedStep).toBeNull();
      expect(report.fixesMain).toBe(true);
    });

    scenarios.scenario('a green main carries no warning and marks no fix', async () => {
      const { runner } = withRuns({ stdout: latest('success') });
      const report = await mergeGate(
        { ...options, checkMainHealth: true, fixesMain: true },
        { runner },
      );
      expect(report.failedStep).toBeNull();
      expect(report.mainHealthWarning).toBeUndefined();
      expect(report.fixesMain).toBeUndefined();
    });

    scenarios.scenario(
      'GitHub unreachable reports main health unknown and the merge proceeds',
      async () => {
        const { runner, merged } = withRuns({ code: 1, stderr: 'could not resolve host\n' });
        const report = await mergeGate({ ...options, checkMainHealth: true }, { runner });
        expect(report.failedStep).toBeNull();
        expect(report.merged).toBe(true);
        expect(merged()).toBe(true);
        expect(report.mainHealthWarning).toContain('main health unknown');
      },
    );

    scenarios.scenario('no completed run yet is unknown, not red', async () => {
      const { runner } = withRuns({ stdout: '[]' });
      const report = await mergeGate({ ...options, checkMainHealth: true }, { runner });
      expect(report.failedStep).toBeNull();
      expect(report.mainHealthWarning).toContain('main health unknown');
    });

    scenarios.scenario('a cancelled latest run is skipped: the run before it decides', async () => {
      const earlier = JSON.parse(latest('failure')) as unknown[];
      const stdout = JSON.stringify([{ conclusion: 'cancelled' }, ...earlier]);
      const { runner } = withRuns({ stdout });
      const report = await mergeGate({ ...options, checkMainHealth: true }, { runner });
      expect(report.mainHealthWarning).toContain('RED');
    });
  });

  scenarios.scenario(
    'runs the steps in order and reports the merged, tree-equal result',
    async () => {
      const { runner, calls, ranGate } = fake();
      const report = await mergeGate(options, { runner });
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
        'git rev-parse',
        'git fetch',
        'git rev-parse',
        'git rev-parse',
        'gh pr view',
        'gh api graphql',
        'git merge-tree',
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
      expect(calls.filter((call) => call[1] === 'merge-tree').at(-1)).toEqual([
        'git',
        'merge-tree',
        '--write-tree',
        `${MERGE}^1`,
        HEAD,
      ]);
    },
  );

  scenarios.scenario('--dry-run runs every check and posts and merges nothing', async () => {
    const world = fake();
    const report = await mergeGate({ ...options, dryRun: true }, { runner: world.runner });
    expect(report.failedStep).toBeNull();
    expect(report.merged).toBe(false);
    expect(report.treesMatch).toBeNull();
    expect(world.posted()).toBe(false);
    expect(world.merged()).toBe(false);
    expect(renderMergeGate(report, true)).toContain('Dry run: every check passed');
  });

  scenarios.describe('a head mismatch refuses', () => {
    scenarios.scenario(
      'when the worktree head is not the pull request head, before any write',
      async () => {
        const world = fake({ pullRequestHead: OTHER });
        const report = await mergeGate(options, { runner: world.runner });
        expect(report.failedStep).toBe('head');
        expect(report.detail).toContain('pull request head');
        expect(world.posted()).toBe(false);
        expect(world.merged()).toBe(false);
      },
    );

    scenarios.scenario(
      'when the pull request head is not the head pinned at acceptance',
      async () => {
        const world = fake();
        const report = await mergeGate(
          { ...options, expectedHead: OTHER },
          { runner: world.runner },
        );
        expect(report.failedStep).toBe('head');
        expect(report.detail).toContain('pinned at acceptance');
        expect(world.posted()).toBe(false);
        expect(world.merged()).toBe(false);
      },
    );

    scenarios.scenario('and a pinned head that matches merges', async () => {
      const report = await mergeGate({ ...options, expectedHead: HEAD }, { runner: fake().runner });
      expect(report.failedStep).toBeNull();
    });

    scenarios.scenario('when the pull request is not open', async () => {
      const report = await mergeGate(options, { runner: fake({ state: 'MERGED' }).runner });
      expect(report).toMatchObject({ failedStep: 'head' });
      expect(report.detail).toContain('MERGED');
    });
  });

  scenarios.describe('a conflict with the base refuses', () => {
    scenarios.scenario('when GitHub reports the pull request CONFLICTING', async () => {
      const world = fake({ mergeable: ['CONFLICTING'] });
      const report = await mergeGate(options, { runner: world.runner });
      expect(report.failedStep).toBe('conflict');
      expect(report.detail).toContain('conflicts with origin/main');
      expect(world.posted()).toBe(false);
      expect(world.merged()).toBe(false);
      expect(world.ranGate()).toBe(false);
    });

    scenarios.scenario('when the merge state is DIRTY', async () => {
      const world = fake({ mergeStateStatus: 'DIRTY' });
      const report = await mergeGate(options, { runner: world.runner });
      expect(report.failedStep).toBe('conflict');
      expect(world.merged()).toBe(false);
    });

    scenarios.scenario('after waiting while GitHub still computes the answer', async () => {
      const world = fake({ mergeable: ['UNKNOWN', 'UNKNOWN', 'CONFLICTING'] });
      const sleeps: number[] = [];
      const report = await mergeGate(options, {
        runner: world.runner,
        sleep: (milliseconds) => sleeps.push(milliseconds),
      });
      expect(report.failedStep).toBe('conflict');
      expect(sleeps).toHaveLength(2);
    });
  });

  scenarios.describe('a base that moved without a conflict', () => {
    scenarios.scenario(
      'merges with no gate, install or build run, and no main merged in',
      async () => {
        const world = fake({ mergeStateStatus: 'BEHIND' });
        const report = await mergeGate(options, { runner: world.runner });
        expect(report).toMatchObject({ failedStep: null, merged: true, treesMatch: true });
        expect(world.ranGate()).toBe(false);
        expect(
          world.calls.some(
            (call) => call[0] === 'git' && ['merge', 'push', 'reset'].includes(call[1] ?? ''),
          ),
        ).toBe(false);
      },
    );

    scenarios.scenario('waits out an UNKNOWN mergeability and then merges', async () => {
      const world = fake({ mergeable: ['UNKNOWN', 'MERGEABLE'] });
      const sleeps: number[] = [];
      const report = await mergeGate(options, {
        runner: world.runner,
        sleep: (milliseconds) => sleeps.push(milliseconds),
      });
      expect(report).toMatchObject({ failedStep: null, merged: true, mergeable: 'MERGEABLE' });
      expect(sleeps).toEqual([2000]);
    });

    scenarios.scenario(
      'a mergeability that stays UNKNOWN stops after five reads, before any write',
      async () => {
        const world = fake({ mergeable: ['UNKNOWN'] });
        const sleeps: number[] = [];
        const report = await mergeGate(options, {
          runner: world.runner,
          sleep: (milliseconds) => sleeps.push(milliseconds),
        });
        expect(report.failedStep).toBe('mergeable');
        expect(sleeps).toHaveLength(4);
        expect(world.calls.filter((call) => call[2] === 'view')).toHaveLength(5);
        expect(world.posted() || world.merged()).toBe(false);
      },
    );

    scenarios.scenario(
      'confirms the squash commit against the head merged into the commit it landed on',
      async () => {
        const wrong = fake({ expectedTree: EXPECTED_TREE, mergedTree: OTHER });
        const report = await mergeGate(options, { runner: wrong.runner });
        expect(report).toMatchObject({
          failedStep: 'confirm',
          merged: true,
          mergeCommit: MERGE,
          treesMatch: false,
        });
        const failed = fake({ mergeTreeCode: 1 });
        expect(await mergeGate(options, { runner: failed.runner })).toMatchObject({
          failedStep: 'confirm',
          merged: true,
        });
      },
    );
  });

  scenarios.scenario(
    'an unresolved thread, and a listing short of the total, both stop the merge',
    async () => {
      const unresolved = fake({
        threadNodes: [
          { id: 'T1', isResolved: true },
          { id: 'T2', isResolved: false },
        ],
      });
      const first = await mergeGate(options, { runner: unresolved.runner });
      expect(first.failedStep).toBe('threads');
      expect(first.detail).toContain('1 review thread(s) are unresolved');
      expect(unresolved.posted() || unresolved.merged()).toBe(false);

      // Every visible thread is resolved, but GitHub reports more than were read.
      const short = fake({ threadTotal: 3 });
      const second = await mergeGate(options, { runner: short.runner });
      expect(second.failedStep).toBe('threads');
      expect(second.detail).toContain('read 1 of 3');
      expect(short.posted()).toBe(false);
      expect(short.merged()).toBe(false);
    },
  );

  scenarios.scenario('a failed fetch is named', async () => {
    const report = await mergeGate(options, { runner: fake({ fetchCodes: [128] }).runner });
    expect(report.failedStep).toBe('fetch');
  });

  scenarios.scenario(
    'a fetch that loses a ref-lock race is retried, and any other failure is not',
    async () => {
      const lockStderr =
        "fatal: cannot lock ref 'refs/remotes/origin/main': is at a but expected b";
      const fetches = (calls: string[][]) => calls.filter((call) => call[1] === 'fetch').length;
      const sleeps: number[] = [];
      const retried = fake({ fetchCodes: [128, 128, 0], fetchStderr: lockStderr });
      const recovered = await mergeGate(options, {
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
      const stuckReport = await mergeGate(options, {
        runner: stuck.runner,
        sleep: () => undefined,
      });
      expect(stuckReport.failedStep).toBe('fetch');
      expect(fetches(stuck.calls)).toBe(3);
      const refused = fake({ fetchCodes: [128] });
      const noSleep: number[] = [];
      const refusedReport = await mergeGate(options, {
        runner: refused.runner,
        sleep: (ms) => noSleep.push(ms),
      });
      expect(refusedReport.failedStep).toBe('fetch');
      expect(fetches(refused.calls)).toBe(1);
      expect(noSleep).toEqual([]);
    },
  );

  scenarios.scenario('a failed comment or merge is named and nothing later runs', async () => {
    const comment = fake({ commentCode: 1 });
    const commentReport = await mergeGate(options, { runner: comment.runner });
    expect(commentReport.failedStep).toBe('comment');
    expect(comment.merged()).toBe(false);
    const refused = fake({ mergeCode: 1 });
    const report = await mergeGate(options, { runner: refused.runner });
    expect(report.failedStep).toBe('merge');
    expect(report.merged).toBe(false);
  });

  scenarios.scenario('the posted comment is the comment file, with no base line', async () => {
    const world = fake();
    await mergeGate(options, { runner: world.runner });
    expect(world.comments).toEqual(['Accepted at the head.\n']);
  });

  scenarios.scenario('confirms the merged state and the merge commit', async () => {
    const openReport = await mergeGate(options, { runner: fake({ mergedState: 'OPEN' }).runner });
    expect(openReport.failedStep).toBe('confirm');
    const none = await mergeGate(options, { runner: fake({ mergeCommit: null }).runner });
    expect(none).toMatchObject({ failedStep: 'confirm', merged: true, mergeCommit: null });
  });
});

scenarios.describe('spend record', () => {
  const totals = { input: 1200, cachedInput: 34000, output: 560 };
  const fixedNow = () => new Date('2026-10-22T18:30:00.000Z');

  scenarios.scenario(
    'appends one tab-separated line after a successful merge, from the injected usage',
    async () => {
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
        const report = await mergeGate(
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
    },
  );

  scenarios.scenario(
    'without the flags nothing is read or written, and the report has no usage',
    async () => {
      const report = await mergeGate(options, {
        runner: fake().runner,
        usage: () => {
          throw new Error('read the transcripts without being asked');
        },
      });
      expect(report.failedStep).toBeNull();
      expect('usage' in report).toBe(false);
    },
  );

  scenarios.scenario('records nothing for a dry run or a failed merge', async () => {
    const usageLog = join(sandbox, 'usage.tsv');
    const transcript = join(sandbox, 'session.jsonl');
    writeFileSync(transcript, '');
    const withRecord = { ...options, usageLog, transcripts: [transcript] };
    const dependencies = (runner: Runner) => ({ runner, usage: () => totals, now: fixedNow });
    const dryReport = await mergeGate({ ...withRecord, dryRun: true }, dependencies(fake().runner));
    expect(dryReport.failedStep).toBeNull();
    const failedReport = await mergeGate(withRecord, dependencies(fake({ mergeCode: 1 }).runner));
    expect(failedReport.failedStep).toBe('merge');
    expect(existsSync(usageLog)).toBe(false);
  });

  scenarios.scenario(
    'a record that cannot be produced is a named step after the merge',
    async () => {
      const transcript = join(sandbox, 'session.jsonl');
      writeFileSync(transcript, '');
      const report = await mergeGate(
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
    },
  );

  scenarios.scenario(
    'the two flags go together and a missing transcript is refused before any write',
    async () => {
      const { runner, calls } = fake();
      const transcript = join(sandbox, 'session.jsonl');
      writeFileSync(transcript, '');
      expect(
        await throwingRejectionOf(
          mergeGate({ ...options, usageLog: join(sandbox, 'u.tsv') }, { runner }),
        ),
      ).toThrow('go together');
      expect(
        await throwingRejectionOf(mergeGate({ ...options, transcripts: [transcript] }, { runner })),
      ).toThrow('go together');
      expect(
        await throwingRejectionOf(
          mergeGate(
            { ...options, usageLog: join(sandbox, 'u.tsv'), transcripts: [join(sandbox, 'nope')] },
            { runner },
          ),
        ),
      ).toThrow('No such transcript');
      expect(calls).toEqual([]);
    },
  );

  scenarios.scenario(
    '--usage-log and repeated --transcript reach the record through run',
    async () => {
      const usageLog = join(sandbox, 'usage.tsv');
      const first = join(sandbox, 'a.jsonl');
      const second = join(sandbox, 'b.jsonl');
      writeFileSync(first, '');
      writeFileSync(second, '');
      const seen: string[][] = [];
      const result = await run(
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
          '--verification-file',
          options.verification.file,
          '--verification-digest',
          options.verification.digest,
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
    },
  );
});

scenarios.describe('run', () => {
  const argv = () => [
    '--config',
    options.configPath,
    '--pr',
    '12',
    '--worktree',
    options.worktree,
    '--comment-file',
    options.commentFile,
    '--verification-file',
    options.verification.file,
    '--verification-digest',
    options.verification.digest,
  ];

  scenarios.scenario(
    'exits 0 with one JSON object under --json, and 1 naming the failed step otherwise',
    async () => {
      const passing = await run([...argv(), '--json'], { runner: fake().runner });
      expect(passing.code).toBe(0);
      expect(JSON.parse(passing.output).treesMatch).toBe(true);
      const failing = await run(argv(), { runner: fake({ pullRequestHead: OTHER }).runner });
      expect(failing.code).toBe(1);
      expect(failing.output).toContain('FAILED at head');
      const conflicting = await run(argv(), {
        runner: fake({ mergeable: ['CONFLICTING'] }).runner,
      });
      expect(conflicting.code).toBe(1);
      expect(conflicting.output).toContain('FAILED at conflict');
    },
  );

  scenarios.scenario('--head pins the head the pull request must have', async () => {
    const accepted = await run([...argv(), '--head', HEAD], { runner: fake().runner });
    expect(accepted.code).toBe(0);
    const pinned = await run([...argv(), '--head', OTHER], { runner: fake().runner });
    expect(pinned.code).toBe(1);
    expect(pinned.output).toContain('FAILED at head');
  });

  scenarios.scenario('rejects bad usage before touching anything', async () => {
    const { runner, calls } = fake();
    expect(await throwingRejectionOf(run([], { runner }))).toThrow(UsageError);
    expect(await throwingRejectionOf(run([...argv(), 'extra'], { runner }))).toThrow(UsageError);
    expect(await throwingRejectionOf(run([...argv(), '--pr', 'x'], { runner }))).toThrow(
      UsageError,
    );
    expect(await throwingRejectionOf(run([...argv(), '--bogus'], { runner }))).toThrow(UsageError);
    expect(await throwingRejectionOf(run([...argv(), '--head', 'abc123'], { runner }))).toThrow(
      'is not a full commit SHA',
    );
    // The gate and the waivers are gone: their flags are unknown options now.
    for (const removed of ['--gate-log', '--waive-load-flake', '--control-head', '--reason'])
      expect(await throwingRejectionOf(run([...argv(), removed, 'x'], { runner }))).toThrow(
        UsageError,
      );
    // So are the health file's flags: main's health is read from GitHub.
    expect(await throwingRejectionOf(run([...argv(), '--health-file', 'x'], { runner }))).toThrow(
      UsageError,
    );
    writeFileSync(options.commentFile, '  \n');
    expect(await throwingRejectionOf(run(argv(), { runner }))).toThrow('is empty');
    expect(calls).toEqual([]);
  });
});

/**
 * The lock scenarios run at module scope, because acquiring the lock reads a process's start time
 * through `ps`, which a test body may not do on the per-test clock.
 */
async function lockScenarios() {
  const { directory, prepared } = prepare();
  const fixture = await createDeliveryVerificationFixture(undefined, { route: 'pull-request', landing: true });
  const lockWorld = (
    bound: Awaited<ReturnType<typeof createDeliveryVerificationFixture>>,
    world: World = {},
  ) =>
    fake({
      ...world,
      head: bound.request.revision,
      pullRequestHead: bound.request.revision,
      base: bound.request.base,
      expectedTree: bound.request.integrationTree,
    });
  const lockDirectory = join(directory, 'git', 'corvidae-merge-lock');
  mkdirSync(join(directory, 'git'), { recursive: true });
  const lockOptions: MergeGateOptions = {
    ...prepared,
    worktree: fixture.directory,
    verification: fixture.verification,
    lockDirectory,
    lockPollIntervalMs: 10,
  };
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
  // A live holder: the second session waits, touches nothing, and proceeds once it is released.
  // The wait is read from the lock's own report, never from a timer: reading the holder's start time
  // runs `ps`, which a loaded host can make slower than any window a timer would allow.
  plantHolder(process.pid, processStartTime(process.pid));
  const waiting = lockWorld(fixture);
  const waits: unknown[] = [];
  const pending = mergeGateImplementation(
    lockOptions,
    { runner: waiting.runner, verification: fixture.dependencies },
    (holder) => waits.push(holder),
  );
  await waitUntil(() => waits.length > 0, { message: 'the second holder to report its wait' });
  const callsWhileHeld = waiting.calls.length;
  rmSync(lockDirectory, { recursive: true });
  const afterRelease = await pending;
  const waited = {
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
  const reclaimedFixture = await createDeliveryVerificationFixture(undefined, {
    route: 'pull-request',
    landing: true,
  });
  const reclaimWorld = lockWorld(reclaimedFixture);
  const reclaimed = {
    report: await mergeGateImplementation(
      {
        ...lockOptions,
        worktree: reclaimedFixture.directory,
        verification: reclaimedFixture.verification,
      },
      {
        runner: reclaimWorld.runner,
        verification: reclaimedFixture.dependencies,
      },
    ),
    merged: reclaimWorld.merged(),
    lockGone: !existsSync(lockDirectory),
  };

  // A failing step still releases the lock.
  const failedFixture = await createDeliveryVerificationFixture(undefined, {
    route: 'pull-request',
    landing: true,
  });
  const failed = {
    report: await mergeGateImplementation(
      {
        ...lockOptions,
        worktree: failedFixture.directory,
        verification: failedFixture.verification,
      },
      {
        runner: lockWorld(failedFixture, { mergeCode: 1 }).runner,
        verification: failedFixture.dependencies,
      },
    ),
    lockGone: !existsSync(lockDirectory),
  };

  // A dry run takes no lock, even while another session holds it.
  plantHolder(process.pid, processStartTime(process.pid));
  const dryRun = {
    report: await mergeGateImplementation(
      { ...lockOptions, dryRun: true },
      { runner: lockWorld(fixture).runner, verification: fixture.dependencies },
    ),
    holderIntact: existsSync(join(lockDirectory, 'owner.json')),
  };
  rmSync(directory, { recursive: true, force: true });
  return { waited, reclaimed, failed, dryRun };
}

const locks = await lockScenarios();

scenarios.describe('the cross-session merge lock', () => {
  scenarios.scenario(
    'a second holder waits while the first holds the lock, then proceeds when it releases',
    async () => {
      expect(locks.waited.callsWhileHeld).toBe(0);
      expect(locks.waited.waits).toBeGreaterThan(0);
      expect(locks.waited.afterRelease.failedStep).toBeNull();
      expect(locks.waited.merged).toBe(true);
      expect(locks.waited.lockGone).toBe(true);
    },
  );

  scenarios.scenario('reclaims the lock of a holder that died', async () => {
    expect(locks.reclaimed.report.failedStep).toBeNull();
    expect(locks.reclaimed.merged).toBe(true);
    expect(locks.reclaimed.lockGone).toBe(true);
  });

  scenarios.scenario('releases the lock when a step fails', async () => {
    expect(locks.failed.report.failedStep).toBe('merge');
    expect(locks.failed.lockGone).toBe(true);
  });

  scenarios.scenario('a dry run takes no lock, even while another session holds it', async () => {
    expect(locks.dryRun.report.failedStep).toBeNull();
    expect(locks.dryRun.holderIntact).toBe(true);
  });
});

scenarios.scenario(
  'refuses closeout when the landed tree differs from the approved integration tree',
  async () => {
    const landed = '7'.repeat(40);
    const world = fake({ confirmedExpectedTree: landed, mergedTree: landed });
    const report = await mergeGateImplementation(options, { runner: world.runner, verification });
    expect(report).toMatchObject({ merged: true, failedStep: 'confirm' });
    const loaded = loadDeliveryVerification(options.verification, verification);
    expect(
      readExecutionSnapshot(loaded.state).operations[loaded.request.operationId]?.outcome,
    ).toBe('unknown');
  },
);

scenarios.scenario('refuses a queued pull-request merge after owner replacement', async () => {
  const authority = loadDeliveryVerification(options.verification, verification).request.authority;
  const world = fake();
  const lockDirectory = join(sandbox, 'cancellation-merge-lock');
  const queued = await withMergeLock(
    { worktree: options.worktree, lockDirectory, command: 'hold before cancellation' },
    async () => {
      const refusal = throwingRejectionOf(
        mergeGate({ ...options, lockDirectory }, { runner: world.runner }),
      );
      expect(await cancelDispatch(verification.state, authority)).toBe(true);
      const replacement = await acquireDispatch(verification.state, {
        ...authority,
        ownerId: 'replacement',
      });
      expect(replacement.granted).toBe(true);
      return { refusal, replacement };
    },
    world.runner,
  );
  expect(await queued.refusal).toThrow('newer generation');
  expect(world.posted()).toBe(false);
  expect(world.merged()).toBe(false);
  if (!queued.replacement.granted) throw new Error(queued.replacement.reason);
  expect(requireAuthority(verification.state, queued.replacement.authority)).toEqual(
    queued.replacement.authority,
  );
});

scenarios.scenario(
  'holds authority through comment, merge and confirmation before cancellation',
  async () => {
    const authority = loadDeliveryVerification(options.verification, verification).request
      .authority;
    const providerLock = join(
      verification.state.lockDirectory,
      `${encodeURIComponent(authority.resource)}.provider-transition.lock`,
    );
    const world = fake();
    const events: string[] = [];
    let cancellation: Promise<boolean> | undefined;
    const report = await mergeGate(options, {
      runner: (command, runnerOptions) => {
        const mutation =
          command[0] === 'gh' &&
          command[1] === 'pr' &&
          ['comment', 'merge'].includes(command[2] ?? '');
        const confirmed =
          command[0] === 'git' && command[1] === 'rev-parse' && command[2] === `${MERGE}^{tree}`;
        if (mutation || confirmed) {
          expect(existsSync(providerLock)).toBe(true);
          expect(requireAuthority(verification.state, authority)).toEqual(authority);
          cancellation ??= cancelDispatch(verification.state, authority).then((result) => {
            events.push('cancelled');
            return result;
          });
          events.push(confirmed ? 'confirmed' : (command[2] ?? ''));
        }
        return world.runner(command, runnerOptions);
      },
    });
    expect(report).toMatchObject({ merged: true, failedStep: null, treesMatch: true });
    expect(cancellation).toBeDefined();
    expect(await cancellation).toBe(true);
    expect(events).toEqual(['comment', 'merge', 'confirmed', 'cancelled']);
    expect(existsSync(providerLock)).toBe(false);
  },
);

await scenarios.settled();
