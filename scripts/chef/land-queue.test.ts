import { describe, expect, test } from 'bun:test';

import { rejectionOf } from '../../testing/testing/src/helpers/promise-outcome.ts';

import {
  formatVerdict,
  githubMainRuns,
  inScope,
  landQueueVerdict,
  planScope,
  run,
  UsageError,
  type MainRun,
  type MainRunReader,
} from './land-queue.ts';
import type { Runner } from './process-runner.ts';
import type { EvidencePlan } from './verification-plan.ts';

const EVIDENCE = 'e'.repeat(40);
const MERGE_BASE = 'b'.repeat(40);
const MAIN_HEAD = 'm'.repeat(40);

const plan: EvidencePlan = {
  changed: ['packages/armorer/src/registry.ts'],
  unit_tests: [
    { workspace: 'packages/armorer', paths: ['src/registry.test.ts'], full: false },
    { workspace: 'packages/operative', paths: ['src/run.test.ts'], full: false },
    { workspace: '', paths: ['scripts/chef/land-queue.test.ts'], full: false },
  ],
  root_checks: ['lint:root', 'typecheck:root'],
  fixture_slugs: ['card'],
  fixture_specs: ['scripts/browser-fixtures/tests/card.playwright.ts'],
  e2e_specs: ['tests/e2e/runs.spec.ts'],
  requires_full_run: false,
  full_run_rules: [],
};

/** The workspace graph: armorer depends on core, which depends on nothing; weft stands alone. */
const workspaces = [
  { name: 'root', directory: '', dependencies: [] },
  { name: 'armorer', directory: 'packages/armorer', dependencies: ['@lostgradient/core'] },
  { name: '@lostgradient/core', directory: 'packages/core', dependencies: [] },
  { name: 'operative', directory: 'packages/operative', dependencies: [] },
  { name: 'weft', directory: 'packages/weft', dependencies: [] },
];

/** The root lane's test imports a helper in its own folder and one outside `scripts/`. */
const ROOT_FILES: Record<string, string> = {
  'scripts/chef/land-queue.test.ts':
    "import { x } from './helper.ts';\nimport { y } from '../../testing/testing/src/wait.ts';\nimport z from 'bun:test';",
  'scripts/chef/helper.ts': "export * from '../shared.ts';",
  'scripts/shared.ts': '',
  'testing/testing/src/wait.ts': '',
};

/** A repository whose `main` has `commits` (oldest first) on top of the evidence's merge-base. */
function repository(
  commits: Record<string, string[]>,
  files: Record<string, string> = ROOT_FILES,
): { runner: Runner; calls: string[][] } {
  const calls: string[][] = [];
  const runner: Runner = (command) => {
    calls.push(command);
    const [, verb, ...rest] = command;
    const out = (stdout: string) => ({ code: 0, stdout: `${stdout}\n`, stderr: '' });
    if (verb === 'fetch') return out('');
    if (verb === 'show') {
      const text = files[(rest[0] ?? '').slice(`${EVIDENCE}:`.length)];
      return text === undefined
        ? { code: 128, stdout: '', stderr: 'bad object' }
        : { code: 0, stdout: text, stderr: '' };
    }
    if (verb === 'rev-parse')
      return out(rest.includes(`${EVIDENCE}^{commit}`) ? EVIDENCE : MAIN_HEAD);
    if (verb === 'merge-base') return out(MERGE_BASE);
    if (verb === 'rev-list') return out(Object.keys(commits).join('\n'));
    if (verb === 'diff-tree')
      return { code: 0, stdout: (commits[rest.at(-1) ?? ''] ?? []).join('\0'), stderr: '' };
    return { code: 1, stdout: '', stderr: `unexpected ${command.join(' ')}` };
  };
  return { runner, calls };
}

function verdict(
  commits: Record<string, string[]>,
  evidencePlan = plan,
  files: Record<string, string> = ROOT_FILES,
) {
  const { runner } = repository(commits, files);
  return landQueueVerdict({ runner, evidence: EVIDENCE, plan: evidencePlan, workspaces });
}

