import { expect } from 'bun:test';
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

import { rejectionOf } from '../../testing/testing/src/helpers/promise-outcome.ts';
import type { CiEvidenceProvider, CiEvidenceRequest } from './ci-evidence.ts';
import { branchRunner } from './deliver.test-support.ts';
import { batchVerificationPlanDigest, readDeliveryRequest } from './delivery-completion.ts';
import {
  check,
  EVIDENCE_JOB,
  prepare,
  run,
  UsageError,
  type CheckDependencies,
  type PrepareDependencies,
  type PrepareOptions,
  type PrepareResult,
} from './delivery-request.ts';
import {
  loadDeliveryVerification,
  validateDeliveryVerification,
  type DeliveryVerificationDependencies,
} from './delivery-verification.ts';
import { directMerge } from './direct-merge.ts';
import {
  acquireDispatch,
  createExecutionStateStore,
  type ExecutionStateStore,
} from './execution-state.ts';
import {
  greenLandingAnswers,
  jobsAnswer,
  LANDING_RUN_ID,
  landingRun,
  runsAnswer,
} from './landing-evidence.test-support.ts';
import type { Runner, RunnerResult } from './process-runner.ts';
import { createScenarios } from './scenario.test-support.ts';
import { dispatchVerificationRun } from './targeted-run.ts';
import {
  assignmentVersion,
  computeEvidencePlan,
  digest,
  type Assignment,
} from './verification-plan.ts';

const HEAD = 'a'.repeat(40);
const BASE = 'c'.repeat(40);
const TREE = '1'.repeat(40);
const BRANCH = 'cor-9-widgets';
const RUNNER_NAME = 'GitHub Actions 7';
const REPOSITORY = 'acme/widgets';

const reply = (stdout = '', code = 0, stderr = ''): RunnerResult => ({ code, stdout, stderr });

let sandbox: string;

// Every scenario starts processes (the execution state asks `ps` for a start time), so each runs
// at module scope, off Bun's per-test clock.
const scenarios = createScenarios({
  setUp: () => {
    const scratch = join(process.cwd(), 'tmp/chef/delivery-request-tests');
    mkdirSync(scratch, { recursive: true });
    sandbox = mkdtempSync(join(scratch, 'case-'));
    mkdirSync(join(sandbox, 'worktree'));
  },
  tearDown: () => {
    rmSync(sandbox, { recursive: true, force: true });
  },
});

/** A Linear assignment as `brief.ts` reads it: criteria from the issue, no `merge` action yet. */
function assignmentFor(identifier: string, criteria: string[]): Assignment {
  const assignment: Assignment = {
    version: assignmentVersion,
    identity: { identifier, revision: 'fixture', repository: REPOSITORY, base: BASE, digest: '' },
    criteria: criteria.map((id) => ({ id, text: `${id} of ${identifier}` })),
    ownedPaths: ['a.ts'],
    exclusions: [],
    dependencies: [],
    sourceReferences: [],
    designRows: [],
    deliveryBoundary: 'Push the assigned branch and report to the coordinator.',
    allowedConsequentialActions: ['edit assigned paths', 'commit'],
    classification: 'behavior',
  };
  assignment.identity.digest = digest(
    JSON.stringify({ ...assignment, identity: { ...assignment.identity, digest: undefined } }),
  );
  return assignment;
}

/** Every `git` and `gh` answer a prepare and a green check read, keyed by the command without its program. */
function answers(extra: Record<string, RunnerResult> = {}): Record<string, RunnerResult> {
  return {
    'rev-parse HEAD': reply(`${HEAD}\n`),
    [`api repos/${REPOSITORY}/git/ref/heads/${BRANCH}`]: reply(
      JSON.stringify({ object: { sha: HEAD } }),
    ),
    [`merge-base --is-ancestor ${BASE} ${HEAD}`]: reply(),
    [`merge-tree --write-tree ${BASE} ${HEAD}`]: reply(`${TREE}\n`),
    [`rev-parse ${HEAD}^{tree}`]: reply(`${TREE}\n`),
    [`diff --name-only --diff-filter=d ${BASE}...${HEAD}`]: reply('a.ts\n'),
    'fetch origin main': reply(),
    'rev-parse refs/remotes/origin/main^{commit}': reply(`${BASE}\n`),
    ...greenLandingAnswers(REPOSITORY, HEAD, BASE),
    ...extra,
  };
}

