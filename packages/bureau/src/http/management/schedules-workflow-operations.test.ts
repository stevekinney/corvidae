/**
 * COR-2546 — a schedule that runs a workflow instead of an agent, through `bureau.schedules.*` over
 * a real Bureau and its handler: the one-target rule, the authorization `bureau.workflows.start`
 * applies, the input a code workflow and a workflow file each receive, the owner kept in the
 * schedule's metadata (never in the run's input), a change of target in one write, and the
 * owner and scope rules an agent schedule follows.
 */
import { definePlugin, type PluginWorkflow } from '@lostgradient/interborough-plugin';
import { quietFor, waitUntil } from '@lostgradient/testing/wait-until';
import { MemoryStorage } from '@lostgradient/storage';
import { decode, KEYS, workflow } from '@lostgradient/weft';
import { afterEach, describe, expect, it } from 'bun:test';
import { z } from 'zod';

import { AGENT_STEP } from '../../testing/workflow-file-fixtures.test-support.ts';
import { rpc, type RpcBody } from './management-fixtures.test-support.ts';
import {
  serveWorkflows,
  type Served,
  type ServeOptions,
} from './workflows-fixtures.test-support.ts';

const cleanups: Array<() => Promise<void>> = [];
afterEach(async () => {
  for (const cleanup of cleanups.splice(0).toReversed()) await cleanup();
});

/** Who may start workflows, and so schedule them: owner `api-key:workflows-writer`. */
const STARTER = 'workflows-writer-key';
const STARTER_OWNER = 'api-key:workflows-writer';

/** `kit:echo`, which completes with the input it was started with, and `kit:strict`, which wants a team. */
const echo = (): PluginWorkflow => ({
  ...workflow({ name: 'echo' }).execute(async function* (_context, input: unknown) {
    yield* [];
    return input;
  }),
  title: 'Echo',
  inputSchema: z.unknown(),
});
const strict = (): PluginWorkflow => ({
  ...workflow({ name: 'strict' }).execute(async function* (_context, input: unknown) {
    yield* [];
    return input;
  }),
  title: 'Strict',
  inputSchema: z.object({ team: z.string() }),
});

const kit = {
  descriptor: definePlugin({
    name: 'kit',
    version: '1.0.0',
    description: 'Contributes code workflows.',
    setup: () => ({ workflows: [echo(), strict()] }),
  }),
  source: 'package' as const,
  location: '@example/kit',
};

async function serve(options: ServeOptions = {}): Promise<Served> {
  const served = await serveWorkflows(cleanups, { plugins: [kit], ...options });
  // A workflow file, whose own schedule exists beside the ones these tests make.
  await served.bureau.workflows!.create('digest', {
    agent: 'writer',
    trigger: { kind: 'schedule', spec: '1h' },
    steps: [AGENT_STEP],
  });
  return served;
}

const status = (body: RpcBody) => body.error?.data?.httpStatus;

type DurableEngine = NonNullable<ReturnType<Served['bureau']['durableEngine']>>;

/** What Weft holds for schedule `id`: its type, input, metadata and revision, as stored. */
async function readStored(engine: DurableEngine, id: string): Promise<Record<string, unknown>> {
  const bytes = await engine.storage.get(KEYS.schedule(id));
  const state = decode(bytes!) as Record<string, unknown>;
  return {
    workflowType: state['workflowType'],
    input: state['input'],
    metadata: state['metadata'],
    revision: state['revision'],
  };
}

/** Resolves once run `id` has completed. */
async function completes(engine: DurableEngine, id: string): Promise<void> {
  await waitUntil(async () => {
    const run = await engine.get(id);
    return run?.status === 'completed';
  });
}

/** The input run `id` was started with. */
async function inputOf(engine: DurableEngine, id: string): Promise<unknown> {
  const run = await engine.get(id);
  return run?.input;
}

/** The revision schedule `id` is at. */
async function revisionOf(engine: DurableEngine, id: string): Promise<number | undefined> {
  const summary = await engine.getSchedule(id);
  return summary?.revision;
}

/** The metadata schedule `id` reads back with. */
async function metadataOf(engine: DurableEngine, id: string): Promise<unknown> {
  const summary = await engine.getSchedule(id);
  return summary?.metadata;
}

/** How many runs of the `digest` workflow file the engine holds. */
async function runTotal(engine: DurableEngine): Promise<number> {
  const page = await engine.list({ type: 'digest', limit: 100 });
  return page.total;
}

