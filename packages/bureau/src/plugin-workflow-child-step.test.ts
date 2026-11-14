/**
 * COR-2246 — a workflow file's `workflow` step starts a plugin's code workflow as a child and
 * continues with its result. The revision Bureau registers pins the child's version in
 * `workflowVersions`, as it pins an activity in `activityVersions`; a run that waits across an
 * upgrade is reported `version-mismatch` (or `missing`) and never resumed on another version; and a
 * new file may not call an activity that defines `compensate` while a revision already registered
 * keeps its runs.
 *
 * The rows are the outcome matrix's F (the grammar), G (running a step), H (recovery) and I
 * (`compensate` against work already registered).
 */
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { definePlugin, type PluginWorkflow } from '@lostgradient/interborough-plugin';
import { MemoryStorage } from '@lostgradient/storage';
import { throwingRejectionOf } from '@lostgradient/testing/promise-outcome';
import { waitUntil } from '@lostgradient/testing/wait-until';
import { Engine, workflow } from '@lostgradient/weft';
import { afterEach, describe, expect, it } from 'bun:test';
import { z } from 'zod';

import { createSqliteStorageFixture } from './test/storage-fixtures';
import {
  startWorkflowBureau,
  type WorkflowBureauHarness,
} from './testing/workflow-bureau.test-support';
import { workflowFileText } from './testing/workflow-file-fixtures.test-support';
import { listedPlugins } from './testing/plugin-listing.test-support';
import { PluginNeedsSetupError, gatedContributions } from './plugins/plugin-secret-gate';
import { createVersionedCatalog } from './versioned-catalog';
import { NO_WORKFLOW_CONTRIBUTIONS } from './workflow-contributions';
import {
  createWorkflowDocumentHost,
  registerBureauWorkflowDocuments,
  workflowCatalogOf,
} from './workflow-host';

type DurableEngine = NonNullable<ReturnType<WorkflowBureauHarness['bureau']['durableEngine']>>;

const cleanups: Array<() => Promise<void>> = [];
afterEach(async () => {
  for (const cleanup of cleanups.splice(0).toReversed()) await cleanup();
});

/** `kit:echo` completes with the envelope it was started with. */
const echo = (): PluginWorkflow => ({
  ...workflow({ name: 'echo' }).execute(async function* (_context, input: unknown) {
    yield* [];
    return input;
  }),
  title: 'Echo',
  inputSchema: z.unknown(),
});

/** `kit:wait` parks on the signal `go`, then completes with `went`. */
const wait = (): PluginWorkflow => ({
  ...workflow({ name: 'wait' }).execute(async function* (context) {
    yield* context.waitForSignal('go');
    return 'went';
  }),
  title: 'Wait',
  inputSchema: z.unknown(),
});

/** `kit:boom` fails. */
const boom = (): PluginWorkflow => ({
  ...workflow({ name: 'boom' }).execute(async function* () {
    yield* [];
    throw new Error('kit boom exploded');
  }),
  title: 'Boom',
  inputSchema: z.unknown(),
});

function kit(workflows: readonly PluginWorkflow[], version = '1.0.0') {
  return {
    descriptor: definePlugin({
      name: 'kit',
      version,
      description: 'Contributes code workflows.',
      setup: () => ({ workflows }),
    }),
    source: 'package' as const,
    location: '@example/kit',
  };
}

const file = (steps: readonly unknown[], extra: Record<string, unknown> = {}) =>
  workflowFileText('pipeline', { trigger: { kind: 'schedule', spec: '1h' }, steps, ...extra });
const callWait = { kind: 'workflow', workflow: 'kit:wait' };

async function started(plugins: ReturnType<typeof kit>[]) {
  const harness = await startWorkflowBureau({
    overrides: { plugins, onDiagnostic: () => undefined },
  });
  cleanups.push(() => harness.dispose());
  return harness;
}

function listing(harness: WorkflowBureauHarness, id = 'pipeline') {
  return harness.bureau.workflows!.list().find((entry) => entry.id === id);
}