function runnerOf(table: Record<string, RunnerResult>): { runner: Runner; calls: string[] } {
  const calls: string[] = [];
  const runner: Runner = (command) => {
    const key = command.slice(1).join(' ');
    calls.push(key);
    return table[key] ?? reply('', 1, `unexpected command: ${key}`);
  };
  return { runner, calls };
}

/** The `-f name=value` inputs of a dispatched `gh workflow run`. */
function inputsOf(command: string[]): Record<string, string> {
  const inputs: Record<string, string> = {};
  command.forEach((word, index) => {
    if (word !== '-f') return;
    const [name, ...value] = (command[index + 1] ?? '').split('=');
    inputs[name ?? ''] = value.join('=');
  });
  return inputs;
}

/**
 * The run GitHub would record for a dispatch: its request key, plan digest and base are the ones the
 * dispatched command carried, never the ones the request pins, so a mismatch is not hidden.
 */
function providerFor(command: string[], head = HEAD): Pick<CiEvidenceProvider, 'findRuns'> {
  const inputs = inputsOf(command);
  return {
    async findRuns(identity: CiEvidenceRequest) {
      if (identity.requestKey !== inputs['verification_request']) return [];
      return [
        landingRun(
          identity,
          { base: BASE, revision: head, integrationTree: TREE },
          {
            requestKey: inputs['verification_request'],
            receiptRequestKey: inputs['verification_request'],
            verificationPlanDigest: inputs['verification_plan'],
            base: inputs['verification_base'],
            jobs: [EVIDENCE_JOB, 'Evidence aggregate'],
          },
        ),
      ];
    },
  };
}

function transportFor(): NonNullable<DeliveryVerificationDependencies['transport']> {
  return {
    run: () => ({
      repository: REPOSITORY,
      revision: HEAD,
      status: 'completed',
      conclusion: 'success',
      workflow: 'Main',
      workflowPath: '.github/workflows/main.yml',
      event: 'workflow_dispatch',
      attempt: 1,
    }),
    job: () => ({
      id: 3,
      name: EVIDENCE_JOB,
      status: 'completed',
      conclusion: 'success',
      runtime: RUNNER_NAME,
      inventory: [],
      assertionPassed: null,
    }),
    content: (_revision, _base, inputs) => ({
      integrationTree: TREE,
      relevantInputs: inputs.map((path) => `${path}:${'0'.repeat(64)}`),
    }),
    artifact: () => ({ present: false, expired: false }),
  };
}

interface Harness {
  options: PrepareOptions;
  dependencies: PrepareDependencies;
  state: ExecutionStateStore;
  dispatched: string[][];
  waits: number[];
  prepared: () => Promise<PrepareResult>;
}