/** How many schedules the Bureau holds. */
async function scheduleTotal(served: Served): Promise<number | undefined> {
  const page = await served.bureau.schedules.list();
  return page?.total;
}

/** The view `key` reads of schedule `id`. */
async function viewOf(served: Served, id: string, key: string): Promise<unknown> {
  const body = await call(served, 'get', { scheduleId: id }, key);
  return body.result;
}

async function create(served: Served, params: object, key = STARTER): Promise<RpcBody> {
  return rpc(served.keyed, 'bureau.schedules.create', { spec: '1h', ...params }, key);
}

async function created(served: Served, params: object, key = STARTER): Promise<string> {
  const body = await create(served, params, key);
  expect(body.error).toBeUndefined();
  return body.result!['id'] as string;
}

const call = (served: Served, method: string, params: object, key = STARTER) =>
  rpc(served.keyed, `bureau.schedules.${method}`, params, key);

describe('creating a schedule for a workflow', () => {
  it('makes one for a code workflow and one for a workflow file, and reads each back with its target', async () => {
    const served = await serve();

    const code = await create(served, { workflowType: 'kit:echo', description: 'a code one' });
    expect(code.result).toMatchObject({
      owner: STARTER_OWNER,
      agentName: null,
      inputPreview: null,
      continuesChat: false,
      // The engine's name for the workflow, and the one `bureau.workflows.*` names it by.
      workflowType: 'kit__echo',
      target: { kind: 'workflow', workflowType: 'kit:echo' },
      description: 'a code one',
      status: 'active',
      revision: 1,
    });
    const file = await create(served, { workflowType: 'digest' });
    expect(file.result).toMatchObject({
      workflowType: 'digest',
      target: { kind: 'workflow', workflowType: 'digest' },
    });

    for (const made of [code, file]) {
      const read = await call(served, 'get', { scheduleId: made.result!['id'] });
      expect(read.result).toEqual(made.result);
    }
  });

  it('is InvalidParams when both targets are named, when neither is, and when a field belongs to the other', async () => {
    const served = await serve();
    const refused = async (params: object) => status(await create(served, params));

    expect(await refused({ agentName: 'writer', workflowType: 'kit:echo', input: 'x' })).toBe(400);
    expect(await refused({})).toBe(400);
    expect(await refused({ input: 'only text' })).toBe(400);
    // An agent needs its text, and takes no workflow input.
    expect(await refused({ agentName: 'writer' })).toBe(400);
    expect(await refused({ agentName: 'writer', input: 'x', workflowInput: { n: 1 } })).toBe(400);
    // A workflow takes no text, session or chat.
    expect(await refused({ workflowType: 'kit:echo', input: 'x' })).toBe(400);
    expect(await refused({ workflowType: 'kit:echo', sessionId: 's' })).toBe(400);
    expect(await refused({ workflowType: 'kit:echo', continueChat: true })).toBe(400);

    const listed = await call(served, 'list', {}, 'operator-key');
    expect(
      (listed.result!['schedules'] as unknown[]).map((entry) => (entry as { id: string }).id),
    ).toEqual(['bureau-workflow-schedule:digest:1']);
  });

  it('is NotFound for a workflow that is not there, one the Bureau runs itself, and one the caller could not start', async () => {
    const served = await serve();
    const before = await scheduleTotal(served);

    for (const workflowType of ['kit:missing', 'missing', 'agentRun', 'kit__echo']) {
      expect([workflowType, status(await create(served, { workflowType }))]).toEqual([
        workflowType,
        404,
      ]);
    }
    // alice holds no workflow scope, so a workflow is as unknown to her as one that is missing.
    expect(status(await create(served, { workflowType: 'kit:echo' }, 'alice-key'))).toBe(404);
    expect(status(await create(served, { workflowType: 'digest' }, 'alice-key'))).toBe(404);

    expect(await scheduleTotal(served)).toBe(before);
  });

  it('refuses a workflowInput the workflow’s schema refuses, and stores nothing', async () => {
    const served = await serve();
    const refused = await create(served, {
      workflowType: 'kit:strict',
      workflowInput: { team: 3 },
    });
    expect(status(refused)).toBe(400);
    expect(JSON.stringify(refused.error?.data)).toContain('workflowInput');

    const accepted = await create(served, {
      workflowType: 'kit:strict',
      workflowInput: { team: 'core' },
    });
    expect(accepted.error).toBeUndefined();
    expect(await scheduleTotal(served)).toBe(2);
  });
});

