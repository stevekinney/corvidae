/**
 * COR-2420 — a routing decision is linked to the runs it starts: the supervisor mints an id for
 * the routing step, the decision's `decision.made` record names it, and each run the step starts
 * takes its id from it. Read through a real Bureau's audit trail, so the answered record's own
 * detail is what is checked.
 */
import {
  type AgentRunContext,
  createAgent,
  createMockGenerate,
  type GenerateFunction,
  type RunnableAgent,
} from '@lostgradient/operative';
import { MemoryStorage } from '@lostgradient/storage';
import { afterEach, describe, expect, it } from 'bun:test';

import { createAgentCatalog } from '../agent-catalog.ts';
import type { Bureau } from '../bureau-types/facade.ts';
import { createBureau } from '../create-bureau.ts';
import { createSupervisor } from '../create-supervisor.ts';
import { TaskRoutedEvent } from '../supervisor-contracts.ts';
import { createVendorCatalog } from '../testing/vendor-catalog.test-support.ts';
import { createDecisionRouting } from './decision-routing.ts';

const bureaus: Bureau[] = [];
afterEach(async () => {
  for (const bureau of bureaus.splice(0)) await bureau.dispose();
});

/** A Bureau whose fallback row answers each decision with the next of `replies`, or none when `withoutGenerate`. */
async function open(options: { replies?: readonly string[]; withoutGenerate?: boolean } = {}) {
  const generate = createMockGenerate(
    (options.replies ?? ['{"key":"reviewer"}']).map((content) => ({ content, toolCalls: [] })),
  );
  const bureau = await createBureau({
    storage: new MemoryStorage(),
    durable: true,
    models: {
      catalog: createVendorCatalog().descriptors,
      ...(options.withoutGenerate === true ? {} : { generate: (): GenerateFunction => generate }),
    },
  });
  bureaus.push(bureau);
  return bureau;
}

/** An agent that records the id of every run it starts, and the `runId` its context asked for. */
function spied(name: string) {
  const base = createAgent({
    name,
    generate: createMockGenerate([{ content: `${name} answered`, toolCalls: [] }]),
  });
  const runIds: string[] = [];
  const requestedRunIds: (string | undefined)[] = [];
  const fixture: RunnableAgent = {
    ...base,
    run: (input, context?: AgentRunContext) => {
      requestedRunIds.push(context?.runId);
      const run = base.run(input, context);
      runIds.push(run.id);
      return run;
    },
  };
  return { fixture, runIds, requestedRunIds };
}

async function decisionRecords(bureau: Bureau) {
  return (await bureau.internals.auditTrail?.query({ type: 'decision.made' })) ?? [];
}

/** The `routingId` a stored record's detail names, if any. */
function routingIdOf(record: { readonly detail?: unknown } | undefined): unknown {
  const { detail } = record ?? {};
  return typeof detail === 'object' && detail !== null && 'routingId' in detail
    ? detail.routingId
    : undefined;
}