async function harness(
  overrides: Partial<PrepareDependencies> = {},
  optionOverrides: Partial<PrepareOptions> = {},
  table: Record<string, RunnerResult> = answers(),
  stateName = 'state',
): Promise<Harness> {
  const state = createExecutionStateStore({
    stateDirectory: join(sandbox, stateName),
    hostId: 'fixture',
  });
  const acquired = await acquireDispatch(state, {
    resource: 'project:p1',
    runId: 'run',
    ownerId: 'linear:run',
  });
  if (!acquired.granted) throw new Error(acquired.reason);
  const dispatched: string[][] = [];
  const waits: number[] = [];
  let observation: unknown[] = [];
  let jobReads = 0;
  const { runner } = runnerOf(table);
  const dependencies: PrepareDependencies = {
    runner,
    repository: REPOSITORY,
    defaultBranch: 'main',
    mainCheckout: sandbox,
    state,
    readAssignments: async () => ({
      assignments: [assignmentFor('COR-1', ['AC1', 'AC2']), assignmentFor('COR-2', ['AC1'])],
      refusals: [],
    }),
    leaseResource: async () => 'project:p1',
    plan: (changed) =>
      computeEvidencePlan(changed, {
        knownSlugs: new Set(),
        paths: new Set(changed),
        read: () => undefined,
        selectUnitTests: () => [],
      }),
    provider: { findRuns: async () => observation as never },
    // The runner of a job is empty until the job starts: the first read finds it queued.
    readJobs: () => [
      { name: EVIDENCE_JOB, runner: jobReads++ === 0 ? '' : RUNNER_NAME, startedAt: 't' },
    ],
    wait: async (milliseconds) => {
      waits.push(milliseconds);
    },
    dispatch: (ref, binding, cwd) => {
      const command = dispatchVerificationRun(
        () => reply('https://github.com/acme/widgets/actions/runs/4242\n'),
        ref,
        binding,
        { cwd },
      ).command;
      dispatched.push(command);
      observation = [{ state: 'pending', id: LANDING_RUN_ID, attempt: 1 }];
      return command;
    },
    ...overrides,
  };
  const options: PrepareOptions = {
    branch: BRANCH,
    head: HEAD,
    worktree: join(sandbox, 'worktree'),
    base: BASE,
    run: 'run',
    project: 'Widgets',
    issues: ['COR-1', 'COR-2'],
    route: 'branch',
    track: true,
    close: true,
    leaveOpen: ['COR-2'],
    waitMinutes: 1,
    ...optionOverrides,
  };
  return {
    options,
    dependencies,
    state,
    dispatched,
    waits,
    prepared: () => prepare(options, dependencies),
  };
}

function checkDependencies(
  setup: Harness,
  command: string[],
  table: Record<string, RunnerResult> = answers(),
  provider: Pick<CiEvidenceProvider, 'findRuns'> = providerFor(command),
): CheckDependencies {
  return {
    runner: runnerOf(table).runner,
    defaultBranch: 'main',
    verification: { state: setup.state, transport: transportFor(), ciProvider: provider },
  };
}

