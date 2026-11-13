/**
 * COR-2238: a rejected review ends the run as `failed` with the code `review-rejected`. The outcome
 * matrix is the table below; every row is a payload a wait receives crossed with whether the host
 * recognises a rejection. Weft only asks the host's `isRejection`: what a rejection looks like is
 * the host's to say.
 */
import { describe, expect, it } from 'bun:test';

import { MemoryStorage } from '@lostgradient/storage';
import { waitForCondition } from '@lostgradient/testing/fake-timers';
import { throwingRejectionOf } from '@lostgradient/testing/promise-outcome';

import { Engine } from '../core/engine/index.ts';
import { WorkflowDocumentReviewRejectedError } from './document-errors.ts';
import type { DocumentWorkflowHost } from './document.ts';
import { registerWorkflowDocuments } from './register.ts';

const ran: string[] = [];

const rejects = (payload: unknown): boolean =>
  typeof payload === 'object' && payload !== null && Reflect.get(payload, 'rejected') === true;

const activities: DocumentWorkflowHost['activities'] = {
  after: ({ signal }) => {
    ran.push('after');
    return { after: true, signal };
  },
  items: () => ({ items: [1, 2] }),
};

const hostWithHook: DocumentWorkflowHost = {
  activities,
  triggerKinds: { manual: () => undefined },
  isRejection: rejects,
};
const hostWithoutHook: DocumentWorkflowHost = {
  activities,
  triggerKinds: { manual: () => undefined },
};

const document = (name: string, review: readonly Record<string, unknown>[] = []) => ({
  name,
  trigger: { kind: 'manual' },
  steps: [
    { kind: 'await-signal', signal: 'decision' },
    ...review,
    { kind: 'activity', handler: 'after' },
  ],
});

async function waitForParked(engine: Engine, id: string): Promise<void> {
  await waitForCondition(
    async () => {
      const timeline = await engine.getTimeline(id);
      return timeline.some((entry) => entry.operationType === 'wait-signal');
    },
    { label: `${id} parked on its signal` },
  );
}

type Row = {
  readonly name: string;
  readonly host: DocumentWorkflowHost;
  readonly payload: unknown;
  readonly outcome: 'continues' | 'rejected';
};

const rows: readonly Row[] = [
  { name: 'approval payload', host: hostWithHook, payload: { note: 'ok' }, outcome: 'continues' },
  { name: 'null payload', host: hostWithHook, payload: null, outcome: 'continues' },
  { name: 'string payload', host: hostWithHook, payload: 'rejected', outcome: 'continues' },
  {
    name: 'a denial the host does not call a rejection',
    host: hostWithHook,
    payload: { denied: true, reason: 'change it' },
    outcome: 'continues',
  },
  {
    name: 'a flag set to false',
    host: hostWithHook,
    payload: { rejected: false },
    outcome: 'continues',
  },
  {
    name: 'a rejection payload',
    host: hostWithHook,
    payload: { rejected: true, reason: 'no' },
    outcome: 'rejected',
  },
  {
    name: 'a rejection payload on a host with no hook',
    host: hostWithoutHook,
    payload: { rejected: true, reason: 'no' },
    outcome: 'continues',
  },
];