async function storedDocument(harness: WorkflowBureauHarness, id = 'pipeline') {
  const kv = harness.bureau.internals.kv!;
  const keys = await kv.list(`bureau-workflow-snapshot:v1:${id}:`);
  const stored = await Promise.all(
    keys.map(async (key) => JSON.parse((await kv.get(key)) ?? '{}')),
  );
  return stored.map((record) => record.document);
}

/** The runs of `type` the engine holds. */
async function runsOf(engine: DurableEngine, type: string) {
  const page = await engine.list({ type, limit: 10 });
  return page.items;
}

/** Whether the engine holds exactly `count` runs of `kit:wait`, the children the tests start. */
async function waitChildren(engine: DurableEngine, count: number): Promise<boolean> {
  const children = await runsOf(engine, 'kit__wait');
  return children.length === count;
}

async function isParkedOn(engine: DurableEngine, id: string, name: string): Promise<boolean> {
  const state = await engine.get(id);
  return state?.waitingForSignals?.includes(name) === true;
}

describe('a file with a workflow step (F1, F2, F3, F4, F5, F6, F7, F10)', () => {
  it('is valid for a loaded plugin code workflow, and its revision pins the loaded version (F1)', async () => {
    const harness = await started([kit([echo()])]);
    await harness.put(
      'pipeline.json',
      file([{ kind: 'workflow', workflow: 'kit:echo', input: 1 }]),
    );
    await harness.bureau.workflows?.refresh();
    expect(listing(harness)?.state).toBe('ready');
    const [document] = await storedDocument(harness);
    expect(document.workflowVersions).toEqual({ 'kit:echo': '1.0.0' });
    expect(document.steps[0].workflow).toBe('kit:echo');
    expect(document.activityVersions).toBeUndefined();
  });

  const REFUSED: readonly [string, string][] = [
    ['an unknown workflow (F2)', 'kit:nobody'],
    ['a bare unknown name (F2)', 'nobody'],
    ['a plugin code workflow whose plugin is not loaded (F2)', 'gone:echo'],
    ['the name of a workflow file (F3)', 'other'],
    ['the name of a host code workflow (F4)', 'hostflow'],
    ['a name that holds the plugin separator (F5)', 'kit__echo'],
    ['a malformed name (F5)', 'not a name'],
  ];
  for (const [name, target] of REFUSED) {
    it(`refuses ${name}, at steps[0].workflow`, async () => {
      const harness = await started([kit([echo()])]);
      // The composition's engine type hides `register`; it is the one Weft `Engine`.
      (harness.bureau.durableEngine() as unknown as Engine).register(
        workflow({ name: 'hostflow' }).execute(async function* () {
          yield* [];
          return null;
        }),
      );
      await harness.put(
        'other.json',
        workflowFileText('other', { trigger: { kind: 'schedule', spec: '1h' } }),
      );
      await harness.put('pipeline.json', file([{ kind: 'workflow', workflow: target }]));
      await harness.bureau.workflows?.refresh();
      expect(listing(harness, 'other')?.state).toBe('ready');
      const entry = listing(harness);
      expect(entry?.state).toBe('invalid');
      expect(entry?.problem?.message).toContain('steps[0].workflow');
    });
  }

  it('pins the version a child declares, not its plugin’s (O4)', async () => {
    const harness = await started([kit([{ ...echo(), version: '7' }], '1.0.0')]);
    await harness.put('pipeline.json', file([{ kind: 'workflow', workflow: 'kit:echo' }]));
    await harness.bureau.workflows?.refresh();
    expect(listing(harness)?.state).toBe('ready');
    const [document] = await storedDocument(harness);
    expect(document.workflowVersions).toEqual({ 'kit:echo': '7' });
  });

  it('pins a child nested in a branch, a map and a parallel step (F6)', async () => {
    const harness = await started([kit([echo(), wait()])]);
    await harness.put(
      'pipeline.json',
      file([
        {
          kind: 'branch',
          on: 'status',
          cases: { ready: [{ kind: 'workflow', workflow: 'kit:echo' }] },
          otherwise: [
            { kind: 'map', over: 'items', steps: [{ kind: 'workflow', workflow: 'kit:wait' }] },
          ],
        },
        { kind: 'parallel', branches: { a: [{ kind: 'workflow', workflow: 'kit:echo' }] } },
      ]),
    );
    await harness.bureau.workflows?.refresh();
    expect(listing(harness)?.state).toBe('ready');
    const [document] = await storedDocument(harness);
    expect(document.workflowVersions).toEqual({ 'kit:echo': '1.0.0', 'kit:wait': '1.0.0' });
  });

  it('refuses a file that pins a workflow version itself (F7)', async () => {
    const harness = await started([kit([echo()])]);
    await harness.put(
      'pipeline.json',
      file([{ kind: 'workflow', workflow: 'kit:echo' }], {
        workflowVersions: { 'kit:echo': '1.0.0' },
      }),
    );
    await harness.bureau.workflows?.refresh();
    expect(listing(harness)?.state).toBe('invalid');
    expect(listing(harness)?.problem?.message).toContain('does not pin workflow versions');
  });

  it('is another revision when the child is loaded at another version (F10)', async () => {
    const first = await started([kit([echo()], '1.0.0')]);
    await first.putWorkflow('pipeline', {
      trigger: { kind: 'schedule', spec: '1h' },
      steps: [{ kind: 'workflow', workflow: 'kit:echo' }],
    });
    const second = await started([kit([echo()], '2.0.0')]);
    await second.putWorkflow('pipeline', {
      trigger: { kind: 'schedule', spec: '1h' },
      steps: [{ kind: 'workflow', workflow: 'kit:echo' }],
    });
    expect(listing(first)?.version).not.toBe(listing(second)?.version);
  });

  it('lists the workflow step in the editor catalog (F15)', () => {
    const host = createWorkflowDocumentHost({
      runAgentStep: async () => {
        throw new Error('no agent step runs here');
      },
    });
    const kind = workflowCatalogOf(host, NO_WORKFLOW_CONTRIBUTIONS).stepKinds.find(
      (entry) => entry.kind === 'workflow',
    );
    expect(Object.keys(kind?.fields ?? {})).toEqual(['workflow', 'input']);
  });
});