scenarios.describe('prepare', () => {
  scenarios.scenario(
    'writes a request that round-trips through the parser and the verification validators',
    async () => {
      const setup = await harness();
      const result = await setup.prepared();

      expect(result.file.startsWith(join(sandbox, 'tmp/chef/requests'))).toBe(true);
      expect(result.digest).toBe(digest(readFileSync(result.file, 'utf8')));
      expect(result).toMatchObject({ runId: LANDING_RUN_ID, dispatched: true, route: 'branch' });
      expect(result.environment).toBe(RUNNER_NAME);
      // The runner of the evidence job is unknown at dispatch: prepare waited for it, once.
      expect(setup.waits).toEqual([10_000]);
      expect(setup.dispatched).toHaveLength(1);

      const request = readDeliveryRequest(result.file, result.digest);
      expect(request).toMatchObject({
        repository: REPOSITORY,
        revision: HEAD,
        base: BASE,
        integrationTree: TREE,
        environment: RUNNER_NAME,
        authority: { resource: 'project:p1', runId: 'run', ownerId: 'linear:run' },
        worktree: join(sandbox, 'worktree'),
      });
      expect(request.members.map((member) => member.assignment.identity.identifier)).toEqual([
        'COR-1',
        'COR-2',
      ]);
      // Tracked and closed by default; --leave-open keeps one tracked and open.
      expect(request.members.map(({ track, requestedClose }) => [track, requestedClose])).toEqual([
        [true, true],
        [true, false],
      ]);
      for (const member of request.members) {
        expect(member.assignment.allowedConsequentialActions).toContain('merge');
        expect(member.plan.invalidatedBy.assignment).toBe(member.assignment.identity.digest);
        expect(member.plan.obligations.map((item) => item.phase)).toEqual(
          member.assignment.criteria.map(() => 'pre-integration'),
        );
        expect(member.providerRuns.map((item) => item.id)).toEqual(
          member.assignment.criteria.map(() => LANDING_RUN_ID),
        );
      }

      const loaded = loadDeliveryVerification(
        { file: result.file, digest: result.digest, stateDirectory: setup.state.stateDirectory },
        { state: setup.state },
      );
      expect(
        validateDeliveryVerification(
          loaded,
          {
            repository: REPOSITORY,
            revision: HEAD,
            base: BASE,
            integrationTree: TREE,
            route: 'branch',
            action: 'merge',
          },
          { state: setup.state, transport: transportFor() },
        ),
      ).toBeUndefined();
    },
  );

  scenarios.scenario(
    'dispatches the inputs landing binds: the request key, the batch plan digest and the base',
    async () => {
      const setup = await harness();
      const result = await setup.prepared();
      const request = readDeliveryRequest(result.file, result.digest);
      const identity = request.ciEvidence?.[0];

      const inputs = inputsOf(setup.dispatched[0] ?? []);
      expect(setup.dispatched[0]?.slice(0, 6)).toEqual([
        'gh',
        'workflow',
        'run',
        'main.yml',
        '--ref',
        BRANCH,
      ]);
      expect(Object.keys(inputs).toSorted()).toEqual([
        'verification_base',
        'verification_plan',
        'verification_request',
      ]);
      expect(request.ciEvidence).toHaveLength(1);
      expect(identity).toMatchObject({
        event: 'workflow_dispatch',
        workflowPath: '.github/workflows/main.yml',
        workflowRevision: HEAD,
        candidate: HEAD,
        integrationTree: TREE,
      });
      expect(inputs['verification_request']).toBe(identity?.requestKey ?? '');
      expect(inputs['verification_plan']).toBe(batchVerificationPlanDigest(request.members));
      expect(inputs['verification_plan']).toBe(identity?.verificationPlanDigest ?? '');
      expect(inputs['verification_base']).toBe(BASE);

      // landing-evidence binds a run built only from those inputs, and nothing else.
      for (const route of ['branch', 'pull-request'] as const) {
        const routed = await harness({}, { route }, answers(), `state-${route}`);
        const prepared = await routed.prepared();
        const problems = await check(
          {
            file: prepared.file,
            digest: prepared.digest,
            stateDirectory: routed.state.stateDirectory,
          },
          checkDependencies(routed, routed.dispatched[0] ?? []),
        );
        expect(problems).toEqual([]);
      }
    },
  );

  scenarios.scenario(
    'a second prepare for the same head reuses the run and dispatches nothing',
    async () => {
      const setup = await harness();
      const first = await setup.prepared();
      const second = await prepare(setup.options, setup.dependencies);
      expect(setup.dispatched).toHaveLength(1);
      expect(second).toMatchObject({ digest: first.digest, file: first.file, dispatched: false });
    },
  );

  scenarios.scenario(
    'refuses a head that is not the published branch head, or a branch without the base',
    async () => {
      const stale = await harness(
        {},
        {},
        answers({
          [`api repos/${REPOSITORY}/git/ref/heads/${BRANCH}`]: reply(
            JSON.stringify({ object: { sha: 'b'.repeat(40) } }),
          ),
        }),
      );
      expect(String(await rejectionOf(stale.prepared()))).toContain('push the head first');

      const apart = await harness(
        {},
        {},
        answers({ [`rev-parse ${HEAD}^{tree}`]: reply(`${'2'.repeat(40)}\n`) }),
      );
      expect(String(await rejectionOf(apart.prepared()))).toContain('does not contain --base');

      const detached = await harness(
        {},
        {},
        answers({ [`merge-base --is-ancestor ${BASE} ${HEAD}`]: reply('', 1) }),
      );
      expect(String(await rejectionOf(detached.prepared()))).toContain('is not an ancestor');
      for (const refused of [stale, apart, detached]) expect(refused.dispatched).toEqual([]);
    },
  );

  scenarios.scenario(
    'refuses a blocked assignment, or a project the run does not lease, before dispatching',
    async () => {
      const blocked = await harness({
        readAssignments: async () => ({
          assignments: [assignmentFor('COR-1', ['AC1']), assignmentFor('COR-2', ['AC1'])],
          refusals: ['- COR-1: blocked by COR-0'],
        }),
      });
      expect(String(await rejectionOf(blocked.prepared()))).toContain('blocked by COR-0');

      const open = assignmentFor('COR-1', ['AC1']);
      open.dependencies = [{ identifier: 'COR-0', status: 'open' }];
      const dependent = await harness({
        readAssignments: async () => ({
          assignments: [open, assignmentFor('COR-2', ['AC1'])],
          refusals: [],
        }),
      });
      expect(String(await rejectionOf(dependent.prepared()))).toContain('COR-0');

      const unleased = await harness({
        leaseResource: async () => {
          throw new UsageError('run run does not hold a live lease on Widgets');
        },
      });
      expect(String(await rejectionOf(unleased.prepared()))).toContain('live lease');
      for (const refused of [blocked, dependent, unleased]) expect(refused.dispatched).toEqual([]);
    },
  );

  scenarios.scenario(
    'says to run it again, without a second dispatch, when the evidence job has no runner yet',
    async () => {
      const setup = await harness({
        readJobs: () => [{ name: EVIDENCE_JOB, runner: '', startedAt: '' }],
      });
      expect(String(await rejectionOf(setup.prepared()))).toContain('has no runner yet');
      expect(setup.dispatched).toHaveLength(1);
      const again = await prepare(setup.options, {
        ...setup.dependencies,
        provider: { findRuns: async () => [{ state: 'pending', id: LANDING_RUN_ID, attempt: 1 }] },
        readJobs: () => [{ name: EVIDENCE_JOB, runner: RUNNER_NAME, startedAt: 't' }],
      });
      expect(again.dispatched).toBe(false);
      expect(setup.dispatched).toHaveLength(1);
    },
  );

  scenarios.scenario(
    'a retry reuses the saved members, so a Linear edit in between cannot change the key or the run',
    async () => {
      const first = await harness({}, {}, answers(), 'retry');
      // The first attempt dispatches, then gives up: the evidence job never gets a runner.
      const gaveUp = await rejectionOf(
        prepare(first.options, {
          ...first.dependencies,
          readJobs: () => [{ name: EVIDENCE_JOB, runner: '', startedAt: '' }],
        }),
      );
      expect(String(gaveUp)).toContain('has no runner yet');
      expect(first.dispatched).toHaveLength(1);
      // The issue is edited on Linear, so a fresh read would carry a new revision and a new request key.
      let reads = 0;
      const edited = assignmentFor('COR-1', ['AC1', 'AC2']);
      edited.identity.revision = 'edited';
      edited.identity.digest = digest(
        JSON.stringify({ ...edited, identity: { ...edited.identity, digest: undefined } }),
      );
      const retried = await prepare(first.options, {
        ...first.dependencies,
        readAssignments: async () => {
          reads += 1;
          return { assignments: [edited, assignmentFor('COR-2', ['AC1'])], refusals: [] };
        },
        readJobs: () => [{ name: EVIDENCE_JOB, runner: RUNNER_NAME, startedAt: 't' }],
      });
      expect(reads).toBe(0);
      expect(retried.dispatched).toBe(false);
      expect(first.dispatched).toHaveLength(1);
    },
  );

  scenarios.scenario(
    'says which authority is missing when the run holds no local one',
    async () => {
      const setup = await harness({ leaseResource: async () => 'project:other' });
      expect(String(await rejectionOf(setup.prepared()))).toContain(
        'no current local authority for project:other',
      );
      expect(setup.dispatched).toEqual([]);
    },
  );

  scenarios.scenario(
    'refuses a bound run that already failed: the same head cannot be dispatched twice',
    async () => {
      const setup = await harness({
        provider: { findRuns: async () => [{ state: 'failed', id: LANDING_RUN_ID, attempt: 1 }] },
      });
      expect(String(await rejectionOf(setup.prepared()))).toContain('push a new head');
      expect(setup.dispatched).toEqual([]);
    },
  );
});