describe('land-queue verdict', () => {
  test('main has not moved: lands without a new run', () => {
    const result = verdict({});
    expect(result.verdict).toBe('LAND');
    expect(result.commits).toEqual([]);
  });

  test('a commit on main that touches nothing in the plan scope lands without a new run', () => {
    const result = verdict({
      c1: ['packages/weft/src/protocol.ts', 'documentation/plans/other.md'],
      c2: ['components/cinder/src/components/banner/banner.css'],
    });
    expect(result.verdict).toBe('LAND');
    expect(result.overlapping).toEqual([]);
    expect(result.commits.map((commit) => commit.sha)).toEqual(['c1', 'c2']);
    expect(result.mergeBase).toBe(MERGE_BASE);
  });

  test('a commit on main that touches a changed file requires a new run, naming the file', () => {
    const result = verdict({
      c1: ['packages/weft/src/protocol.ts'],
      c2: ['packages/armorer/src/registry.ts'],
    });
    expect(result.verdict).toBe('REDISPATCH');
    expect(result.overlapping).toEqual(['packages/armorer/src/registry.ts']);
  });

  test('a commit inside a workspace the selection reaches requires a new run', () => {
    const result = verdict({ c1: ['packages/operative/src/unrelated.ts'] });
    expect(result.verdict).toBe('REDISPATCH');
    expect(result.overlapping).toEqual(['packages/operative/src/unrelated.ts']);
  });

  test('a spec the plan selects, and a fixture slug source, are in scope', () => {
    const result = verdict({
      c1: ['applications/interborough/tests/e2e/runs.spec.ts'],
      c2: ['scripts/browser-fixtures/src/fixtures/card.svelte'],
      c3: ['components/cinder/src/components/card/card.css'],
      c4: ['scripts/browser-fixtures/src/fixtures/table.svelte'],
    });
    expect(result.verdict).toBe('REDISPATCH');
    expect(result.overlapping).toEqual([
      'applications/interborough/tests/e2e/runs.spec.ts',
      'components/cinder/src/components/card/card.css',
      'scripts/browser-fixtures/src/fixtures/card.svelte',
    ]);
  });

  test('a root lane overlaps the modules its tests import, transitively, and no other script', () => {
    expect(verdict({ c1: ['scripts/chef/land-queue.test.ts'] }).verdict).toBe('REDISPATCH');
    // Imported through `./helper.ts`, then `../shared.ts`, and from outside `scripts/`.
    expect(verdict({ c1: ['scripts/chef/helper.ts'] }).overlapping).toEqual([
      'scripts/chef/helper.ts',
    ]);
    expect(verdict({ c1: ['scripts/shared.ts'] }).verdict).toBe('REDISPATCH');
    expect(verdict({ c1: ['testing/testing/src/wait.ts'] }).verdict).toBe('REDISPATCH');
    expect(verdict({ c1: ['scripts/chef/direct-merge.ts'] }).verdict).toBe('LAND');
  });

  test('a root test that cannot be read makes any scripts change overlap', () => {
    expect(verdict({ c1: ['scripts/chef/direct-merge.ts'] }, plan, {}).verdict).toBe('REDISPATCH');
  });

  test('a commit to a workspace the planned tests depend on overlaps, though no test is there', () => {
    const result = verdict({ c1: ['packages/core/src/index.ts'] });
    expect(result.verdict).toBe('REDISPATCH');
    expect(result.overlapping).toEqual(['packages/core/src/index.ts']);
    expect(verdict({ c1: ['packages/weft/src/index.ts'] }).verdict).toBe('LAND');
  });

  test('a global input overlaps whatever the plan selected', () => {
    for (const path of [
      'bun.lock',
      'turbo.json',
      'package.json',
      'packages/weft/tsconfig.json',
      'tsconfig.base.json',
      '.github/workflows/main.yml',
      'internal/typescript/library.json',
    ])
      expect(verdict({ c1: [path] }).verdict, path).toBe('REDISPATCH');
    // Only the root manifest: another workspace's manifest is not a global input.
    expect(verdict({ c1: ['packages/weft/package.json'] }).verdict).toBe('LAND');
  });

  test('a plan that requires a full run is overlapped by any commit', () => {
    const result = verdict(
      { c1: ['documentation/plans/other.md'] },
      { ...plan, requires_full_run: true },
    );
    expect(result.verdict).toBe('REDISPATCH');
    expect(result.overlapping).toEqual(['documentation/plans/other.md']);
  });

  test('only reads: it never merges, fetches or writes', () => {
    const { runner, calls } = repository({ c1: ['packages/weft/src/protocol.ts'] });
    landQueueVerdict({ runner, evidence: EVIDENCE, plan });
    expect(new Set(calls.map((call) => call[1]))).toEqual(
      new Set(['rev-parse', 'merge-base', 'rev-list', 'show', 'diff-tree']),
    );
  });

  test('a git failure is refused as a usage error, never read as no overlap', () => {
    const runner: Runner = () => ({ code: 128, stdout: '', stderr: 'bad revision' });
    expect(() => landQueueVerdict({ runner, evidence: EVIDENCE, plan })).toThrow(UsageError);
  });

  test('scope helpers', () => {
    const scope = planScope(plan);
    expect(inScope(scope, 'packages/armorer/src/anything.ts')).toBe(true);
    expect(inScope(scope, 'packages/weft/src/anything.ts')).toBe(false);
  });
});

