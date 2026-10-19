/**
 * COR-1528 — `bureau.workflows.signal` over a real Bureau: a signal first reaches the running
 * instances waiting for it and then starts the workflows whose trigger names it, an instance a
 * call starts is never satisfied by that same call, a paused or deleted workflow still finishes
 * what it began and starts nothing, and `signalId` makes a retried delivery apply once.
 */
import { afterEach, describe, expect, it } from 'bun:test';

import { BureauError } from './create-bureau';

import {
  startWorkflowBureau,
  type WorkflowBureauHarness,
} from './testing/workflow-bureau.test-support';
import { AGENT_STEP } from './testing/workflow-file-fixtures.test-support';
import type { BureauWorkflows, WorkflowRunDetail } from './workflow-runtime';

const harnesses: WorkflowBureauHarness[] = [];
afterEach(async () => {
  for (const harness of harnesses.splice(0).toReversed()) await harness.dispose();
});

async function start() {
  const harness = await startWorkflowBureau({});
  harnesses.push(harness);
  return harness;
}

const onSignal = (name: string) => ({ kind: 'signal', name });
const awaiting = (signal: string) => ({ kind: 'await-signal', signal });

/** Wait until `id` is parked on `name`: its durable record lists the wait. */
async function parked(harness: WorkflowBureauHarness, id: string, name: string): Promise<void> {
  const engine = harness.bureau.durableEngine()!;
  for (let attempt = 0; attempt < 1000; attempt += 1) {
    const state = await engine.get(id);
    if (state?.waitingForSignals?.includes(name) === true) return;
    await Bun.sleep(5);
  }
  throw new Error(`${id} never waited for ${name}`);
}

async function statusOf(harness: WorkflowBureauHarness, id: string): Promise<string | undefined> {
  const state = await harness.bureau.durableEngine()!.get(id);
  return state?.status;
}

async function runField<K extends keyof WorkflowRunDetail>(
  workflows: BureauWorkflows,
  id: string,
  key: K,
): Promise<WorkflowRunDetail[K] | undefined> {
  const run = await workflows.getRun(id);
  return run?.[key];
}

async function settle(harness: WorkflowBureauHarness, id: string): Promise<void> {
  const handle = await harness.bureau.durableEngine()!.getHandle(id);
  await handle.result();
}

describe('starting workflows with a signal', () => {
  it('starts every workflow whose signal trigger has that name, and returns the instances', async () => {
    const harness = await start();
    await harness.putWorkflow('first', { trigger: onSignal('go') });
    await harness.putWorkflow('second', { trigger: onSignal('go') });
    await harness.putWorkflow('elsewhere', { trigger: onSignal('stop') });
    await harness.putWorkflow('timed', { trigger: { kind: 'schedule', spec: '1h' } });

    const result = await harness.bureau.workflows!.signal('go', { n: 1 });

    expect(result.delivered).toEqual([]);
    expect(result.started).toHaveLength(2);
    for (const id of result.started) await settle(harness, id);
    const types = await Promise.all(
      result.started.map(async (id) => await runField(harness.bureau.workflows!, id, 'workflow')),
    );
    expect(types.toSorted((a, b) => String(a).localeCompare(String(b)))).toEqual([
      'first',
      'second',
    ]);
    // No instance of the workflows the name does not match.
    const runs = await harness.bureau.workflows!.listRuns({ limit: 50, offset: 0 });
    expect(runs.runs.map((run) => run.workflow).toSorted()).toEqual(['first', 'second']);
  });

  it('hands the agent step the signal as its trigger, in exactly this text', async () => {
    const harness = await start();
    await harness.putWorkflow('first', {
      trigger: onSignal('go'),
      steps: [{ ...AGENT_STEP, input: { agent: 'writer', message: 'Handle it' } }],
    });

    const { started } = await harness.bureau.workflows!.signal('go', { order: 7 });
    await settle(harness, started[0]!);

    expect(harness.calls.map((call) => call.message)).toEqual([
      [
        'Handle it',
        '',
        'Trigger:',
        '```json',
        '{',
        '  "kind": "signal",',
        '  "name": "go",',
        '  "payload": {',
        '    "order": 7',
        '  }',
        '}',
        '```',
      ].join('\n'),
    ]);
    const detail = await harness.bureau.workflows!.getRun(started[0]!);
    expect(detail?.trigger).toEqual({ kind: 'signal', name: 'go', payload: { order: 7 } });
  });

  it('carries a null payload when the call has none', async () => {
    const harness = await start();
    await harness.putWorkflow('first', { trigger: onSignal('go') });
    const { started } = await harness.bureau.workflows!.signal('go', undefined);
    await settle(harness, started[0]!);
    expect(await runField(harness.bureau.workflows!, started[0]!, 'trigger')).toEqual({
      kind: 'signal',
      name: 'go',
      payload: null,
    });
  });

  it('starts nothing for a paused, an invalid, and a deleted workflow, and does not fail', async () => {
    const harness = await start();
    await harness.putWorkflow('active', { trigger: onSignal('go') });
    await harness.putWorkflow('paused', { trigger: onSignal('go'), paused: true });
    await harness.putWorkflow('doomed', { trigger: onSignal('go') });
    await harness.put('broken.json', '{ "name": "broken", "trigger": { "kind": "signal" } }');
    await harness.bureau.workflows!.refresh();
    const doomed = harness.bureau.workflows!.list().find((entry) => entry.id === 'doomed');
    await harness.bureau.workflows!.delete('doomed', { expectedHash: doomed!.hash! });

    const result = await harness.bureau.workflows!.signal('go', null);

    expect(result.started).toHaveLength(1);
    expect(await runField(harness.bureau.workflows!, result.started[0]!, 'workflow')).toBe(
      'active',
    );
    expect(harness.bureau.workflows!.list().find((entry) => entry.id === 'broken')?.state).toBe(
      'invalid',
    );
  });

  it('starts one instance per call, with no deduplication, and a signalId does not change that', async () => {
    const harness = await start();
    await harness.putWorkflow('first', { trigger: onSignal('go') });
    const one = await harness.bureau.workflows!.signal('go', null, { signalId: 'same' });
    const two = await harness.bureau.workflows!.signal('go', null, { signalId: 'same' });
    expect(one.started).toHaveLength(1);
    expect(two.started).toHaveLength(1);
    expect(two.started[0]).not.toBe(one.started[0]);
  });
});