scenarios.describe('check', () => {
  scenarios.scenario(
    'refuses a run no dispatch bound, naming each validator that refuses',
    async () => {
      const setup = await harness();
      const result = await setup.prepared();
      const unbound = await check(
        { file: result.file, digest: result.digest, stateDirectory: setup.state.stateDirectory },
        checkDependencies(setup, [], answers(), { findRuns: async () => [] }),
      );
      expect(unbound).toContain(
        'CI evidence for run 4242 is missing its successful aggregate or required job',
      );
      expect(
        unbound.some((problem) => problem.includes('not one finished authenticated run')),
      ).toBe(true);

      // A run that carries another plan digest than the one the request pinned.
      const command = [...(setup.dispatched[0] ?? [])];
      const staleIndex = command.findIndex((word) => word.startsWith('verification_plan='));
      command[staleIndex] = `verification_plan=${'f'.repeat(64)}`;
      const stale = await check(
        { file: result.file, digest: result.digest, stateDirectory: setup.state.stateDirectory },
        checkDependencies(setup, command),
      );
      expect(stale.some((problem) => problem.includes('carries evidence digest'))).toBe(true);
    },
  );

  scenarios.scenario(
    'refuses a red run, whether the provider reports it failed or the head lists it red',
    async () => {
      const setup = await harness();
      const result = await setup.prepared();
      const failed = await check(
        { file: result.file, digest: result.digest, stateDirectory: setup.state.stateDirectory },
        checkDependencies(setup, [], answers(), {
          findRuns: async () => [{ state: 'failed', id: LANDING_RUN_ID, attempt: 1 }],
        }),
      );
      expect(failed.length).toBeGreaterThan(0);
      expect(failed.some((problem) => problem.includes('not one finished authenticated run'))).toBe(
        true,
      );

      const red = await check(
        { file: result.file, digest: result.digest, stateDirectory: setup.state.stateDirectory },
        checkDependencies(
          setup,
          setup.dispatched[0] ?? [],
          answers({
            ...runsAnswer(REPOSITORY, HEAD, [{ head_sha: HEAD, conclusion: 'failure' }]),
            ...jobsAnswer(REPOSITORY, LANDING_RUN_ID, 'failure'),
          }),
        ),
      );
      expect(red.some((problem) => problem.includes('is red'))).toBe(true);
    },
  );

  scenarios.scenario(
    'refuses a head that is not the request head, a moved base, and a wrong digest',
    async () => {
      const setup = await harness();
      const result = await setup.prepared();
      const base = { file: result.file, stateDirectory: setup.state.stateDirectory };
      const moved = await check(
        { ...base, digest: result.digest },
        checkDependencies(
          setup,
          setup.dispatched[0] ?? [],
          answers({
            'rev-parse refs/remotes/origin/main^{commit}': reply(`${'d'.repeat(40)}\n`),
            [`merge-tree --write-tree ${'d'.repeat(40)} ${HEAD}`]: reply(`${TREE}\n`),
          }),
        ),
      );
      expect(moved).toContain('verification request has a stale base');

      const elsewhere = await check(
        { ...base, digest: result.digest, head: 'b'.repeat(40) },
        checkDependencies(
          setup,
          setup.dispatched[0] ?? [],
          answers({ [`merge-tree --write-tree ${BASE} ${'b'.repeat(40)}`]: reply(`${TREE}\n`) }),
        ),
      );
      expect(elsewhere).toContain('verification request has a stale reviewed head');

      const wrong = await check(
        { ...base, digest: '0'.repeat(64) },
        checkDependencies(setup, setup.dispatched[0] ?? []),
      );
      expect(wrong[0]).toContain('does not load');
    },
  );
});

