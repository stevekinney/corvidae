/**
 * COR-2531 — a failed agent run's task keeps why it failed: the step (its index and a label, the
 * failing tool's name or `model`), the error's code and kind, and the tool call that failed. It is
 * written with the settlement, so a process that did not run the task reads it, and so does a
 * Bureau started after a restart. A tool's arguments are never part of it.
 */
import { createAgent, type GenerateFunction, stopWhen } from '@lostgradient/operative';
import { waitUntil } from '@lostgradient/testing/wait-until';
import { createTool, createToolbox } from 'armorer';
import { afterEach, describe, expect, it } from 'bun:test';
import { z } from 'zod';

import type { AgentDefinitions } from './agent-catalog';
import type { Bureau } from './bureau-types/facade';
import { createBureau } from './create-bureau';
import { createSqliteStorageFixture } from './test/storage-fixtures';

const ALICE = 'api-key:alice';
const ARGUMENT_MARKER = 'argument-marker-7f3a91';
const TOOL_ERROR_TEXT = 'the card network refused the charge';

const bureaus: Bureau<AgentDefinitions>[] = [];
afterEach(async () => {
  for (const bureau of bureaus.splice(0).toReversed()) await bureau.dispose();
});

const chargeCard = createTool({
  name: 'charge-card',
  description: 'Charges a card',
  input: z.object({ secret: z.string() }),
  execute: async () => {
    throw new Error(TOOL_ERROR_TEXT);
  },
});

const lookupOrder = createTool({
  name: 'lookup-order',
  description: 'Looks an order up',
  input: z.object({}),
  execute: async () => 'order found',
});

/** Calls the failing tool with a marker in its arguments. */
const callsFailingTool: GenerateFunction = async () => ({
  content: '',
  toolCalls: [{ id: 'call-charge-1', name: 'charge-card', arguments: { secret: ARGUMENT_MARKER } }],
});

const providerFails: GenerateFunction = async () => {
  throw new Error('the provider exploded');
};

function toolFailureAgent() {
  return createAgent({
    name: 'default',
    generate: callsFailingTool,
    stopWhen: stopWhen.noToolCalls(),
    toolbox: createToolbox([chargeCard]),
    // A failing call ends the run, as it does for a toolbox asked to fail fast.
    executeOptions: { errorMode: 'failFast' },
  });
}

function modelFailureAgent() {
  return createAgent({
    name: 'default',
    generate: providerFails,
    stopWhen: stopWhen.noToolCalls(),
  });
}

async function open(
  agent: ReturnType<typeof toolFailureAgent>,
  extra: Partial<Parameters<typeof createBureau>[0]> = {},
): Promise<Bureau<AgentDefinitions>> {
  const bureau = await createBureau<AgentDefinitions>({
    agents: { default: agent },
    onDiagnostic: () => undefined,
    ...extra,
  });
  bureaus.push(bureau);
  return bureau;
}

async function settle(bureau: Bureau, taskId: string): Promise<void> {
  await waitUntil(
    async () => {
      const task = await bureau.tasks.get(taskId);
      return task?.status === 'failed';
    },
    { message: `task ${taskId} failed` },
  );
  await bureau.internals.taskRegistry.flush();
}