describe('what a fire starts', () => {
  it('starts a code workflow with workflowInput as its input, and no owner in it', async () => {
    const served = await serve();
    const id = await created(served, { workflowType: 'kit:echo', workflowInput: { n: 1 } });

    const ran = await call(served, 'runnow', { scheduleId: id });
    expect(ran.result).toMatchObject({ outcome: 'started' });
    const runId = ran.result!['taskId'] as string;
    const engine = served.bureau.durableEngine()!;
    await completes(engine, runId);

    const run = await engine.get(runId);
    expect(run?.type).toBe('kit__echo');
    expect(run?.input).toEqual({ n: 1 });
    expect(run?.result).toEqual({ n: 1 });
    expect(Object.hasOwn(run?.input as object, 'principal')).toBe(false);
    // The owner reads back from the schedule's metadata.
    expect(await metadataOf(engine, id)).toEqual({ owner: STARTER_OWNER });
  });

  it('starts a workflow file with the trigger envelope, carrying workflowInput as its input', async () => {
    const served = await serve();
    const id = await created(served, { workflowType: 'digest', workflowInput: { n: 1 } });

    const ran = await call(served, 'runnow', { scheduleId: id });
    expect(ran.result).toMatchObject({ outcome: 'started' });
    const run = await served.bureau.durableEngine()!.get(ran.result!['taskId'] as string);

    expect(run?.type).toBe('digest');
    expect(run?.input).toEqual({ kind: 'schedule', scheduleId: id, input: { n: 1 } });
    expect(Object.hasOwn(run?.input as object, 'principal')).toBe(false);
    expect(await metadataOf(served.bureau.durableEngine()!, id)).toEqual({
      owner: STARTER_OWNER,
    });
  });

  it('answers NotFound and starts nothing once the workflow can no longer be started', async () => {
    const served = await serve();
    const id = await created(served, { workflowType: 'digest', workflowInput: { n: 1 } });
    const engine = served.bureau.durableEngine()!;
    const runsBefore = await runTotal(engine);

    const detail = await served.bureau.workflows!.get('digest');
    await served.bureau.workflows!.delete('digest', { expectedHash: detail!.hash! });

    expect(status(await call(served, 'runnow', { scheduleId: id }))).toBe(404);
    expect(await runTotal(engine)).toBe(runsBefore);
  });
});

/** Fires schedule `id` as its cadence does: the Bureau's maintenance runs at its next occurrence. */
async function fireOnCadence(served: Served, id: string): Promise<void> {
  const view = await served.bureau.schedules.get(id);
  await served.bureau.maintain(view!.nextFireAt!);
}

/** How many runs of the workflow whose engine type is `type` the engine holds. */
async function runsOf(engine: DurableEngine, type: string): Promise<number> {
  const page = await engine.list({ type, limit: 100 });
  return page.total;
}

/** How many runs of `type` schedule `id` fired, by Weft's own record of each fire. */
async function firedBy(engine: DurableEngine, type: string, id: string): Promise<number> {
  const fired = await runsFiredBy(engine, type, id);
  return fired.length;
}

/** The ids of the runs of `type` schedule `id` fired, by Weft's own record of each fire. */
async function runsFiredBy(engine: DurableEngine, type: string, id: string): Promise<string[]> {
  const page = await engine.list({ type, limit: 100 });
  const fired: string[] = [];
  for (const run of page.items) {
    const provenance = await engine.getScheduleProvenance(run.id);
    if (provenance?.scheduleId === id) fired.push(run.id);
  }
  return fired;
}

/** The types of the audit records of schedule `id`'s pauses and resumes, as they were written. */
async function transitionsOf(served: Served, id: string): Promise<string[]> {
  const records = await served.bureau.internals.auditTrail!.query({ runId: `schedule:${id}` });
  return records.map((record) => record.type);
}

/** The status schedule `id` reads back with, as the Bureau reports it. */
async function statusOf(served: Served, id: string): Promise<string | undefined> {
  const view = await served.bureau.schedules.get(id);
  return view?.status;
}