describe('delivering a signal to a waiting instance', () => {
  it('delivers the payload to a running instance waiting at that await-signal step, which continues with it', async () => {
    const harness = await start();
    await harness.putWorkflow('waiter', {
      trigger: onSignal('begin'),
      steps: [awaiting('approve'), { ...AGENT_STEP, input: { agent: 'writer', message: 'Go on' } }],
    });
    const engine = harness.bureau.durableEngine()!;
    await engine.start('waiter', null, { id: 'waiting-run' });
    await parked(harness, 'waiting-run', 'approve');

    const result = await harness.bureau.workflows!.signal('approve', { ok: true });

    expect(result).toEqual({ started: [], delivered: ['waiting-run'] });
    await settle(harness, 'waiting-run');
    expect(harness.calls[0]?.message).toContain('"ok": true');
    expect(await runField(harness.bureau.workflows!, 'waiting-run', 'status')).toBe('completed');
  });

  it('does not deliver to an instance waiting for another name, or to one that is not waiting', async () => {
    const harness = await start();
    await harness.putWorkflow('waiter', {
      trigger: onSignal('begin'),
      steps: [awaiting('approve')],
    });
    const engine = harness.bureau.durableEngine()!;
    await engine.start('waiter', null, { id: 'waiting-run' });
    await parked(harness, 'waiting-run', 'approve');

    expect(await harness.bureau.workflows!.signal('reject', null)).toEqual({
      started: [],
      delivered: [],
    });
    expect(await statusOf(harness, 'waiting-run')).toBe('running');
  });

  it('delivers before it starts, and the instance it starts stays waiting for the next signal', async () => {
    const harness = await start();
    // The one workflow is started by `go` and its first step awaits `go` itself.
    await harness.putWorkflow('echo', { trigger: onSignal('go'), steps: [awaiting('go')] });
    const engine = harness.bureau.durableEngine()!;
    await engine.start('echo', null, { id: 'old-run' });
    await parked(harness, 'old-run', 'go');

    const result = await harness.bureau.workflows!.signal('go', 'first');

    expect(result.delivered).toEqual(['old-run']);
    expect(result.started).toHaveLength(1);
    const fresh = result.started[0]!;
    await settle(harness, 'old-run');
    expect(await runField(harness.bureau.workflows!, 'old-run', 'result')).toBe('first');
    // The new instance was started after the delivery, so it is still parked on the same name.
    await parked(harness, fresh, 'go');
    expect(await statusOf(harness, fresh)).toBe('running');

    // A second call is what satisfies it, and starts yet another.
    const next = await harness.bureau.workflows!.signal('go', 'second');
    expect(next.delivered).toEqual([fresh]);
    await settle(harness, fresh);
    expect(await runField(harness.bureau.workflows!, fresh, 'result')).toBe('second');
  });

  it('still delivers to the running instances of a paused workflow and of a deleted one', async () => {
    const harness = await start();
    await harness.putWorkflow('slow', { trigger: onSignal('begin'), steps: [awaiting('wake')] });
    await harness.putWorkflow('gone', { trigger: onSignal('begin'), steps: [awaiting('wake')] });
    const engine = harness.bureau.durableEngine()!;
    await engine.start('slow', null, { id: 'slow-run' });
    await engine.start('gone', null, { id: 'gone-run' });
    await parked(harness, 'slow-run', 'wake');
    await parked(harness, 'gone-run', 'wake');
    const workflows = harness.bureau.workflows!;
    const hashOf = (id: string) => workflows.list().find((entry) => entry.id === id)!.hash!;
    await workflows.pause('slow', { expectedHash: hashOf('slow') });
    await workflows.delete('gone', { expectedHash: hashOf('gone') });

    const result = await workflows.signal('wake', 'now');

    expect(result.started).toEqual([]);
    expect(result.delivered.toSorted()).toEqual(['gone-run', 'slow-run']);
    await settle(harness, 'slow-run');
    await settle(harness, 'gone-run');
  });

  /** Wait until `id` has begun `count` waits, so a delivery that moved it on is over. */
  async function waitsBegun(
    harness: WorkflowBureauHarness,
    id: string,
    count: number,
  ): Promise<void> {
    const engine = harness.bureau.durableEngine()!;
    for (let attempt = 0; attempt < 1000; attempt += 1) {
      const timeline = await engine.getTimeline(id);
      if (timeline.filter((entry) => entry.operationType === 'wait-signal').length >= count) return;
      await Bun.sleep(5);
    }
    throw new Error(`${id} never began ${String(count)} waits`);
  }

  async function startTwice(harness: WorkflowBureauHarness, id: string): Promise<void> {
    await harness.putWorkflow('twice', {
      trigger: onSignal('begin'),
      steps: [awaiting('again'), awaiting('again')],
    });
    await harness.bureau.durableEngine()!.start('twice', null, { id });
    await waitsBegun(harness, id, 1);
  }

  it('applies a delivery retried with the same signalId once', async () => {
    const harness = await start();
    await startTwice(harness, 'twice-run');
    const workflows = harness.bureau.workflows!;

    await workflows.signal('again', 'one', { signalId: 'retry-me' });
    await waitsBegun(harness, 'twice-run', 2);
    // The retry finds the instance waiting again and carries the same id, so Weft drops it.
    const retried = await workflows.signal('again', 'one', { signalId: 'retry-me' });
    expect(retried.delivered).toEqual(['twice-run']);
    await Bun.sleep(100);
    expect(await statusOf(harness, 'twice-run')).toBe('running');

    // A different id is a new delivery, and it satisfies the second wait.
    await workflows.signal('again', 'two', { signalId: 'next' });
    await settle(harness, 'twice-run');
    expect(await runField(workflows, 'twice-run', 'result')).toBe('two');
  });

  it('applies every delivery when there is no signalId', async () => {
    const harness = await start();
    await startTwice(harness, 'twice-run');
    const workflows = harness.bureau.workflows!;

    await workflows.signal('again', 'one');
    await waitsBegun(harness, 'twice-run', 2);
    await workflows.signal('again', 'one');
    await settle(harness, 'twice-run');
    expect(await runField(workflows, 'twice-run', 'status')).toBe('completed');
  });
});