// A commit that main's own CI verified does not make the evidence stale (owner decision,
// 2026-11-21): a successful `main.yml` push run at a commit verifies it and every commit before it.
describe('land-queue with main CI verification', () => {
  const IN_PLAN = ['packages/armorer/src/registry.ts'];
  const OUT_OF_PLAN = ['packages/weft/src/protocol.ts'];
  const green = (sha: string, id: string): MainRun => ({
    sha,
    id,
    status: 'completed',
    conclusion: 'success',
  });

  function withRuns(commits: Record<string, string[]>, runs: MainRun[] | Error) {
    const reads: number[] = [];
    const mainRuns: MainRunReader = () => {
      reads.push(1);
      if (runs instanceof Error) throw runs;
      return runs;
    };
    const { runner } = repository(commits);
    const result = landQueueVerdict({
      runner,
      evidence: EVIDENCE,
      plan,
      workspaces,
      mainRuns,
    });
    return { result, reads: reads.length };
  }

  // Row 1.
  test('no new main commits: LAND, and main CI is not read', () => {
    const { result, reads } = withRuns({}, new Error('must not be read'));
    expect(result.verdict).toBe('LAND');
    expect(result.verified).toEqual([]);
    expect(reads).toBe(0);
  });

  // Row 2.
  test('new commits outside the plan: LAND as before, and main CI is not read', () => {
    const { result, reads } = withRuns(
      { c1: OUT_OF_PLAN, c2: ['documentation/plans/other.md'] },
      new Error('must not be read'),
    );
    expect(result.verdict).toBe('LAND');
    expect(result.overlapping).toEqual([]);
    expect(result.verified).toEqual([]);
    expect(reads).toBe(0);
  });

  // Row 3.
  test('in-plan commits at or before a green push run: LAND, reporting the commits and the run', () => {
    const { result, reads } = withRuns({ c1: IN_PLAN, c2: OUT_OF_PLAN, c3: IN_PLAN }, [
      green('c3', '303'),
    ]);
    expect(reads).toBe(1);
    expect(result.verdict).toBe('LAND');
    expect(result.overlapping).toEqual([]);
    expect(result.verified).toEqual([
      { sha: 'c1', runId: '303', runSha: 'c3' },
      { sha: 'c2', runId: '303', runSha: 'c3' },
      { sha: 'c3', runId: '303', runSha: 'c3' },
    ]);
    expect(result.commits.map((commit) => commit.sha)).toEqual(['c1', 'c2', 'c3']);
    const text = formatVerdict(result);
    expect(text.split('\n')[0]).toBe('LAND');
    expect(text).toContain('verified by main.yml run 303');
  });

  test('a green run at a later commit covers an earlier commit whose own run failed', () => {
    const { result } = withRuns({ c1: IN_PLAN, c2: IN_PLAN }, [
      { sha: 'c1', id: '101', status: 'completed', conclusion: 'failure' },
      green('c2', '202'),
    ]);
    expect(result.verdict).toBe('LAND');
    expect(result.verified.map((commit) => [commit.sha, commit.runId])).toEqual([
      ['c1', '202'],
      ['c2', '202'],
    ]);
  });

  test('each verified commit is credited to the earliest green run at or after it', () => {
    const { result } = withRuns({ c1: IN_PLAN, c2: IN_PLAN, c3: IN_PLAN }, [
      green('c1', '101'),
      green('c3', '303'),
    ]);
    expect(result.verified).toEqual([
      { sha: 'c1', runId: '101', runSha: 'c1' },
      { sha: 'c2', runId: '303', runSha: 'c3' },
      { sha: 'c3', runId: '303', runSha: 'c3' },
    ]);
  });

  // Row 4.
  test('in-plan commits after the newest green run: REDISPATCH naming only their files', () => {
    const { result } = withRuns(
      {
        c1: ['packages/armorer/src/registry.ts'],
        c2: ['packages/armorer/src/other.ts'],
        c3: ['packages/operative/src/later.ts'],
      },
      [green('c2', '202')],
    );
    expect(result.verdict).toBe('REDISPATCH');
    expect(result.overlapping).toEqual(['packages/operative/src/later.ts']);
    expect(result.verified.map((commit) => commit.sha)).toEqual(['c1', 'c2']);
  });

  // Row 5.
  test('a green run only at an older commit: REDISPATCH for the later in-plan commits', () => {
    const { result } = withRuns(
      {
        c1: ['packages/armorer/src/registry.ts'],
        c2: OUT_OF_PLAN,
        c3: ['packages/operative/src/second.ts'],
        c4: ['packages/core/src/third.ts'],
      },
      [green('c1', '101')],
    );
    expect(result.verdict).toBe('REDISPATCH');
    expect(result.overlapping).toEqual([
      'packages/core/src/third.ts',
      'packages/operative/src/second.ts',
    ]);
    expect(result.verified).toEqual([{ sha: 'c1', runId: '101', runSha: 'c1' }]);
    const text = formatVerdict(result);
    expect(text.split('\n')[0]).toBe('REDISPATCH');
    expect(text).toContain('verified by main.yml run 101');
  });

  // Row 6.
  test('a newer run that failed, was cancelled or is still in progress verifies nothing', () => {
    const { result } = withRuns(
      {
        c1: ['packages/armorer/src/registry.ts'],
        c2: ['packages/armorer/src/two.ts'],
        c3: ['packages/armorer/src/three.ts'],
        c4: ['packages/armorer/src/four.ts'],
      },
      [
        green('c1', '101'),
        { sha: 'c2', id: '202', status: 'in_progress', conclusion: null },
        { sha: 'c3', id: '303', status: 'completed', conclusion: 'failure' },
        { sha: 'c4', id: '404', status: 'completed', conclusion: 'cancelled' },
      ],
    );
    expect(result.verdict).toBe('REDISPATCH');
    expect(result.overlapping).toEqual([
      'packages/armorer/src/four.ts',
      'packages/armorer/src/three.ts',
      'packages/armorer/src/two.ts',
    ]);
    expect(result.verified.map((commit) => commit.sha)).toEqual(['c1']);
  });

  test('a run that is not completed does not verify even when it reports success', () => {
    const { result } = withRuns({ c1: IN_PLAN }, [
      { sha: 'c1', id: '101', status: 'queued', conclusion: 'success' },
    ]);
    expect(result.verdict).toBe('REDISPATCH');
    expect(result.verified).toEqual([]);
  });

  // Row 7.
  test('an unreadable provider verifies nothing: REDISPATCH saying main could not be verified', () => {
    const { result } = withRuns(
      { c1: IN_PLAN, c2: OUT_OF_PLAN },
      new Error('gh run list failed: HTTP 502'),
    );
    expect(result.verdict).toBe('REDISPATCH');
    expect(result.refusal).toContain('the queue could not verify main');
    expect(result.refusal).toContain('HTTP 502');
    expect(result.overlapping).toEqual(IN_PLAN);
    expect(result.verified).toEqual([]);
    expect(formatVerdict(result)).toContain('the queue could not verify main');
  });

  test('without a provider nothing is verified, as before', () => {
    const { runner } = repository({ c1: IN_PLAN });
    const result = landQueueVerdict({ runner, evidence: EVIDENCE, plan, workspaces });
    expect(result.verdict).toBe('REDISPATCH');
    expect(result.verified).toEqual([]);
  });

  test('a plan that requires a full run lands once main CI covers every commit', () => {
    const { runner } = repository({ c1: ['documentation/plans/other.md'], c2: ['bun.lock'] });
    const result = landQueueVerdict({
      runner,
      evidence: EVIDENCE,
      plan: { ...plan, requires_full_run: true },
      workspaces,
      mainRuns: () => [green('c2', '202')],
    });
    expect(result.verdict).toBe('LAND');
    expect(result.verified.map((commit) => commit.sha)).toEqual(['c1', 'c2']);
  });
});