scenarios.describe('the real branch merge', () => {
  /** `directMerge` of a freshly prepared request, with the run the provider reports for `bound`. */
  async function landPrepared(bound: boolean) {
    const setup = await harness({}, {}, answers(), bound ? 'state-bound' : 'state-unbound');
    const result = await setup.prepared();
    // The landing queue reads the worktree's workspaces from its manifest.
    writeFileSync(
      join(setup.options.worktree, 'package.json'),
      JSON.stringify({ name: 'widgets', workspaces: [] }),
    );
    const configPath = join(sandbox, 'repository.json');
    writeFileSync(
      configPath,
      JSON.stringify({
        repository: REPOSITORY,
        defaultBranch: 'main',
        worktreeRoots: { claude: '/c', codex: '/x' },
        manifestName: 'widgets',
        installCommand: 'install-command',
        gateCommand: 'true',
        affectedCheckCommand: 'true',
        mergeMethod: 'squash',
      }),
    );
    const provider: Pick<CiEvidenceProvider, 'findRuns'> = bound
      ? providerFor(setup.dispatched[0] ?? [])
      : { findRuns: async () => [] };
    {
      const world = branchRunner(sandbox, {
        [`diff -z --name-only --diff-filter=d ${BASE}...${HEAD}`]: reply('a.ts\0'),
        // main has not moved since the head's merge base: the landing queue has nothing to classify.
        [`rev-parse --verify ${HEAD}^{commit}`]: reply(`${HEAD}\n`),
        [`rev-parse --verify ${BASE}^{commit}`]: reply(`${BASE}\n`),
        [`rev-list --reverse ${BASE}..${BASE}`]: reply(''),
      });
      writeFileSync(world.messageFile, 'COR-1: Add widgets\n');
      return directMerge(
        {
          configPath,
          branch: BRANCH,
          head: HEAD,
          messageFile: world.messageFile,
          intended: [],
          worktree: setup.options.worktree,
          verification: {
            file: result.file,
            digest: result.digest,
            stateDirectory: setup.state.stateDirectory,
          },
        },
        {
          runner: world.runner,
          guards: () => ({ ok: true, failures: [] }),
          evidencePlan: setup.dependencies.plan,
          verification: { state: setup.state, transport: transportFor(), ciProvider: provider },
        },
      );
    }
  }

  scenarios.scenario('accepts a prepared request at the verification steps', async () => {
    const landed = await landPrepared(true);
    expect(landed).toMatchObject({ failedStep: null, merged: true });
  });

  scenarios.scenario(
    'refuses the same request when no run carries its dispatched inputs',
    async () => {
      const refused = await landPrepared(false);
      expect(refused.failedStep).toBe('verification');
    },
  );
});