describe('a fire on cadence of a schedule whose workflow can no longer be started', () => {
  it('starts a run when the workflow can be started', async () => {
    const served = await serve({ maintenance: 'manual' });
    const id = await created(served, { workflowType: 'kit:echo', workflowInput: { n: 1 } });
    const engine = served.bureau.durableEngine()!;

    await fireOnCadence(served, id);

    await waitUntil(async () => (await runsOf(engine, 'kit__echo')) === 1);
  });

  it('starts nothing once the workflow file is paused, holds the schedule paused as it does the file’s own, and resumes it with the file', async () => {
    const served = await serve({ maintenance: 'manual' });
    const id = await created(served, { workflowType: 'digest', workflowInput: { n: 1 } });
    const engine = served.bureau.durableEngine()!;
    const runsBefore = await runsOf(engine, 'digest');

    const detail = await served.bureau.workflows!.get('digest');
    await served.bureau.workflows!.pause('digest', { expectedHash: detail!.hash! });

    // What main does for the file's own schedule is what the caller's gets.
    expect(await statusOf(served, 'bureau-workflow-schedule:digest:1')).toBe('paused');
    expect(await statusOf(served, id)).toBe('paused');
    // The hold is recorded in the schedule's audit trail as its owner's own pause would be.
    expect(await transitionsOf(served, id)).toEqual(['schedule.paused']);
    await fireOnCadence(served, id);
    await quietFor(200);
    expect(await runsOf(engine, 'digest')).toBe(runsBefore);
    expect(status(await call(served, 'runnow', { scheduleId: id }))).toBe(404);

    // A resume of the schedule alone does not undo the hold.
    expect(status(await call(served, 'resume', { scheduleId: id }))).toBe(404);
    expect(await statusOf(served, id)).toBe('paused');

    const paused = await served.bureau.workflows!.get('digest');
    await served.bureau.workflows!.resume('digest', { expectedHash: paused!.hash! });
    expect(await statusOf(served, id)).toBe('active');
    expect(await transitionsOf(served, id)).toEqual(['schedule.paused', 'schedule.resumed']);
    await fireOnCadence(served, id);
    await waitUntil(async () => (await firedBy(engine, 'digest', id)) === 1);
  });

  it('resumes a schedule that has fired, though the run it started settles while it is held', async () => {
    const served = await serve({ maintenance: 'manual' });
    // A workflow whose run waits for a signal, so it can settle while its schedule is held.
    await served.bureau.workflows!.create('waiter', {
      agent: 'writer',
      trigger: { kind: 'manual' },
      steps: [{ kind: 'await-signal', signal: 'go' }],
    });
    const id = await created(served, { workflowType: 'waiter' });
    const engine = served.bureau.durableEngine()!;
    await fireOnCadence(served, id);
    await waitUntil(async () => (await firedBy(engine, 'waiter', id)) === 1);
    const [runId] = await runsFiredBy(engine, 'waiter', id);

    const detail = await served.bureau.workflows!.get('waiter');
    await served.bureau.workflows!.pause('waiter', { expectedHash: detail!.hash! });
    expect(await statusOf(served, id)).toBe('paused');
    // The run ends while the schedule is held, and what its end writes to the schedule does not
    // keep the hold from being released.
    await waitUntil(async () => {
      const run = await engine.get(runId!);
      return run?.status === 'suspended' || run?.status === 'running';
    });
    await engine.signal(runId!, 'go', null);
    await waitUntil(async () => {
      const run = await engine.get(runId!);
      return run?.status === 'completed';
    });

    const paused = await served.bureau.workflows!.get('waiter');
    await served.bureau.workflows!.resume('waiter', { expectedHash: paused!.hash! });
    expect(await statusOf(served, id)).toBe('active');
  });

  it('leaves a schedule its owner paused paused when its workflow is held and released', async () => {
    const served = await serve({ maintenance: 'manual' });
    const id = await created(served, { workflowType: 'digest' });
    const pausedByOwner = await call(served, 'pause', { scheduleId: id });
    expect(pausedByOwner.error).toBeUndefined();

    const detail = await served.bureau.workflows!.get('digest');
    await served.bureau.workflows!.pause('digest', { expectedHash: detail!.hash! });
    const paused = await served.bureau.workflows!.get('digest');
    await served.bureau.workflows!.resume('digest', { expectedHash: paused!.hash! });

    expect(await statusOf(served, id)).toBe('paused');
  });

  it('leaves a schedule its owner paused while its workflow was held paused when the workflow is released, and starts nothing', async () => {
    const served = await serve({ maintenance: 'manual' });
    const id = await created(served, { workflowType: 'digest', workflowInput: { n: 1 } });
    const engine = served.bureau.durableEngine()!;

    const detail = await served.bureau.workflows!.get('digest');
    await served.bureau.workflows!.pause('digest', { expectedHash: detail!.hash! });
    expect(await statusOf(served, id)).toBe('paused');
    // The schedule is paused already, so the owner's pause changes nothing in the engine and is
    // answered as done: it is still the owner's pause, and the file's resume does not undo it.
    const ownerPause = await call(served, 'pause', { scheduleId: id });
    expect(ownerPause.error).toBeUndefined();

    const paused = await served.bureau.workflows!.get('digest');
    await served.bureau.workflows!.resume('digest', { expectedHash: paused!.hash! });

    expect(await statusOf(served, id)).toBe('paused');
    await fireOnCadence(served, id);
    await quietFor(200);
    // The file's own schedule fires with the file; only this schedule's runs are the finding.
    expect(await firedBy(engine, 'digest', id)).toBe(0);
    // The owner's own resume still works once the workflow can be started.
    const ownerResume = await call(served, 'resume', { scheduleId: id });
    expect(ownerResume.error).toBeUndefined();
    expect(await statusOf(served, id)).toBe('active');
  });

  it('starts nothing once the workflow file is deleted, and holds the schedule paused', async () => {
    const served = await serve({ maintenance: 'manual' });
    const id = await created(served, { workflowType: 'digest', workflowInput: { n: 1 } });
    const engine = served.bureau.durableEngine()!;
    const runsBefore = await runsOf(engine, 'digest');

    const detail = await served.bureau.workflows!.get('digest');
    await served.bureau.workflows!.delete('digest', { expectedHash: detail!.hash! });

    expect(await statusOf(served, id)).toBe('paused');
    await fireOnCadence(served, id);
    await quietFor(200);
    expect(await runsOf(engine, 'digest')).toBe(runsBefore);
  });

  it('starts nothing once a restart no longer registers the code workflow, and holds the schedule paused', async () => {
    const storage = new MemoryStorage();
    const first = await serve({ maintenance: 'manual', storage });
    const id = await created(first, { workflowType: 'kit:echo', workflowInput: { n: 1 } });
    await first.bureau.dispose();

    // The same storage, and a plugin set without `kit`.
    const second = await serveWorkflows(cleanups, { maintenance: 'manual', storage });
    const engine = second.bureau.durableEngine()!;

    // Held at startup, before any fire reaches Weft's own refusal of an unregistered type.
    expect(await statusOf(second, id)).toBe('paused');
    await fireOnCadence(second, id);
    await quietFor(200);
    expect(await runsOf(engine, 'kit__echo')).toBe(0);
    expect(await statusOf(second, id)).toBe('paused');
    expect(status(await call(second, 'runnow', { scheduleId: id }))).toBe(404);
    await second.bureau.dispose();

    // The plugin is back: the hold is over, and the schedule fires again.
    const third = await serve({ maintenance: 'manual', storage });
    expect(await statusOf(third, id)).toBe('active');
    await fireOnCadence(third, id);
    await waitUntil(async () => (await runsOf(third.bureau.durableEngine()!, 'kit__echo')) === 1);
  });
});