type StartableEngine = { start: (...args: unknown[]) => Promise<{ id: string }> };

describe('delivery before start, with a start that returns only once its instance is waiting', () => {
  it('does not deliver to an instance this call starts, even when it is already waiting before the delivery could run', async () => {
    const harness = await start();
    await harness.putWorkflow('echo', { trigger: onSignal('go'), steps: [awaiting('go')] });
    const engine = harness.bureau.durableEngine()!;
    const original = (engine as unknown as StartableEngine).start.bind(engine);
    // `start` returns only once the instance is parked, so a delivery that ran after it would find
    // the new instance waiting and satisfy it with the payload it was started with.
    (engine as unknown as StartableEngine).start = async (...args) => {
      const handle = await original(...args);
      await parked(harness, handle.id, 'go');
      return handle;
    };

    const result = await harness.bureau.workflows!.signal('go', 'first');

    expect(result.started).toHaveLength(1);
    expect(result.delivered).toEqual([]);
    const state = await engine.get(result.started[0]!);
    expect(state?.waitingForSignals).toEqual(['go']);
  });
});

describe('a signal whose delivery cannot be made', () => {
  async function waiting(harness: WorkflowBureauHarness, ids: readonly string[]) {
    await harness.putWorkflow('waiter', { trigger: onSignal('begin'), steps: [awaiting('go')] });
    await harness.putWorkflow('starter', { trigger: onSignal('go') });
    const engine = harness.bureau.durableEngine()!;
    for (const id of ids) await engine.start('waiter', null, { id });
    for (const id of ids) await parked(harness, id, 'go');
    return engine;
  }

  async function startedStarters(harness: WorkflowBureauHarness): Promise<number> {
    const runs = await harness.bureau.workflows!.listRuns({
      workflow: 'starter',
      limit: 50,
      offset: 0,
    });
    return runs.runs.length;
  }

  it('refuses a signalId over 128 bytes, in bytes, before it delivers or starts anything', async () => {
    const harness = await start();
    await waiting(harness, ['waiting-run']);
    for (const signalId of ['a'.repeat(129), '😀'.repeat(50)]) {
      const error = await harness.bureau.workflows!.signal('go', null, { signalId }).then(
        () => undefined,
        (failure: unknown) => failure,
      );
      expect(error, signalId).toBeInstanceOf(BureauError);
      expect((error as BureauError).code).toBe('BAD_REQUEST');
    }
    expect(await startedStarters(harness)).toBe(0);
    expect(await statusOf(harness, 'waiting-run')).toBe('running');
    // 128 bytes is allowed.
    const ok = await harness.bureau.workflows!.signal('go', null, { signalId: 'a'.repeat(128) });
    expect(ok.delivered).toEqual(['waiting-run']);
  });

  it('does not list an instance that was cancelled between the read and the delivery as delivered', async () => {
    const harness = await start();
    const engine = await waiting(harness, ['waiting-run']);
    const originalGet = engine.get.bind(engine);
    let armed = true;
    (engine as unknown as { get: unknown }).get = async (id: string) => {
      const state = await originalGet(id);
      if (armed && id === 'waiting-run') {
        armed = false;
        await engine.cancel('waiting-run');
      }
      return state;
    };

    const result = await harness.bureau.workflows!.signal('go', 'payload');

    expect(result.delivered).toEqual([]);
    expect(result.started).toHaveLength(1);
    expect(await statusOf(harness, 'waiting-run')).toBe('cancelled');
  });

  it('stops with a fault that carries what was already delivered, and starts nothing, on any other engine error', async () => {
    const harness = await start();
    const engine = await waiting(harness, ['run-a', 'run-b']);
    const original = engine.signal.bind(engine) as (...args: unknown[]) => Promise<void>;
    let calls = 0;
    (engine as unknown as { signal: unknown }).signal = async (...args: unknown[]) => {
      calls += 1;
      if (calls === 2) throw new Error('storage unavailable');
      return original(...args);
    };

    const error = await harness.bureau.workflows!.signal('go', null).then(
      () => undefined,
      (failure: unknown) => failure,
    );

    expect((error as Error).message).toContain('storage unavailable');
    const delivered = (error as { delivered?: readonly string[] }).delivered;
    expect(delivered).toHaveLength(1);
    expect(['run-a', 'run-b']).toContain(delivered![0]!);
    expect(await startedStarters(harness)).toBe(0);
  });

  it('answers with delivered when the engine has not followed an earlier file change, and starts nothing', async () => {
    const harness = await start();
    const engine = await waiting(harness, ['waiting-run']);
    await harness.putWorkflow('digest', { trigger: { kind: 'schedule', spec: '1h' } });
    (engine as unknown as { pauseSchedule: unknown }).pauseSchedule = async () => {
      throw new Error('storage unavailable');
    };
    const hash = harness.bureau.workflows!.list().find((entry) => entry.id === 'digest')!.hash!;
    await harness.bureau.workflows!.pause('digest', { expectedHash: hash }).catch(() => undefined);

    const error = await harness.bureau.workflows!.signal('go', null).then(
      () => undefined,
      (failure: unknown) => failure,
    );

    expect((error as { code?: string }).code).toBe('workflow-apply-failed');
    expect((error as { delivered?: readonly string[] }).delivered).toEqual(['waiting-run']);
    expect(await startedStarters(harness)).toBe(0);
  });

  it('refuses a payload over the engine’s payload limit before it delivers or starts anything', async () => {
    const harness = await startWorkflowBureau({
      overrides: { durableGuardrails: { payloadSize: { maxBytes: 256 } } },
    });
    harnesses.push(harness);
    await waiting(harness, ['waiting-run']);

    const error = await harness.bureau.workflows!.signal('go', 'x'.repeat(1024)).then(
      () => undefined,
      (failure: unknown) => failure,
    );

    expect(error).toBeInstanceOf(BureauError);
    expect((error as BureauError).code).toBe('BAD_REQUEST');
    expect(await startedStarters(harness)).toBe(0);
    expect(await statusOf(harness, 'waiting-run')).toBe('running');
    const ok = await harness.bureau.workflows!.signal('go', 'small');
    expect(ok.delivered).toEqual(['waiting-run']);
  });
});
