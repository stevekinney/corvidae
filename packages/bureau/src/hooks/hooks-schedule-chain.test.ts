/**
 * COR-1952 — a schedule that a hook-started run creates carries the hook's origin, so its fires are
 * read as runs a hook started and start no `start-workflow` hook. Without that, each fire is a run
 * no hook started, the hook starts a workflow for it, that workflow creates another schedule, and
 * the count grows with every fire (the probe: a `run.settled` hook whose agent creates a
 * `{ kind: 'schedule', spec: '1s' }` workflow on each run).
 *
 * The fires here are started with `triggerSchedule` and `schedules.runNow`, so the counts do not
 * depend on the engine's clock, and the schedules' own interval is long enough never to fire in the
 * test.
 */
import type { BureauDiagnostic } from '../types.ts';
import type { EncryptionKey } from '@lostgradient/cryptography';
import { MemoryStorage, textValueStore } from '@lostgradient/storage';
import { quietFor, waitUntil } from '@lostgradient/testing/wait-until';
import { afterEach, beforeAll, describe, expect, it } from 'bun:test';

import {
  startWorkflowToolsBureau,
  type WorkflowToolsHarness,
} from '../testing/workflow-tools-bureau.test-support.ts';
import { workflowScheduleId } from '../workflow-schedule.ts';
import {
  createReceiver,
  deliveriesOf,
  newEncryptionKey,
  waitForSettledDeliveries,
} from './hooks.test-support.ts';
import { createScheduleHookOrigins } from './schedule-hook-origins.ts';

let key: EncryptionKey;
beforeAll(async () => {
  key = await newEncryptionKey();
});

const harnesses: WorkflowToolsHarness[] = [];
afterEach(async () => {
  for (const harness of harnesses.splice(0).toReversed()) await harness.dispose();
});

/** What the model of the probe's `chain` workflow is told; it answers with a `workflows-create`. */
const MAKE_A_SCHEDULE = 'Make a schedule';
const ON_GO = { kind: 'signal', name: 'go' };
const SOURCE = {
  agent: 'scribe',
  trigger: ON_GO,
  steps: [{ kind: 'activity', handler: 'agent', input: { agent: 'scribe', message: 'Run once' } }],
};
const CHAIN = {
  agent: 'scribe',
  trigger: ON_GO,
  steps: [
    { kind: 'activity', handler: 'agent', input: { agent: 'scribe', message: MAKE_A_SCHEDULE } },
  ],
};
/** The workflow the probe's agent makes: a schedule whose interval never elapses in the test. */
const SCHEDULED = {
  agent: 'scribe',
  trigger: { kind: 'schedule', spec: '1h' },
  steps: [{ kind: 'activity', handler: 'agent', input: { agent: 'scribe', message: 'Tick' } }],
};

type Probe = Awaited<ReturnType<typeof openProbe>>;

/**
 * A Bureau with a `start-workflow` hook on `run.settled`, and the probe's agent: each time the
 * `chain` workflow's step runs, it calls `workflows-create` for a new schedule workflow.
 */
async function openProbe() {
  const receiver = createReceiver();
  const diagnostics: BureauDiagnostic[] = [];
  const harness = await startWorkflowToolsBureau({
    overrides: {
      onDiagnostic: (diagnostic) => diagnostics.push(diagnostic),
      storage: new MemoryStorage(),
      durableOwnership: { ownership: 'none' },
      answerEncryption: { current: key },
      hooks: {},
      webhooks: { targets: [], fetch: receiver.fetch, sleep: () => Promise.resolve() },
    },
  });
  harnesses.push(harness);
  const workflows = harness.bureau.workflows!;
  let created = 0;
  harness.plan('workflows-create', (message) =>
    message.startsWith(MAKE_A_SCHEDULE)
      ? {
          name: `probe-${String((created += 1))}`,
          trigger: SCHEDULED.trigger,
          steps: SCHEDULED.steps,
        }
      : undefined,
  );
  await workflows.create('source', SOURCE);
  await workflows.create('chain', CHAIN);
  const hook = await harness.bureau.hooks!.create({
    action: { type: 'start-workflow', workflowId: 'chain' },
    events: ['run.settled'],
  });
  const engine = harness.bureau.durableEngine()!;
  return {
    harness,
    diagnostics,
    hook,
    workflows,
    engine,
    /** The workflows named `probe-N`, which only the probe's agent makes. */
    probes: () => workflows.list().filter((listing) => listing.id.startsWith('probe-')),
    /** The instances of `type`, oldest first. */
    async instancesOf(type: string) {
      const page = await engine.list({ type, limit: 100 });
      return page.items.toReversed();
    },
    async instanceCount(type: string): Promise<number> {
      const instances = await this.instancesOf(type);
      return instances.length;
    },
    /** Starts `source` as a person: its settling is the first event the hook acts on. */
    async startSource(): Promise<void> {
      await workflows.start('source', { input: {}, owner: 'anonymous:local' });
    },
    /** Waits until `count` deliveries of the hook have been decided, none pending. */
    deliveries: (count: number) => waitForSettledDeliveries(harness.bureau, hook.id, count),
    /** Fires the workflow schedule of `probe-N` (generation 1) and waits for the instance to finish. */
    async fireWorkflowSchedule(identifier: string): Promise<string> {
      const before = await this.instanceCount(identifier);
      await engine.triggerSchedule(workflowScheduleId(identifier, 1));
      await waitUntil(async () => {
        const instances = await this.instancesOf(identifier);
        return instances.length === before + 1 && instances.at(-1)?.status === 'completed';
      });
      const finished = await this.instancesOf(identifier);
      return finished.at(-1)!.id;
    },
  };
}