describe('a failed tool call, in the task record (COR-2531)', () => {
  for (const [execution, durability] of [
    ['in process', { durable: false }],
    ['durably', { durable: true }],
  ] as const) {
    it(`AC1: stores the step, the error and the tool call (${execution})`, async () => {
      const bureau = await open(toolFailureAgent(), durability);
      const task = await bureau.tasks.start('default', 'go', { principal: ALICE });
      await settle(bureau, task.id);

      const view = await bureau.tasks.get(task.id);
      expect(view?.failure).toEqual({
        step: { index: expect.any(Number), label: 'charge-card' },
        errorCode: expect.stringMatching(/^[A-Z][A-Z0-9_]*$/),
        errorKind: 'tool',
        toolCall: { name: 'charge-card', callId: 'call-charge-1' },
      });
      const record = await bureau.internals.taskRegistry.record(task.id);
      expect(record?.failure).toEqual({
        step: { index: expect.any(Number), label: 'charge-card' },
        errorCode: expect.any(String),
        errorKind: 'tool',
        toolCall: { name: 'charge-card', callId: 'call-charge-1' },
      });
    });

    it(`AC6: keeps no argument in the stored record (${execution})`, async () => {
      const bureau = await open(toolFailureAgent(), durability);
      const task = await bureau.tasks.start('default', 'go', { principal: ALICE });
      await settle(bureau, task.id);

      const record = await bureau.internals.taskRegistry.record(task.id);
      expect(record?.failure?.toolCall?.name).toBe('charge-card');
      expect(JSON.stringify(record)).not.toContain(ARGUMENT_MARKER);
      expect(JSON.stringify(await bureau.tasks.get(task.id))).not.toContain(ARGUMENT_MARKER);
    });
  }

  for (const [order, calls] of [
    [
      'after a call that succeeded',
      [
        { id: 'call-lookup', name: 'lookup-order', arguments: {} },
        { id: 'call-charge-2', name: 'charge-card', arguments: { secret: ARGUMENT_MARKER } },
      ],
    ],
    [
      'before a call that never got to run',
      [
        { id: 'call-charge-3', name: 'charge-card', arguments: { secret: ARGUMENT_MARKER } },
        { id: 'call-lookup', name: 'lookup-order', arguments: {} },
      ],
    ],
  ] as const) {
    it(`names the call that failed in a step of several calls, the failing call coming ${order}`, async () => {
      const agent = createAgent({
        name: 'default',
        generate: async () => ({ content: '', toolCalls: [...calls] }),
        stopWhen: stopWhen.noToolCalls(),
        toolbox: createToolbox([lookupOrder, chargeCard]),
        executeOptions: { errorMode: 'failFast' },
      });
      const bureau = await open(agent);
      const task = await bureau.tasks.start('default', 'go', { principal: ALICE });
      await settle(bureau, task.id);

      const view = await bureau.tasks.get(task.id);
      expect(view?.failure?.toolCall?.name).toBe('charge-card');
      expect(view?.failure?.toolCall?.callId).toBe(
        calls.find((call) => call.name === 'charge-card')?.id,
      );
      expect(view?.failure?.step?.label).toBe('charge-card');
    });
  }

  it('names the model for a failed model step', async () => {
    const bureau = await open(modelFailureAgent());
    const task = await bureau.tasks.start('default', 'go', { principal: ALICE });
    await settle(bureau, task.id);

    const view = await bureau.tasks.get(task.id);
    expect(view?.failure).toEqual({
      step: { index: expect.any(Number), label: 'model' },
      errorCode: expect.stringMatching(/^[A-Z][A-Z0-9_]*$/),
      errorKind: 'generate',
      toolCall: null,
    });
  });
});

describe('a failure read from a process that did not run the task (COR-2531)', () => {
  it('AC2: reads it from a second Bureau on the store, and from one started after a restart', async () => {
    const fixture = createSqliteStorageFixture({});
    try {
      const holder = await open(toolFailureAgent(), { storage: fixture.storage });
      const task = await holder.tasks.start('default', 'go', { principal: ALICE });
      await settle(holder, task.id);
      const held = await holder.tasks.get(task.id);

      const peer = await open(modelFailureAgent(), { storage: fixture.open() });
      const fromPeer = await peer.tasks.get(task.id);
      expect(fromPeer?.failure).toEqual(held?.failure ?? null);
      expect(fromPeer?.failure?.toolCall).toEqual({ name: 'charge-card', callId: 'call-charge-1' });

      for (const bureau of bureaus.splice(0).toReversed()) await bureau.dispose();
      const restarted = await open(modelFailureAgent(), { storage: await fixture.reopen() });
      const afterRestart = await restarted.tasks.get(task.id);
      expect(afterRestart?.status).toBe('failed');
      expect(afterRestart?.failure).toEqual(held?.failure ?? null);
    } finally {
      for (const bureau of bureaus.splice(0).toReversed()) await bureau.dispose();
      await fixture.dispose();
    }
  });
});