/** The run `id`, once it has settled. */
async function settled(harness: WorkflowBureauHarness, runId: string) {
  await waitUntil(
    async () => {
      const run = await harness.bureau.workflows!.getRun(runId);
      return run !== undefined && ['completed', 'failed', 'cancelled'].includes(run.status);
    },
    { message: `run ${runId} to settle` },
  );
  return (await harness.bureau.workflows!.getRun(runId))!;
}

describe('running a workflow step (G1, G2, G3, G6, O6)', () => {
  it('starts the child on the file envelope with the step input and continues with its result (G1)', async () => {
    const harness = await started([kit([echo()])]);
    await harness.put(
      'pipeline.json',
      file([{ kind: 'workflow', workflow: 'kit:echo', input: { team: 'core' } }]),
    );
    await harness.bureau.workflows?.refresh();
    const { runId } = await harness.bureau.workflows!.start('pipeline', {
      owner: 'anonymous:local',
      input: { ignored: 'by the child' },
    });
    const run = await settled(harness, runId);
    expect(run.status).toBe('completed');
    // The child's envelope, exactly: the step's input and the parent's origin; no trigger, no previous.
    expect(run.result).toEqual({
      kind: 'manual',
      input: { team: 'core' },
      origin: { kind: 'person', principal: 'anonymous:local', surface: 'api' },
    });
    // The child is a run of the code workflow, readable in the run shape.
    const { runs } = await harness.bureau.workflows!.listRuns({
      workflow: 'kit:echo',
      offset: 0,
      limit: 10,
    });
    expect(runs).toHaveLength(1);
  });

  it('gives the child a null input when the step has none, and a parent origin for a start with none (O6)', async () => {
    const harness = await started([kit([echo()])]);
    await harness.put('pipeline.json', file([{ kind: 'workflow', workflow: 'kit:echo' }]));
    await harness.bureau.workflows?.refresh();
    const engine = harness.bureau.durableEngine()!;
    await engine.start('pipeline', null, { id: 'raw-parent' });
    const run = await settled(harness, 'raw-parent');
    expect(run.result).toEqual({
      kind: 'manual',
      input: null,
      origin: { kind: 'parent', parentRunId: 'raw-parent' },
    });
  });

  it('starts a child whose schema has a default on the step input, leaving the envelope to the child (G9, G10)', async () => {
    // The demo plugin's `demo:echo-input`: a schema with a default, and a body that reads
    // `envelope.input`. The engine does not parse the envelope against `inputSchema`.
    const greet: PluginWorkflow = {
      ...workflow({ name: 'greet' }).execute(async function* (
        _context,
        envelope: { readonly input?: { readonly message?: string } },
      ) {
        yield* [];
        return { message: envelope.input?.message ?? 'hello' };
      }),
      title: 'Greet',
      inputSchema: z.object({ message: z.string().default('hello') }),
    };
    const harness = await started([kit([greet])]);
    await harness.put(
      'pipeline.json',
      file([{ kind: 'workflow', workflow: 'kit:greet', input: { message: 'hi' } }]),
    );
    await harness.bureau.workflows?.refresh();
    const { runId } = await harness.bureau.workflows!.start('pipeline', {
      owner: 'anonymous:local',
    });
    const run = await settled(harness, runId);
    expect(run).toMatchObject({ status: 'completed', result: { message: 'hi' } });
  });

  it('runs a child with the step input its inputSchema would refuse, as today (G10)', async () => {
    // Bureau checks `inputSchema` for a start it makes (a top-level start of the code workflow),
    // and the engine does not check it at child start, so a step input is the child's to judge.
    const strict: PluginWorkflow = {
      ...workflow({ name: 'strict' }).execute(async function* (_context, envelope: unknown) {
        yield* [];
        return envelope;
      }),
      title: 'Strict',
      inputSchema: z.object({ team: z.string() }),
    };
    const harness = await started([kit([strict])]);
    await harness.put(
      'pipeline.json',
      file([{ kind: 'workflow', workflow: 'kit:strict', input: { team: 3 } }]),
    );
    await harness.bureau.workflows?.refresh();
    const { runId } = await harness.bureau.workflows!.start('pipeline', {
      owner: 'anonymous:local',
    });
    const run = await settled(harness, runId);
    expect(run).toMatchObject({ status: 'completed', result: { input: { team: 3 } } });
  });

  it('fails the step, and the run, when the child fails (G2)', async () => {
    const harness = await started([kit([boom()])]);
    await harness.put(
      'pipeline.json',
      file([
        { kind: 'workflow', workflow: 'kit:boom' },
        { kind: 'activity', handler: 'agent', input: { agent: 'writer', message: 'never' } },
      ]),
    );
    await harness.bureau.workflows?.refresh();
    const { runId } = await harness.bureau.workflows!.start('pipeline', {
      owner: 'anonymous:local',
    });
    const run = await settled(harness, runId);
    expect(run.status).toBe('failed');
    expect(run.error).toContain('kit boom exploded');
    expect(harness.calls).toEqual([]);
  });

  it('waits for a child that parks, and continues when it is signalled (G3)', async () => {
    const harness = await started([kit([wait()])]);
    await harness.put('pipeline.json', file([callWait]));
    await harness.bureau.workflows?.refresh();
    const engine = harness.bureau.durableEngine()!;
    const { runId } = await harness.bureau.workflows!.start('pipeline', {
      owner: 'anonymous:local',
    });
    await waitUntil(async () => waitChildren(engine, 1), { message: 'the child to start' });
    const [child] = await runsOf(engine, 'kit__wait');
    const parent = await harness.bureau.workflows!.getRun(runId);
    expect(parent?.status).toBe('running');
    await engine.signal(child!.id, 'go', null);
    const run = await settled(harness, runId);
    expect(run).toMatchObject({ status: 'completed', result: 'went' });
  });

  it('starts one child for each of two runs of one file (G6)', async () => {
    const harness = await started([kit([echo()])]);
    await harness.put('pipeline.json', file([{ kind: 'workflow', workflow: 'kit:echo' }]));
    await harness.bureau.workflows?.refresh();
    const engine = harness.bureau.durableEngine()!;
    const runs = ['first-run', 'second-run'];
    for (const id of runs) await engine.start('pipeline', null, { id });
    for (const id of runs) {
      const run = await settled(harness, id);
      expect(run.status).toBe('completed');
    }
    expect(await runsOf(engine, 'kit__echo')).toHaveLength(2);
  });
});