describe('who owns and may change a workflow schedule', () => {
  it('is read only by its owner and by bureau.schedules:read, and changed only by its owner and by bureau.schedules:write', async () => {
    const served = await serve();
    const id = await created(served, { workflowType: 'kit:echo' });

    // alice is not the owner and holds no schedule scope.
    expect(status(await call(served, 'get', { scheduleId: id }, 'alice-key'))).toBe(404);
    const hidden = await call(served, 'list', {}, 'alice-key');
    expect(hidden.result!['schedules']).toEqual([]);
    for (const [method, extra] of [
      ['pause', {}],
      ['update', { spec: '2h' }],
      ['runnow', {}],
    ] as const) {
      const refused = await call(served, method, { scheduleId: id, ...extra }, 'alice-key');
      expect([method, status(refused)]).toEqual([method, 404]);
    }

    const read = await call(served, 'get', { scheduleId: id }, 'schedules-reader-key');
    expect(read.result).toMatchObject({ id, owner: STARTER_OWNER });
    expect(status(await call(served, 'pause', { scheduleId: id }, 'schedules-reader-key'))).toBe(
      404,
    );
    const paused = await call(served, 'pause', { scheduleId: id }, 'schedules-writer-key');
    expect(paused.result).toEqual({ id, status: 'paused', revision: 2 });
    // The owner needs no scope.
    const resumed = await call(served, 'resume', { scheduleId: id });
    expect(resumed.result).toEqual({ id, status: 'active', revision: 3 });
  });

  it('is never read as an agent schedule, whatever shape its workflowInput has', async () => {
    const served = await serve();
    const forged = { agentName: 'writer', input: 'x', principal: 'api-key:victim' };
    const id = await created(served, { workflowType: 'kit:echo', workflowInput: forged });

    const view = await call(served, 'get', { scheduleId: id }, 'schedules-reader-key');
    expect(view.result).toMatchObject({
      owner: STARTER_OWNER,
      agentName: null,
      inputPreview: null,
      continuesChat: false,
      target: { kind: 'workflow', workflowType: 'kit:echo' },
    });
    expect(await served.bureau.schedules.agentName(id)).toBeUndefined();
    // The victim sees nothing of it.
    const victim = await call(served, 'list', {}, 'bob-key');
    expect(victim.result!['schedules']).toEqual([]);

    const ran = await call(served, 'runnow', { scheduleId: id });
    const runId = ran.result!['taskId'] as string;
    expect(await served.bureau.ownerOf({ kind: 'run', id: runId })).not.toBe('api-key:victim');
  });

  it('never takes the owner, origin or schedule of a run from the input the caller wrote, and reads back whatever shape it has', async () => {
    const served = await serve();
    const forgedPerson = { kind: 'person', principal: 'api-key:victim', surface: 'api' };
    const forgedSchedule = { kind: 'schedule', scheduleId: 'elsewhere', fireId: 'forged' };
    const inputs = [
      undefined,
      5,
      ['a'],
      // Not an origin at all: a task origin the output schema would refuse.
      { origin: 'SFO' },
      { origin: null },
      { origin: forgedPerson },
      { origin: forgedSchedule },
      { kind: 'manual', input: { n: 1 }, origin: forgedPerson },
      { kind: 'schedule', scheduleId: 'elsewhere' },
      { kind: 'schedule', scheduleId: 'elsewhere', origin: forgedPerson },
      { agentName: 'writer', input: 'x', scheduleId: 'elsewhere', principal: 'api-key:victim' },
    ];
    const engine = served.bureau.durableEngine()!;
    for (const workflowInput of inputs) {
      const label = JSON.stringify(workflowInput);
      const id = await created(
        served,
        workflowInput === undefined
          ? { workflowType: 'kit:echo' }
          : { workflowType: 'kit:echo', workflowInput },
      );
      const ran = await call(served, 'runnow', { scheduleId: id });
      const runId = ran.result!['taskId'] as string;
      await completes(engine, runId);

      // The run belongs to the owner of the schedule that fired it, never to the owner its input
      // names.
      expect([label, await served.bureau.ownerOf({ kind: 'run', id: runId })]).toEqual([
        label,
        STARTER_OWNER,
      ]);
      const detail = await rpc(
        served.keyed,
        'bureau.workflows.runs.get',
        { runId },
        'workflows-reader-key',
      );
      expect([label, detail.error]).toEqual([label, undefined]);
      // The input's own `origin` is the caller's data, not the origin of the start.
      expect([label, detail.result!['origin']]).toEqual([label, null]);
      const listed = await rpc(
        served.keyed,
        'bureau.workflows.runs.list',
        {},
        'workflows-reader-key',
      );
      expect([label, listed.error]).toEqual([label, undefined]);
      const listedRun = (listed.result!['runs'] as Array<{ id: string; origin: unknown }>).find(
        (entry) => entry.id === runId,
      );
      expect([label, listedRun?.origin]).toEqual([label, null]);
      // The tasks list reads on, lists the run under the schedule's owner and the schedule that
      // fired it, and shows the victim none of it.
      const tasks = await rpc(served.keyed, 'bureau.tasks.list', {}, 'operator-key');
      expect([label, tasks.error]).toEqual([label, undefined]);
      const listedTask = (
        tasks.result!['tasks'] as Array<{
          id: string;
          owner: string;
          origin: unknown;
          workflow: { scheduleId: string | null };
        }>
      ).find((entry) => entry.id === runId);
      expect([label, listedTask?.owner]).toEqual([label, STARTER_OWNER]);
      expect([label, listedTask?.workflow.scheduleId]).toEqual([label, id]);
      expect([label, listedTask?.origin]).toEqual([
        label,
        { kind: 'schedule', scheduleId: id, fireId: runId },
      ]);
      const victimTasks = await rpc(served.keyed, 'bureau.tasks.list', {}, 'bob-key');
      expect(victimTasks.result!['tasks']).toEqual([]);
      await call(served, 'cancel', { scheduleId: id });
    }
  });

  it('is told apart from an agent’s and a workflow file’s own schedule by its target', async () => {
    const served = await serve();
    const workflowId = await created(served, { workflowType: 'kit:echo' });
    const agentId = await created(served, { agentName: 'writer', input: 'hello' }, 'operator-key');

    const listed = await call(served, 'list', {}, 'operator-key');
    const targets = Object.fromEntries(
      (
        listed.result!['schedules'] as Array<{ id: string; target: unknown; workflowType: string }>
      ).map((entry) => [entry.id, entry]),
    );
    expect(targets[workflowId]).toMatchObject({
      workflowType: 'kit__echo',
      target: { kind: 'workflow', workflowType: 'kit:echo' },
    });
    expect(targets[agentId]).toMatchObject({
      workflowType: 'agentRun',
      target: { kind: 'agent', agentName: 'writer' },
    });
    expect(targets['bureau-workflow-schedule:digest:1']).toMatchObject({
      workflowType: 'digest',
      target: { kind: 'workflow', workflowType: 'digest' },
    });
  });
});