describe('main run provider (gh)', () => {
  const ghRunner =
    (stdout: string, code = 0): Runner =>
    () => ({ code, stdout, stderr: code === 0 ? '' : 'HTTP 502' });
  const reader = (runner: Runner) =>
    githubMainRuns(runner, { branch: 'main', repository: 'acme/widgets' });

  test('reads the main.yml push runs for the default branch', () => {
    const calls: string[][] = [];
    const runs = githubMainRuns(
      (command) => {
        calls.push(command);
        return {
          code: 0,
          stdout: JSON.stringify([
            { databaseId: 7, headSha: 'a'.repeat(40), status: 'completed', conclusion: 'success' },
            { databaseId: 8, headSha: 'b'.repeat(40), status: 'in_progress', conclusion: '' },
          ]),
          stderr: '',
        };
      },
      { branch: 'main', repository: 'acme/widgets' },
    )();
    expect(runs).toEqual([
      { sha: 'a'.repeat(40), id: '7', status: 'completed', conclusion: 'success' },
      { sha: 'b'.repeat(40), id: '8', status: 'in_progress', conclusion: null },
    ]);
    const command = calls[0]?.join(' ') ?? '';
    expect(command).toContain('--workflow main.yml');
    expect(command).toContain('--branch main');
    expect(command).toContain('--event push');
    expect(command).toContain('--repo acme/widgets');
    expect(command).toContain('--json databaseId,headSha,status,conclusion');
  });

  test('a failed command, bad JSON or a malformed run all throw, so the queue fails closed', () => {
    expect(() => reader(ghRunner('', 1))()).toThrow('gh run list failed: HTTP 502');
    expect(() => reader(ghRunner('not json'))()).toThrow('did not return JSON');
    expect(() => reader(ghRunner('{}'))()).toThrow('did not return a list');
    expect(() => reader(ghRunner('[{"headSha":"a"}]'))()).toThrow('without a head or a status');
    expect(() => reader(ghRunner('[null]'))()).toThrow('not a run');
  });
});