describe('a rejected review (COR-2238)', () => {
  // Matrix row R6 (a crash after the rejection payload was checkpointed but before the run settled)
  // has no test of its own, by construction. `runAwaitSignal` asks `isRejection` of the value the
  // wait returned and throws on the same line, before the generator yields another operation, so no
  // later step is requested on the live run. A replay takes the checkpointed payload as that wait's
  // result and reaches the same line, so it throws before it requests one either; the "recovers a
  // run at a rejected wait" test below is that replay. There is no point between the checkpoint of
  // the payload and the throw at which a crash could leave a later step started.
  for (const [index, row] of rows.entries()) {
    it(`${row.outcome === 'rejected' ? 'fails the run' : 'continues'} for ${row.name}`, async () => {
      ran.length = 0;
      const name = `rejection-row-${String(index)}`;
      await using engine = new Engine({ storage: new MemoryStorage(), backgroundTasks: 'manual' });
      await registerWorkflowDocuments(engine, row.host, { active: [document(name)] });
      const run = await engine.start(name, null, { id: `${name}-run` });
      await run.signal('decision', row.payload);

      if (row.outcome === 'continues') {
        expect(await run.result()).toEqual({ after: true, signal: row.payload });
        expect(ran).toEqual(['after']);
        const finished = await engine.get(run.id);
        expect(finished?.status).toBe('completed');
        return;
      }
      expect(await throwingRejectionOf(run.result())).toThrow('review-rejected');
      expect(ran).toEqual([]);
      const state = await engine.get(run.id);
      expect(state?.status).toBe('failed');
      expect(state?.error).toBe('review-rejected');
      expect(
        state?.errorStack?.startsWith('WorkflowDocumentReviewRejectedError: review-rejected'),
      ).toBe(true);
    });
  }

  it('carries the code and the reason on the error', () => {
    const error = new WorkflowDocumentReviewRejectedError();
    expect(error.code).toBe('review-rejected');
    expect(error.message).toBe('review-rejected');
  });

  it('runs no later step in a nested branch when the rejection arrives there', async () => {
    ran.length = 0;
    await using engine = new Engine({ storage: new MemoryStorage(), backgroundTasks: 'manual' });
    await registerWorkflowDocuments(engine, hostWithHook, {
      active: [
        {
          name: 'rejection-nested',
          trigger: { kind: 'manual' },
          steps: [
            {
              kind: 'branch',
              on: 'missing',
              cases: { x: [{ kind: 'activity', handler: 'after' }] },
              otherwise: [{ kind: 'await-signal', signal: 'decision' }],
            },
            { kind: 'activity', handler: 'after' },
          ],
        },
      ],
    });
    const run = await engine.start('rejection-nested', null, { id: 'rejection-nested-run' });
    await run.signal('decision', { rejected: true });
    expect(await throwingRejectionOf(run.result())).toThrow('review-rejected');
    expect(ran).toEqual([]);
    const finished = await engine.get(run.id);
    expect(finished?.status).toBe('failed');
  });

  it('fails the run for a rejection at the last step, with nothing after it to stop', async () => {
    await using engine = new Engine({ storage: new MemoryStorage(), backgroundTasks: 'manual' });
    await registerWorkflowDocuments(engine, hostWithHook, {
      active: [
        {
          name: 'rejection-last',
          trigger: { kind: 'manual' },
          steps: [{ kind: 'await-signal', signal: 'decision' }],
        },
      ],
    });
    const run = await engine.start('rejection-last', null, { id: 'rejection-last-run' });
    await run.signal('decision', { rejected: true });
    expect(await throwingRejectionOf(run.result())).toThrow('review-rejected');
    const state = await engine.get(run.id);
    expect(state?.status).toBe('failed');
  });

  it('runs no later iteration of a map that waits when an iteration is rejected', async () => {
    ran.length = 0;
    await using engine = new Engine({ storage: new MemoryStorage(), backgroundTasks: 'manual' });
    await registerWorkflowDocuments(engine, hostWithHook, {
      active: [
        {
          name: 'rejection-map',
          trigger: { kind: 'manual' },
          steps: [
            { kind: 'activity', handler: 'items' },
            {
              kind: 'map',
              over: 'items',
              steps: [
                { kind: 'await-signal', signal: 'decision' },
                { kind: 'activity', handler: 'after' },
              ],
            },
          ],
        },
      ],
    });
    const run = await engine.start('rejection-map', null, { id: 'rejection-map-run' });
    await waitForParked(engine, run.id);
    await run.signal('decision', { rejected: true });
    expect(await throwingRejectionOf(run.result())).toThrow('review-rejected');
    expect(ran).toEqual([]);
    const state = await engine.get(run.id);
    expect(state?.status).toBe('failed');
  });

  it('fails the run for a rejection in a parallel branch once its sibling has settled', async () => {
    ran.length = 0;
    await using engine = new Engine({ storage: new MemoryStorage(), backgroundTasks: 'manual' });
    await registerWorkflowDocuments(engine, hostWithHook, {
      active: [
        {
          name: 'rejection-parallel',
          trigger: { kind: 'manual' },
          steps: [
            {
              kind: 'parallel',
              branches: {
                review: [
                  { kind: 'await-signal', signal: 'decision' },
                  { kind: 'activity', handler: 'after' },
                ],
                other: [{ kind: 'await-signal', signal: 'other' }],
              },
            },
            { kind: 'activity', handler: 'after' },
          ],
        },
      ],
    });
    const run = await engine.start('rejection-parallel', null, { id: 'rejection-parallel-run' });
    await waitForCondition(
      async () => {
        const current = await engine.get(run.id);
        return (current?.waitingForSignals ?? []).length === 2;
      },
      { label: 'both branches to wait' },
    );
    await run.signal('decision', { rejected: true });
    await run.signal('other', 'done');
    expect(await throwingRejectionOf(run.result())).toThrow('review-rejected');
    expect(ran).toEqual([]);
    const state = await engine.get(run.id);
    expect(state?.status).toBe('failed');
    expect(
      state?.errorStack?.startsWith('WorkflowDocumentReviewRejectedError: review-rejected'),
    ).toBe(true);
  });

  it('recovers a run at a rejected wait to the same end after a restart', async () => {
    ran.length = 0;
    const storage = new MemoryStorage();
    const name = 'rejection-restart';
    {
      await using original = new Engine({ storage });
      await registerWorkflowDocuments(original, hostWithHook, { active: [document(name)] });
      await original.start(name, null, { id: `${name}-run` });
      await waitForParked(original, `${name}-run`);
    }
    await using restarted = new Engine({ storage });
    await registerWorkflowDocuments(restarted, hostWithHook, { active: [document(name)] });
    // The decision is durable before the run is recovered: the instance consumes it on replay.
    await restarted.signal(`${name}-run`, 'decision', { rejected: true, reason: 'no' });
    const [handle] = await restarted.recoverAll();
    expect(await throwingRejectionOf(handle!.result())).toThrow('review-rejected');
    expect(ran).toEqual([]);
    const state = await restarted.get(`${name}-run`);
    expect(state?.status).toBe('failed');
    expect(state?.error).toBe('review-rejected');
  });

  it('still continues for an approval after a restart', async () => {
    ran.length = 0;
    const storage = new MemoryStorage();
    const name = 'approval-restart';
    {
      await using original = new Engine({ storage });
      await registerWorkflowDocuments(original, hostWithHook, { active: [document(name)] });
      await original.start(name, null, { id: `${name}-run` });
      await waitForParked(original, `${name}-run`);
    }
    await using restarted = new Engine({ storage });
    await registerWorkflowDocuments(restarted, hostWithHook, { active: [document(name)] });
    const [handle] = await restarted.recoverAll();
    await handle!.signal('decision', { note: 'ok' });
    expect(await handle!.result()).toEqual({ after: true, signal: { note: 'ok' } });
    expect(ran).toEqual(['after']);
  });
});