/** Whether a delivery was skipped by the chain guard, and which hook it names. */
function skippedFor(delivery: Awaited<ReturnType<typeof deliveriesOf>>[number], hookId: string) {
  return (
    delivery.status === 'failed' &&
    (delivery.attempts[0]?.error ?? '').includes(`hook ${hookId} started`)
  );
}

/** The probe up to the point a hook-started run has made its first schedule. */
async function probeWithFirstSchedule(): Promise<Probe> {
  const probe = await openProbe();
  await probe.startSource();
  // Source settles (delivered: starts `chain`); chain's step settles (skipped: a hook's own run).
  await waitUntil(() => probe.probes().length === 1);
  await probe.deliveries(2);
  return probe;
}

describe('the schedule a hook-started run makes', () => {
  it('is a workflow schedule whose fires start no hook, however many times it fires', async () => {
    const probe = await probeWithFirstSchedule();
    expect(await probe.instanceCount('chain')).toBe(1);

    const FIRES = 3;
    for (let fire = 1; fire <= FIRES; fire += 1) {
      await probe.fireWorkflowSchedule('probe-1');
      const deliveries = await probe.deliveries(2 + fire);
      // The fire's run (and its agent step) settled, and the hook declined it by name.
      expect(skippedFor(deliveries.at(-1)!, probe.hook.id)).toBe(true);
    }
    await quietFor(250);

    // The probe, bounded by counts: still the one hook-started `chain`, the one schedule it made,
    // and one decision per run that settled (the source, the chain, each fire), none of them a start.
    expect(await probe.instanceCount('chain')).toBe(1);
    expect(probe.probes().map((listing) => listing.id)).toEqual(['probe-1']);
    const deliveries = await deliveriesOf(probe.harness.bureau, probe.hook.id);
    expect(deliveries.map((delivery) => delivery.status)).toEqual([
      'delivered',
      ...Array.from({ length: 1 + FIRES }, () => 'failed' as const),
    ]);
    // Each skip is reported, and nothing else was.
    expect(probe.diagnostics.map((d) => [d.scope, d.level])).toEqual(
      Array.from({ length: 1 + FIRES }, () => ['hooks', 'warn']),
    );
  });

  it('is not the same as a schedule an owner made: its fires start the hook as before', async () => {
    const probe = await openProbe();
    // An owner's own request writes the file; no run, and no hook, is behind it.
    await probe.workflows.create('owner-probe', SCHEDULED);
    await probe.engine.triggerSchedule(workflowScheduleId('owner-probe', 1));
    await waitUntil(async () => (await probe.instanceCount('chain')) === 1);
    const [started] = await probe.deliveries(1);
    expect(started).toMatchObject({ status: 'delivered' });
    expect(started!.attempts[0]!.receipt!.runId).toBeDefined();
  });

  it('keeps the origin through the file’s later generations and an update by an owner', async () => {
    const probe = await probeWithFirstSchedule();
    const detail = await probe.workflows.get('probe-1');
    // An owner's request edits the file (a new description), which re-puts the schedule under the
    // same generation; the file is still the hook-started run's.
    await probe.workflows.update(
      'probe-1',
      { ...SCHEDULED, description: 'Edited by an owner' },
      { expectedHash: detail!.hash! },
    );
    await probe.fireWorkflowSchedule('probe-1');
    const deliveries = await probe.deliveries(3);
    expect(skippedFor(deliveries.at(-1)!, probe.hook.id)).toBe(true);
  });

  it('clears the origin when a person creates the file again under the identifier', async () => {
    const probe = await probeWithFirstSchedule();
    const detail = await probe.workflows.get('probe-1');
    await probe.workflows.delete('probe-1', { expectedHash: detail!.hash! });
    await probe.workflows.create('probe-1', SCHEDULED);
    // A new file by an owner is an owner's, so its origin was cleared and its fire starts the hook.
    await probe.engine.triggerSchedule(workflowScheduleId('probe-1', 2));
    const deliveries = await probe.deliveries(3);
    expect(deliveries.at(-1)).toMatchObject({ status: 'delivered' });
  });
});