describe('the child envelope and the authority check (O6, O13)', () => {
  const authority = {
    version: 1,
    workspaceId: 'workspace-a',
    actorId: 'actor-a',
    authorizingOwner: 'owner-a',
    membershipRevision: 'revision-a',
  };
  const argument = (trigger: unknown) => ({
    workflow: 'kit__echo',
    workflowId: 'parent-run',
    trigger,
    input: { team: 'core' },
    step: 0,
    stepAddress: '0',
  });
  const host = (admitActivity?: () => Promise<void>) =>
    createWorkflowDocumentHost({
      runAgentStep: async () => {
        throw new Error('no agent step runs here');
      },
      ...(admitActivity === undefined ? {} : { admitActivity }),
      contributions: { ...NO_WORKFLOW_CONTRIBUTIONS, workflowVersions: { kit__echo: '1' } },
    });

  it('carries the parent origin and workspace authority, and nothing else of the trigger', () => {
    const origin = { kind: 'person', principal: 'someone', surface: 'web' };
    expect(
      host().childInput?.(
        argument({
          kind: 'manual',
          input: 'secret of the parent',
          origin,
          workspaceAuthority: authority,
          authorityHold: 'resuming',
        }),
      ),
    ).toEqual({ kind: 'manual', input: { team: 'core' }, origin, workspaceAuthority: authority });
  });

  it('does not carry a workspace authority the parent does not hold, or one that is not valid', () => {
    const origin = { kind: 'api' };
    expect(host().childInput?.(argument({ kind: 'manual', origin }))).toEqual({
      kind: 'manual',
      input: { team: 'core' },
      origin,
    });
    expect(
      host().childInput?.(argument({ kind: 'manual', origin, workspaceAuthority: { actorId: 1 } })),
    ).toEqual({ kind: 'manual', input: { team: 'core' }, origin });
  });

  async function runWith(admit: (() => Promise<void>) | undefined) {
    const engine = new Engine({ storage: new MemoryStorage(), backgroundTasks: 'manual' });
    cleanups.push(async () => engine[Symbol.asyncDispose]());
    engine.register(
      workflow({ name: 'kit__echo', version: '1' }).execute(async function* (_context, input) {
        yield* [];
        return input;
      }),
    );
    const admitting = host(admit);
    await registerBureauWorkflowDocuments(engine, admitting, {
      active: [
        {
          name: 'parent',
          trigger: { kind: 'manual' },
          steps: [{ kind: 'workflow', workflow: 'kit:echo' }],
          workflowVersions: { 'kit:echo': '1' },
        },
      ],
    });
    return { engine, run: await engine.start('parent', null, { id: 'parent-run' }) };
  }

  it('runs the same authority check an activity callback does before the child starts (O13)', async () => {
    let admissions = 0;
    const { engine, run } = await runWith(async () => {
      admissions += 1;
    });
    expect(await run.result()).toMatchObject({ kind: 'manual', input: null });
    expect(admissions).toBe(1);
    expect(await runsOf(engine, 'kit__echo')).toHaveLength(1);
  });

  it('refuses the step, and starts no child, when the check refuses (O13)', async () => {
    const { engine, run } = await runWith(async () => {
      throw new Error('workspace authority revoked');
    });
    expect(await throwingRejectionOf(run.result())).toThrow('workspace authority revoked');
    expect(await runsOf(engine, 'kit__echo')).toEqual([]);
  });
});