describe('changing what a schedule runs', () => {
  it('switches between an agent and a workflow and back, each in one write fenced by expectedRevision', async () => {
    const served = await serve();
    const id = await created(served, { agentName: 'writer', input: 'hello' }, 'operator-key');
    const engine = served.bureau.durableEngine()!;
    const update = (params: object, key = 'operator-key') =>
      call(served, 'update', { scheduleId: id, spec: '2h', ...params }, key);

    // To a workflow, with its input.
    const toWorkflow = await update({
      workflowType: 'kit:echo',
      workflowInput: { n: 1 },
      expectedRevision: 1,
    });
    expect(toWorkflow.result).toEqual({ id, status: 'active', revision: 2 });
    let stored = await engine.getSchedule(id);
    expect(stored).toMatchObject({
      workflowType: 'kit__echo',
      intervalMs: 7_200_000,
      metadata: { owner: 'api-key:operator' },
    });
    expect(await viewOf(served, id, 'operator-key')).toMatchObject({
      agentName: null,
      inputPreview: null,
      target: { kind: 'workflow', workflowType: 'kit:echo' },
    });
    const ran = await call(served, 'runnow', { scheduleId: id }, 'operator-key');
    const ranId = ran.result!['taskId'] as string;
    expect(await inputOf(engine, ranId)).toEqual({ n: 1 });
    // The next run starts only once this one is over: the schedule skips an overlapping fire.
    await completes(engine, ranId);

    // A stale switch of target and input is refused, and the type, the input and the metadata stay.
    const before = await readStored(engine, id);
    const stale = await update({
      workflowType: 'digest',
      workflowInput: { n: 2 },
      expectedRevision: 1,
    });
    expect(stale.error?.code).toBeDefined();
    expect(status(stale)).toBe(409);
    expect(await readStored(engine, id)).toEqual(before);
    expect(before).toMatchObject({
      workflowType: 'kit__echo',
      input: { n: 1 },
      metadata: { owner: 'api-key:operator' },
      revision: 2,
    });

    // Only its input, with the revision it was read at.
    const reinput = await update({ workflowInput: { n: 3 }, expectedRevision: 2 });
    expect(reinput.result).toEqual({ id, status: 'active', revision: 3 });
    const again = await call(served, 'runnow', { scheduleId: id }, 'operator-key');
    const againId = again.result!['taskId'] as string;
    expect(await inputOf(engine, againId)).toEqual({ n: 3 });
    await completes(engine, againId);

    // To a workflow file: the envelope is made, and a different workflow starts with null.
    const toFile = await update({ workflowType: 'digest', expectedRevision: 3 });
    expect(toFile.result).toEqual({ id, status: 'active', revision: 4 });
    stored = await engine.getSchedule(id);
    expect(stored?.workflowType).toBe('digest');
    const fileRun = await call(served, 'runnow', { scheduleId: id }, 'operator-key');
    const fileRunId = fileRun.result!['taskId'] as string;
    expect(await inputOf(engine, fileRunId)).toEqual({
      kind: 'schedule',
      scheduleId: id,
      input: null,
    });
    await completes(engine, fileRunId);

    // Back to an agent, which needs its text.
    expect(status(await update({ agentName: 'writer' }))).toBe(400);
    const toAgent = await update({ agentName: 'writer', input: 'back again', expectedRevision: 4 });
    expect(toAgent.result).toEqual({ id, status: 'active', revision: 5 });
    stored = await engine.getSchedule(id);
    expect(stored).toMatchObject({ workflowType: 'agentRun', metadata: {} });
    expect(await viewOf(served, id, 'operator-key')).toMatchObject({
      owner: 'api-key:operator',
      agentName: 'writer',
      inputPreview: 'back again',
      target: { kind: 'agent', agentName: 'writer' },
      workflowType: 'agentRun',
    });
    // The rebuilt input is complete: a fire runs as the agent, for the schedule's owner.
    const agentRun = await call(served, 'runnow', { scheduleId: id }, 'operator-key');
    const agentRunId = agentRun.result!['taskId'] as string;
    expect(await inputOf(engine, agentRunId)).toMatchObject({
      agentName: 'writer',
      input: 'back again',
      scheduleId: id,
      principal: 'api-key:operator',
    });
    await completes(engine, agentRunId);
    expect(await served.bureau.ownerOf({ kind: 'run', id: agentRunId })).toBe('api-key:operator');
  });

  it('refuses a mixed target, a workflow it may not start, and a field of the other kind, and writes nothing', async () => {
    const served = await serve();
    const agentId = await created(served, { agentName: 'writer', input: 'hello' }, 'operator-key');
    const workflowId = await created(served, { workflowType: 'kit:echo' });
    const engine = served.bureau.durableEngine()!;
    const update = (id: string, params: object, key: string) =>
      call(served, 'update', { scheduleId: id, spec: '2h', ...params }, key);

    expect(
      status(
        await update(agentId, { agentName: 'writer', workflowType: 'kit:echo' }, 'operator-key'),
      ),
    ).toBe(400);
    expect(
      status(await update(agentId, { workflowType: 'kit:echo', input: 'x' }, 'operator-key')),
    ).toBe(400);
    expect(status(await update(agentId, { workflowType: 'kit:missing' }, 'operator-key'))).toBe(
      404,
    );
    expect(status(await update(agentId, { workflowType: 'agentRun' }, 'operator-key'))).toBe(404);
    // A workflow input on an agent schedule that names no workflow.
    expect(status(await update(agentId, { workflowInput: { n: 1 } }, 'operator-key'))).toBe(400);
    // Text for a schedule that runs a workflow, without naming an agent.
    expect(status(await update(workflowId, { input: 'text' }, STARTER))).toBe(400);
    // A schedule scope without the workflow scope may not move a schedule onto a workflow.
    expect(
      status(await update(agentId, { workflowType: 'kit:echo' }, 'schedules-writer-key')),
    ).toBe(404);
    expect(
      status(await update(workflowId, { workflowInput: { n: 1 } }, 'schedules-writer-key')),
    ).toBe(404);
    // The schema judges the input of an update as it judges a creation's.
    const strictId = await created(served, {
      workflowType: 'kit:strict',
      workflowInput: { team: 'a' },
    });
    expect(status(await update(strictId, { workflowInput: { team: 1 } }, STARTER))).toBe(400);

    expect(await revisionOf(engine, agentId)).toBe(1);
    expect(await revisionOf(engine, workflowId)).toBe(1);
    expect(await revisionOf(engine, strictId)).toBe(1);
  });
});

describe('in a workspace Bureau', () => {
  it('refuses to schedule a workflow rather than store one without its owner’s authority', async () => {
    const served = await serveWorkflows(cleanups, {
      plugins: [kit],
      workspace: {
        workspaceId: 'workspace-a',
        resolveMembership: async ({ subject }) => ({
          version: 1,
          workspaceId: 'workspace-a',
          actorId: subject ?? 'unknown',
          actorKind: 'user',
          owner: `api-key:${subject ?? 'unknown'}`,
          membershipRevision: 'revision-1',
          capabilities: ['workspace:use', 'workspace:manage'],
        }),
        resolveOwnerMembership: async (owner) => ({
          version: 1,
          workspaceId: 'workspace-a',
          actorId: owner,
          actorKind: 'user',
          owner,
          membershipRevision: 'revision-1',
          capabilities: ['workspace:use', 'workspace:manage'],
        }),
      },
    });

    const refused = await create(served, { workflowType: 'kit:echo' });

    expect(refused.error?.data).toMatchObject({
      reason: 'workflow-schedules-unavailable-in-workspace',
    });
    expect(await scheduleTotal(served)).toBe(0);
  });
});