describe('land-queue command', () => {
  const dependencies =(commits: Record<string, string[]>) => ({
    runner: repository(commits).runner,
    readPlan: () => plan,
    withLock: async <T>(_: unknown, action: () => T) => action(),
  });

  test('exit 0 on LAND and 3 on REDISPATCH, with the files in the output', async () => {
    const landed = await run(['--evidence', EVIDENCE, '--plan', 'plan.json'], dependencies({}));
    expect(landed.code).toBe(0);
    expect(landed.output.split('\n')[0]).toBe('LAND');
    const redispatched = await run(
      ['--evidence', EVIDENCE, '--plan', 'plan.json', '--json'],
      dependencies({ c1: ['packages/armorer/src/registry.ts'] }),
    );
    expect(redispatched.code).toBe(3);
    expect(JSON.parse(redispatched.output).overlapping).toEqual([
      'packages/armorer/src/registry.ts',
    ]);
  });

  test('holds the lock while it reads main', async () => {
    const order: string[] = [];
    const base = dependencies({});
    await run(['--evidence', EVIDENCE, '--plan', 'plan.json'], {
      ...base,
      runner: (command, options) => {
        order.push(`git ${command[1]}`);
        return base.runner(command, options);
      },
      withLock: async (_, action) => {
        order.push('lock');
        const value = action();
        order.push('unlock');
        return value;
      },
    });
    expect(order[0]).toBe('lock');
    expect(order.at(-1)).toBe('unlock');
    expect(order).toContain('git rev-list');
  });

  test('fetches main inside the lock before it reads it', async () => {
    const order: string[] = [];
    const base = dependencies({});
    await run(['--evidence', EVIDENCE, '--plan', 'plan.json'], {
      ...base,
      runner: (command, options) => {
        order.push(command.slice(1).join(' '));
        return command[1] === 'fetch'
          ? { code: 0, stdout: '', stderr: '' }
          : base.runner(command, options);
      },
    });
    expect(order[0]).toBe('fetch origin main');
    expect(order.indexOf('fetch origin main')).toBeLessThan(
      order.findIndex((entry) => entry.startsWith('rev-parse')),
    );
  });

  test('requires --evidence and --plan', async () => {
    expect(await rejectionOf(run(['--plan', 'plan.json'], dependencies({})))).toBeInstanceOf(
      UsageError,
    );
    expect(await rejectionOf(run(['--evidence', EVIDENCE], dependencies({})))).toBeInstanceOf(
      UsageError,
    );
  });
});