/** A store and a workflow directory that outlive the Bureaus started over them. */
async function storeAndFiles() {
  const root = await mkdtemp(join(tmpdir(), 'bureau-child-step-restart-'));
  cleanups.push(() => rm(root, { recursive: true, force: true }));
  const database = createSqliteStorageFixture({ path: join(root, 'bureau.sqlite') });
  cleanups.push(() => database.dispose());
  const directory = join(root, 'workflows');
  const bureauOver = async (version: string | undefined) => {
    const harness = await startWorkflowBureau({
      directory,
      overrides: {
        get storage() {
          return database.open();
        },
        durableOwnership: { ownership: 'none' },
        onDiagnostic: () => undefined,
        ...(version === undefined ? {} : { plugins: [kit([echo(), wait()], version)] }),
      },
    });
    cleanups.push(() => harness.dispose());
    return harness;
  };
  return { bureauOver };
}

async function waitsForGo(engine: DurableEngine, id: string): Promise<boolean> {
  return isParkedOn(engine, id, 'go');
}

/** Park a run of `pipeline` at its first step, then close the Bureau; `parked` says where it waits. */
async function parkedAtOne(
  bureauOver: Awaited<ReturnType<typeof storeAndFiles>>['bureauOver'],
  text = file([callWait]),
  parked: 'child' | 'parent' = 'child',
): Promise<void> {
  const first = await bureauOver('1.0.0');
  await first.put('pipeline.json', text);
  await first.bureau.workflows?.refresh();
  const engine = first.bureau.durableEngine()!;
  await engine.start('pipeline', null, { id: 'waiting' });
  await waitUntil(
    async () => (parked === 'parent' ? waitsForGo(engine, 'waiting') : waitChildren(engine, 1)),
    { message: 'the run to wait' },
  );
  await first.dispose();
}