describe('a routing decision and the runs it starts (COR-2420)', () => {
  it('names the routing step on its record, and the run the step starts takes its id from it', async () => {
    const bureau = await open();
    const writer = spied('writer');
    const reviewer = spied('reviewer');
    const supervisor = createSupervisor({
      agents: createAgentCatalog({ writer: writer.fixture, reviewer: reviewer.fixture }),
      routing: createDecisionRouting(bureau.decisions, { principal: 'api-key:alice' }),
    });
    const routed: TaskRoutedEvent[] = [];
    supervisor.addEventListener('task.routed', (event) => routed.push(event));

    await supervisor.delegate('Check this draft');

    const [record, ...others] = await decisionRecords(bureau);
    expect(others).toEqual([]);
    const { routingId } = record!.detail as { routingId?: string };
    expect(routingId).toStartWith('routing-');
    expect(record).toMatchObject({ principal: 'api-key:alice', detail: { outcome: 'answered' } });
    expect(routed.map((event) => event.routingId)).toEqual([routingId!]);
    expect(reviewer.runIds).toEqual([`${routingId}-0`]);
    expect(reviewer.requestedRunIds).toEqual([`${routingId}-0`]);
    expect(writer.runIds).toEqual([]);

    // The served, redacted view keeps the id, so a client can follow it to the runs.
    const served = await bureau.audit.query({ type: 'decision.made' });
    expect(served.records[0]?.detail).toMatchObject({ routingId });
  });

  it('gives every run a routing step starts its own id, in the order the strategy named the agents', async () => {
    const bureau = await open({ replies: ['{"key":"a"}'] });
    const first = spied('first');
    const second = spied('second');
    const supervisor = createSupervisor({
      agents: createAgentCatalog({ first: first.fixture, second: second.fixture }),
      routing: async (_task, _descriptors, context) => {
        await bureau.decisions.decide(
          {
            kind: 'choice',
            question: 'Who?',
            options: [
              { key: 'a', label: 'A' },
              { key: 'b', label: 'B' },
            ],
          },
          context === undefined ? {} : { routingId: context.routingId },
        );
        return ['second', 'first'];
      },
    });

    await supervisor.delegate('Both');

    const [record] = await decisionRecords(bureau);
    const { routingId } = record!.detail as { routingId: string };
    expect(second.runIds).toEqual([`${routingId}-0`]);
    expect(first.runIds).toEqual([`${routingId}-1`]);
  });

  it('gives two delegations two routing steps, so one decision is never linked to the other task', async () => {
    const bureau = await open({ replies: ['{"key":"reviewer"}', '{"key":"writer"}'] });
    const writer = spied('writer');
    const reviewer = spied('reviewer');
    const supervisor = createSupervisor({
      agents: createAgentCatalog({ writer: writer.fixture, reviewer: reviewer.fixture }),
      routing: createDecisionRouting(bureau.decisions),
    });

    await supervisor.delegate('One');
    await supervisor.delegate('Two');

    const records = await decisionRecords(bureau);
    const ids = records.map((record) => routingIdOf(record));
    expect(new Set(ids).size).toBe(2);
    expect([...reviewer.runIds, ...writer.runIds].toSorted()).toEqual(
      ids.map((id) => `${String(id)}-0`).toSorted(),
    );
  });

  it('writes its record when the routing starts no run', async () => {
    const bureau = await open();
    const writer = spied('writer');
    const reviewer = spied('reviewer');
    const definitions = { writer: writer.fixture, reviewer: reviewer.fixture };
    const catalog = createAgentCatalog(definitions);
    const asking = createDecisionRouting<typeof definitions>(bureau.decisions);
    const delegated = createSupervisor({
      agents: catalog,
      routing: async (task, descriptors, context) => {
        await asking(task, descriptors, context);
        return [];
      },
    });

    const result = await delegated.delegate('Nothing to run');

    expect(result.agentResults).toEqual([]);
    expect(writer.runIds).toEqual([]);
    expect(reviewer.runIds).toEqual([]);
    const [record] = await decisionRecords(bureau);
    expect(record?.detail).toMatchObject({ outcome: 'answered' });
    expect(typeof routingIdOf(record)).toBe('string');
  });

  it('writes its record, naming the step, when the model names no catalog agent', async () => {
    const bureau = await open({ replies: ['{"key":"ghost"}'] });
    const writer = spied('writer');
    const reviewer = spied('reviewer');
    const supervisor = createSupervisor({
      agents: createAgentCatalog({ writer: writer.fixture, reviewer: reviewer.fixture }),
      routing: createDecisionRouting(bureau.decisions),
    });

    // The fallback validates the key against the offered options, so this decision is an error.
    await supervisor.delegate('Anything').then(
      () => undefined,
      () => undefined,
    );

    const [record] = await decisionRecords(bureau);
    expect(record?.detail).toMatchObject({ outcome: 'error' });
    expect(typeof routingIdOf(record)).toBe('string');
    expect(writer.runIds).toEqual([]);
    expect(reviewer.runIds).toEqual([]);
  });

  it('names the step on a refused decision, which also starts no run', async () => {
    const bureau = await open({ withoutGenerate: true });
    const supervisor = createSupervisor({
      agents: createAgentCatalog({
        writer: spied('writer').fixture,
        reviewer: spied('reviewer').fixture,
      }),
      routing: createDecisionRouting(bureau.decisions),
    });

    await supervisor.delegate('Anything').then(
      () => undefined,
      () => undefined,
    );

    const [record] = await decisionRecords(bureau);
    expect(record?.detail).toMatchObject({ outcome: 'refused', reason: 'NOT_CONFIGURED' });
    expect(typeof routingIdOf(record)).toBe('string');
  });

  it('leaves a pipeline stage, which is not routed, with the id it always had', async () => {
    const stage = spied('writer');
    const supervisor = createSupervisor({
      agents: createAgentCatalog({ writer: stage.fixture }),
      routing: () => 'writer',
    });
    const routed: TaskRoutedEvent[] = [];
    supervisor.addEventListener('task.routed', (event) => routed.push(event));

    await supervisor.pipeline('Go', [{ agentName: 'writer' }]);

    expect(stage.requestedRunIds).toEqual([undefined]);
    expect(routed.map((event) => event.routingId)).toEqual([undefined]);
  });
});

describe('records written before the routing id (COR-2420)', () => {
  it('still load, in the stored trail and in the served view, with no routing id', async () => {
    const bureau = await open();
    const trail = bureau.internals.auditTrail!;
    // A record exactly as a Bureau wrote it before this change: no `routingId` anywhere.
    await trail.record({
      runId: 'decision:00000000-0000-4000-8000-000000000000',
      type: 'decision.made',
      principal: 'api-key:alice',
      detail: {
        kind: 'choice',
        provider: 'anthropic',
        model: 'claude-haiku-5-5',
        outcome: 'answered',
        row: 'anthropic/claude-haiku-5-5',
        path: 'fallback',
      },
    });

    const stored = await decisionRecords(bureau);
    expect(stored).toHaveLength(1);
    expect(stored[0]?.detail).toEqual({
      kind: 'choice',
      provider: 'anthropic',
      model: 'claude-haiku-5-5',
      outcome: 'answered',
      row: 'anthropic/claude-haiku-5-5',
      path: 'fallback',
    });
    const served = await bureau.audit.query({ type: 'decision.made' });
    expect(served.records).toHaveLength(1);
    expect(served.records[0]?.detail).toEqual({
      kind: 'choice',
      provider: 'anthropic',
      model: 'claude-haiku-5-5',
    });
  });
});