scenarios.describe('the command line and the workflow it binds', () => {
  scenarios.scenario(
    'main.yml names the evidence job and takes the three inputs and the run name the binding uses',
    () => {
      const workflow = readFileSync(
        join(import.meta.dirname, '..', '..', '.github/workflows/main.yml'),
        'utf8',
      );
      expect(workflow).toContain(`    name: ${EVIDENCE_JOB}\n`);
      for (const input of ['verification_request', 'verification_plan', 'verification_base'])
        expect(workflow).toContain(`      ${input}:\n`);
      expect(workflow).toContain("format('P07 {0}', inputs.verification_request)");
    },
  );

  scenarios.scenario(
    'a refusal exits 1 with its reason, and a bad flag is a usage error',
    async () => {
      const setup = await harness({
        leaseResource: async () => {
          throw new UsageError('run run does not hold a live lease on Widgets');
        },
      });
      const flags = [
        'prepare',
        '--branch',
        BRANCH,
        '--head',
        HEAD,
        '--worktree',
        setup.options.worktree,
        '--base',
        BASE,
        '--run',
        'run',
        '--project',
        'Widgets',
        '--issue',
        'COR-1',
        '--issue',
        'COR-2',
      ];
      const refused = await run(flags, { prepare: setup.dependencies });
      expect(refused.code).toBe(1);
      expect(refused.output).toContain('REFUSED: run run does not hold a live lease');
      const asJson = await run([...flags, '--json'], { prepare: setup.dependencies });
      expect(JSON.parse(asJson.output)).toMatchObject({ ok: false });
      expect(String(await rejectionOf(run([...flags, '--route', 'tag'])))).toContain('--route');
    },
  );

  scenarios.scenario('prints usage, and refuses a missing subcommand or member', async () => {
    const help = await run(['--help']);
    expect(help.output).toContain('delivery-request.ts prepare');
    expect(String(await rejectionOf(run([])))).toContain('subcommand');
    expect(
      String(
        await rejectionOf(
          run([
            'prepare',
            '--branch',
            BRANCH,
            '--head',
            HEAD,
            '--worktree',
            sandbox,
            '--base',
            BASE,
            '--run',
            'run',
            '--project',
            'Widgets',
          ]),
        ),
      ),
    ).toContain('--issue is required');
  });
});

await scenarios.settled();