describe('a run waiting across a restart, on a revision that pins kit:wait@1.0.0 (H1, H2, H3, H5, H6, H7, H9)', () => {
  it('resumes on the pinned version, with the one child it started (H1)', async () => {
    const { bureauOver } = await storeAndFiles();
    await parkedAtOne(bureauOver);

    const second = await bureauOver('1.0.0');
    const engine = second.bureau.durableEngine()!;
    await waitUntil(async () => waitChildren(engine, 1), {
      message: 'the child to be recovered',
    });
    const [child] = await runsOf(engine, 'kit__wait');
    await waitUntil(async () => waitsForGo(engine, child!.id), { message: 'the child to wait' });
    await engine.signal(child!.id, 'go', null);
    const run = await settled(second, 'waiting');
    expect(run).toMatchObject({ status: 'completed', result: 'went' });
    expect(run.unresumable).toBeUndefined();
    expect(await runsOf(engine, 'kit__wait')).toHaveLength(1);
  });

  it('is reported version-mismatch, and never resumed on 2.0.0, when only 2.0.0 is loaded (H2)', async () => {
    const { bureauOver } = await storeAndFiles();
    await parkedAtOne(bureauOver);

    const second = await bureauOver('2.0.0');
    const run = await second.bureau.workflows?.getRun('waiting');
    expect(run?.status).toBe('cancelled');
    expect(run?.unresumable).toEqual({
      reason: 'version-mismatch',
      workflow: 'kit:wait@1.0.0',
      availableVersions: ['2.0.0'],
    });
    expect(run?.error).toContain('kit:wait@1.0.0');
    expect(listing(second)?.state).toBe('ready');
  });

  it('is reported missing when its plugin is not loaded (H3)', async () => {
    const { bureauOver } = await storeAndFiles();
    await parkedAtOne(bureauOver);

    const second = await bureauOver(undefined);
    const run = await second.bureau.workflows?.getRun('waiting');
    expect(run?.status).toBe('cancelled');
    expect(run?.unresumable).toEqual({
      reason: 'missing',
      workflow: 'kit:wait@1.0.0',
      availableVersions: [],
    });
    expect(listing(second)?.state).toBe('invalid');
  });

  it('is reported version-mismatch when parked before the step, because the revision pins every child it calls (H5)', async () => {
    const { bureauOver } = await storeAndFiles();
    await parkedAtOne(
      bureauOver,
      file([{ kind: 'await-signal', signal: 'go' }, callWait]),
      'parent',
    );

    const second = await bureauOver('2.0.0');
    const run = await second.bureau.workflows?.getRun('waiting');
    expect(run?.status).toBe('cancelled');
    expect(run?.unresumable?.reason).toBe('version-mismatch');
    expect(run?.unresumable?.workflow).toBe('kit:wait@1.0.0');
  });

  it('is reported version-mismatch when the file is gone and only 2.0.0 is loaded (H7)', async () => {
    const { bureauOver } = await storeAndFiles();
    await parkedAtOne(bureauOver);
    const first = await bureauOver('1.0.0');
    await rm(join(first.directory, 'pipeline.json'));
    await first.dispose();

    const second = await bureauOver('2.0.0');
    const run = await second.bureau.workflows?.getRun('waiting');
    expect(run?.unresumable?.reason).toBe('version-mismatch');
  });

  it('is reported on plugin kit as pinned-version-unavailable when kit loads only 2.0.0 (H9)', async () => {
    const { bureauOver } = await storeAndFiles();
    await parkedAtOne(bureauOver);

    const second = await bureauOver('2.0.0');
    const [kitListing] = await listedPlugins(second.bureau);
    expect(kitListing?.problems).toEqual([
      { code: 'pinned-version-unavailable', id: 'kit:wait', version: '1.0.0', waitingRuns: 1 },
    ]);
  });

  it('starts a new run on the version loaded now, as a new revision, when the file is unchanged (H6)', async () => {
    const { bureauOver } = await storeAndFiles();
    await parkedAtOne(bureauOver);
    const first = await bureauOver('1.0.0');
    const before = listing(first)?.version;
    await first.dispose();

    const second = await bureauOver('2.0.0');
    expect(listing(second)?.version).not.toBe(before);
    const documents = await storedDocument(second);
    const [newest] = documents.filter(
      (document) => document.workflowVersions?.['kit:wait'] === '2.0.0',
    );
    expect(newest.workflowVersions).toEqual({ 'kit:wait': '2.0.0' });
    const engine = second.bureau.durableEngine()!;
    await engine.start('pipeline', null, { id: 'fresh' });
    // The child the first run left behind stays at 1.0.0; the new run's child is at 2.0.0.
    await waitUntil(
      async () => {
        const children = await runsOf(engine, 'kit__wait');
        return children.some((child) => child.version === '2.0.0');
      },
      { message: 'the new run to start its child' },
    );
  });
});