describe('the schedule a hook-started run changes', () => {
  it('takes the hook’s origin from an owner’s workflow it updates, so a fire starts no hook', async () => {
    const probe = await openProbe();
    await probe.workflows.create('owner-probe', SCHEDULED);
    const hash = probe.workflows.list().find((listing) => listing.id === 'owner-probe')!.hash!;
    probe.harness.plan('workflows-update', (message) =>
      message.startsWith(MAKE_A_SCHEDULE)
        ? {
            id: 'owner-probe',
            expectedHash: hash,
            trigger: { kind: 'schedule', spec: '2h' },
            steps: SCHEDULED.steps,
          }
        : undefined,
    );
    await probe.startSource();
    await probe.deliveries(2);
    expect(probe.workflows.list().find((l) => l.id === 'owner-probe')!.hash).not.toBe(hash);

    await probe.fireWorkflowSchedule('owner-probe');
    const deliveries = await probe.deliveries(3);
    expect(skippedFor(deliveries.at(-1)!, probe.hook.id)).toBe(true);
    await quietFor(250);
    expect(await probe.instanceCount('chain')).toBe(1);
  });
});

describe('the schedule a tool makes with the run that is calling it', () => {
  it('starts no hook for its fires when a hook-started run made it, and one when no hook did', async () => {
    const probe = await probeWithFirstSchedule();
    const [chainRun] = await probe.instancesOf('chain');
    const hooked = await probe.harness.bureau.schedules.create(
      { agentName: 'scribe', input: 'tick', spec: '1h' },
      { createdByRun: chainRun!.id },
    );
    const owned = await probe.harness.bureau.schedules.create({
      agentName: 'scribe',
      input: 'tick',
      spec: '1h',
    });

    await probe.harness.bureau.schedules.runNow(hooked!.id);
    const afterHooked = await probe.deliveries(3);
    expect(skippedFor(afterHooked.at(-1)!, probe.hook.id)).toBe(true);
    await quietFor(250);
    expect(await probe.instanceCount('chain')).toBe(1);

    await probe.harness.bureau.schedules.runNow(owned!.id);
    const afterOwned = await probe.deliveries(4);
    expect(afterOwned.at(-1)).toMatchObject({ status: 'delivered' });
    expect(await probe.instanceCount('chain')).toBe(2);
  });

  it('starts no hook for a run the fire’s own run started', async () => {
    const probe = await probeWithFirstSchedule();
    const instanceId = await probe.fireWorkflowSchedule('probe-1');
    // The instance's agent step is a task beneath it; both settled and both were declined, so the
    // chain is read through the step as well as through the instance.
    const deliveries = await probe.deliveries(3);
    expect(deliveries.slice(1).every((delivery) => skippedFor(delivery, probe.hook.id))).toBe(true);
    const state = await probe.engine.get(instanceId);
    expect(state?.input).toMatchObject({ kind: 'schedule' });
  });
});

describe('where a schedule’s hook origin is kept', () => {
  it('survives a restart: a second reader of the same store finds the hook', async () => {
    const storage = new MemoryStorage();
    const kv = textValueStore(storage, { disposeUnderlyingStorage: false });
    await createScheduleHookOrigins(kv).recordWorkflow('digest', 'hook-9');
    await createScheduleHookOrigins(kv).recordSchedule('schedule-3', 'hook-4');

    const reopened = createScheduleHookOrigins(kv);
    // Any generation of a workflow's schedule reads its workflow's origin.
    expect(await reopened.hookOfSchedule(workflowScheduleId('digest', 1))).toBe('hook-9');
    expect(await reopened.hookOfSchedule(workflowScheduleId('digest', 7))).toBe('hook-9');
    expect(await reopened.hookOfSchedule('schedule-3')).toBe('hook-4');
    // And nothing else has one.
    expect(await reopened.hookOfSchedule(workflowScheduleId('other', 1))).toBeUndefined();
    expect(await reopened.hookOfSchedule('schedule-4')).toBeUndefined();

    await reopened.clearWorkflow('digest');
    await reopened.clearSchedule('schedule-3');
    expect(await reopened.hookOfSchedule(workflowScheduleId('digest', 1))).toBeUndefined();
    expect(await reopened.hookOfSchedule('schedule-3')).toBeUndefined();
  });

  it('reads a record it cannot read as no hook, never as one', async () => {
    const kv = textValueStore(new MemoryStorage(), { disposeUnderlyingStorage: false });
    const origins = createScheduleHookOrigins(kv);
    for (const raw of [
      'not json',
      '[]',
      '{"version":2,"hookId":"h"}',
      '{"version":1}',
      '{"version":1,"hookId":""}',
    ]) {
      await kv.set('bureau-hook-schedule-origin:v1:schedule:s', raw);
      expect(await origins.hookOfSchedule('s'), raw).toBeUndefined();
    }
  });
});