describe('a file that calls an activity that defines compensate (F12, F14, I1, O14)', () => {
  const contributed = (compensate: boolean, version: string) => ({
    descriptor: definePlugin({
      name: 'x',
      version,
      description: 'Contributes y.',
      setup: () => ({
        activities: [
          {
            name: 'y',
            version,
            title: 'Y',
            inputSchema: z.unknown(),
            execute: () => 'done',
            ...(compensate ? { compensate: () => undefined } : {}),
          },
        ],
      }),
    }),
    source: 'package' as const,
    location: '@example/x',
  });
  const callY = { kind: 'activity', handler: 'x:y', input: 'hello' };

  it('refuses the file at the step handler when its activity defines compensate (F12)', async () => {
    const harness = await started([contributed(true, '1')]);
    await harness.put('pipeline.json', file([callY]));
    await harness.bureau.workflows?.refresh();
    expect(listing(harness)?.state).toBe('invalid');
    expect(listing(harness)?.problem?.message).toContain('steps[0].handler');
    expect(listing(harness)?.problem?.message).toContain('defines "compensate"');
  });

  it('accepts the file when the activity defines none', async () => {
    const harness = await started([contributed(false, '1')]);
    await harness.put('pipeline.json', file([callY]));
    await harness.bureau.workflows?.refresh();
    expect(listing(harness)?.state).toBe('ready');
  });

  describe('a gated activity of a plugin that needs setup (F14)', () => {
    const needsSetup = {
      plugin: 'x',
      missing: () => ['token'],
      available: () => false,
      assertAvailable: (contribution: string) => {
        throw new PluginNeedsSetupError('x', contribution, ['token']);
      },
      onChange: () => () => undefined,
      watch: () => () => undefined,
    };
    const gatedHarness = async (compensate: boolean) => {
      const gated = gatedContributions(
        {
          activities: [
            {
              name: 'y',
              title: 'Y',
              inputSchema: z.unknown(),
              execute: () => 'done',
              ...(compensate ? { compensate: () => undefined } : {}),
            },
          ],
        },
        needsSetup,
        (name) => `x:${name}`,
      );
      const catalog = createVersionedCatalog();
      catalog.register({
        kind: 'activity',
        name: 'x:y',
        value: gated.activities[0],
        source: { name: 'x', version: '1' },
      });
      const harness = await startWorkflowBureau({
        overrides: { contributionCatalog: catalog, onDiagnostic: () => undefined },
      });
      cleanups.push(() => harness.dispose());
      await harness.put('pipeline.json', file([callY]));
      await harness.bureau.workflows?.refresh();
      return harness;
    };

    it('is refused when it defines compensate, which gating keeps', async () => {
      const harness = await gatedHarness(true);
      expect(listing(harness)?.state).toBe('invalid');
      expect(listing(harness)?.problem?.message).toContain('steps[0].handler');
    });

    it('is accepted when it defines none, because gating adds none', async () => {
      const harness = await gatedHarness(false);
      expect(listing(harness)?.state).toBe('ready');
    });
  });

  it('keeps a run in flight on a revision registered before the activity gained compensate (I1)', async () => {
    const root = await mkdtemp(join(tmpdir(), 'bureau-compensate-restart-'));
    cleanups.push(() => rm(root, { recursive: true, force: true }));
    const database = createSqliteStorageFixture({ path: join(root, 'bureau.sqlite') });
    cleanups.push(() => database.dispose());
    const directory = join(root, 'workflows');
    const over = async (compensate: boolean) => {
      const harness = await startWorkflowBureau({
        directory,
        overrides: {
          get storage() {
            return database.open();
          },
          durableOwnership: { ownership: 'none' },
          onDiagnostic: () => undefined,
          plugins: [contributed(compensate, '1')],
        },
      });
      cleanups.push(() => harness.dispose());
      return harness;
    };
    const first = await over(false);
    await first.put('pipeline.json', file([{ kind: 'await-signal', signal: 'go' }, callY]));
    await first.bureau.workflows?.refresh();
    const firstEngine = first.bureau.durableEngine()!;
    await firstEngine.start('pipeline', null, { id: 'waiting' });
    await waitUntil(() => waitsForGo(firstEngine, 'waiting'), { message: 'the run to wait' });
    await first.dispose();

    // The same version of the activity, now defining compensate: the file is refused, the run is not.
    const second = await over(true);
    expect(listing(second)?.state).toBe('invalid');
    const engine = second.bureau.durableEngine()!;
    await engine.signal('waiting', 'go', null);
    const run = await settled(second, 'waiting');
    expect(run.unresumable).toBeUndefined();
    expect(run.status).toBe('completed');
  });
});
